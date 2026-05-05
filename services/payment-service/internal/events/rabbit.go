package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/food-delivery/payment-service/internal/observability"
	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("payment-service/events")

const (
	Exchange      = "food_delivery"
	RetryExchange = "food_delivery.retry"
	DLX           = "food_delivery.dlx"
	MaxRetries    = 3
	RetryTTLMs    = 30_000
	Prefetch      = 10
)

type Envelope struct {
	EventID      string          `json:"event_id"`
	EventType    string          `json:"event_type"`
	EventVersion string          `json:"event_version"`
	OccurredAt   string          `json:"occurred_at"`
	Producer     string          `json:"producer"`
	Data         json.RawMessage `json:"data"`
}

type Rabbit struct {
	conn       *amqp.Connection
	ch         *amqp.Channel
	producer   string
	queueBase  string // e.g. "payment"
	mainQueue  string
	retryQueue string
	dlqQueue   string
}

func New(url, producer, queueBase string) (*Rabbit, error) {
	conn, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	ch, err := conn.Channel()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("channel: %w", err)
	}
	if err := ch.Qos(Prefetch, 0, false); err != nil {
		conn.Close()
		return nil, fmt.Errorf("qos: %w", err)
	}

	r := &Rabbit{
		conn:       conn,
		ch:         ch,
		producer:   producer,
		queueBase:  queueBase,
		mainQueue:  queueBase + ".events",
		retryQueue: queueBase + ".events.retry",
		dlqQueue:   queueBase + ".events.dlq",
	}
	if err := r.declareTopology(); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

func (r *Rabbit) declareTopology() error {
	if err := r.ch.ExchangeDeclare(Exchange, "topic", true, false, false, false, nil); err != nil {
		return err
	}
	if err := r.ch.ExchangeDeclare(RetryExchange, "direct", true, false, false, false, nil); err != nil {
		return err
	}
	if err := r.ch.ExchangeDeclare(DLX, "fanout", true, false, false, false, nil); err != nil {
		return err
	}
	if _, err := r.ch.QueueDeclare(r.mainQueue, true, false, false, false, nil); err != nil {
		return err
	}
	if _, err := r.ch.QueueDeclare(r.retryQueue, true, false, false, false, amqp.Table{
		"x-message-ttl":             int32(RetryTTLMs),
		"x-dead-letter-exchange":    RetryExchange,
		"x-dead-letter-routing-key": r.mainQueue,
	}); err != nil {
		return err
	}
	if _, err := r.ch.QueueDeclare(r.dlqQueue, true, false, false, false, nil); err != nil {
		return err
	}
	if err := r.ch.QueueBind(r.mainQueue, r.mainQueue, RetryExchange, false, nil); err != nil {
		return err
	}
	if err := r.ch.QueueBind(r.dlqQueue, "", DLX, false, nil); err != nil {
		return err
	}
	return nil
}

func (r *Rabbit) Publish(ctx context.Context, eventType string, data any) error {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return err
	}
	env := Envelope{
		EventID:      uuid.NewString(),
		EventType:    eventType,
		EventVersion: "1.0",
		OccurredAt:   time.Now().UTC().Format(time.RFC3339Nano),
		Producer:     r.producer,
		Data:         dataJSON,
	}
	body, err := json.Marshal(env)
	if err != nil {
		return err
	}
	ctx, span := tracer.Start(ctx, "amqp.publish "+eventType,
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			semconv.MessagingSystemRabbitmq,
			attribute.String("messaging.destination.name", Exchange),
			attribute.String("messaging.rabbitmq.routing_key", eventType),
			attribute.String("messaging.message.id", env.EventID),
		),
	)
	defer span.End()

	pub := amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		MessageId:    env.EventID,
		Timestamp:    time.Now().UTC(),
		Body:         body,
	}
	observability.InjectAMQP(ctx, &pub)
	return r.ch.PublishWithContext(ctx, Exchange, eventType, false, false, pub)
}

type Handler func(ctx context.Context, env *Envelope) error

func (r *Rabbit) Subscribe(routingKeys []string, handler Handler) error {
	for _, k := range routingKeys {
		if err := r.ch.QueueBind(r.mainQueue, k, Exchange, false, nil); err != nil {
			return err
		}
	}
	deliveries, err := r.ch.Consume(r.mainQueue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	go r.consumeLoop(deliveries, handler)
	return nil
}

func (r *Rabbit) consumeLoop(deliveries <-chan amqp.Delivery, handler Handler) {
	for d := range deliveries {
		var env Envelope
		if err := json.Unmarshal(d.Body, &env); err != nil {
			slog.Error("malformed envelope, dropping", "err", err)
			_ = d.Nack(false, false)
			continue
		}
		parentCtx := observability.ExtractAMQP(context.Background(), d)
		ctx, cancel := context.WithTimeout(parentCtx, 30*time.Second)
		ctx, span := tracer.Start(ctx, "amqp.consume "+env.EventType,
			trace.WithSpanKind(trace.SpanKindConsumer),
			trace.WithAttributes(
				semconv.MessagingSystemRabbitmq,
				attribute.String("messaging.destination.name", r.mainQueue),
				attribute.String("messaging.message.id", env.EventID),
			),
		)
		err := handler(ctx, &env)
		span.End()
		cancel()
		if err == nil {
			_ = d.Ack(false)
			continue
		}
		retries := countRetries(d)
		if retries >= MaxRetries {
			slog.Error("max retries exceeded → DLQ", "event_id", env.EventID, "retries", retries, "err", err)
			_ = r.ch.PublishWithContext(context.Background(), DLX, "", false, false, amqp.Publishing{
				ContentType:  "application/json",
				DeliveryMode: amqp.Persistent,
				MessageId:    env.EventID,
				Body:         d.Body,
			})
			_ = d.Ack(false)
			continue
		}
		slog.Warn("consumer error → retry", "event_id", env.EventID, "retries", retries, "err", err)
		// retry queue → TTL expires → dead-letters back to main queue.
		_ = r.ch.PublishWithContext(context.Background(), "", r.retryQueue, false, false, amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			MessageId:    env.EventID,
			Body:         d.Body,
			Headers:      amqp.Table{"x-retry-count": int32(retries + 1)},
		})
		_ = d.Ack(false)
	}
}

func countRetries(d amqp.Delivery) int {
	if v, ok := d.Headers["x-retry-count"]; ok {
		switch n := v.(type) {
		case int32:
			return int(n)
		case int64:
			return int(n)
		case int:
			return n
		}
	}
	if xd, ok := d.Headers["x-death"]; ok {
		if list, ok := xd.([]interface{}); ok && len(list) > 0 {
			if entry, ok := list[0].(amqp.Table); ok {
				if c, ok := entry["count"]; ok {
					switch n := c.(type) {
					case int32:
						return int(n)
					case int64:
						return int(n)
					}
				}
			}
		}
	}
	return 0
}

func (r *Rabbit) Close() {
	if r.ch != nil {
		_ = r.ch.Close()
	}
	if r.conn != nil {
		_ = r.conn.Close()
	}
}
