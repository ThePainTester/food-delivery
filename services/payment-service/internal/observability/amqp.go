// W3C trace-context propagation across RabbitMQ. amqp091-go has no
// official OTel contrib lib, so we wire it manually.
package observability

import (
	"context"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

type amqpHeaderCarrier amqp.Table

func (c amqpHeaderCarrier) Get(key string) string {
	if v, ok := c[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func (c amqpHeaderCarrier) Set(key, value string) { c[key] = value }

func (c amqpHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

func InjectAMQP(ctx context.Context, p *amqp.Publishing) {
	if p.Headers == nil {
		p.Headers = amqp.Table{}
	}
	otel.GetTextMapPropagator().Inject(ctx, amqpHeaderCarrier(p.Headers))
}

func ExtractAMQP(ctx context.Context, d amqp.Delivery) context.Context {
	if d.Headers == nil {
		return ctx
	}
	return otel.GetTextMapPropagator().Extract(ctx, amqpHeaderCarrier(d.Headers))
}

var AMQPPropagator propagation.TextMapPropagator = propagation.TraceContext{}
