// Package observability wires OTel tracing, JSON logging, and Prometheus
// metrics. Call from main once at startup.
package observability

import (
	"context"
	"log/slog"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// InitTracer configures the global TracerProvider with an OTLP gRPC
// exporter (endpoint comes from OTEL_EXPORTER_OTLP_ENDPOINT).
// Returns a shutdown func the caller should defer.
func InitTracer(ctx context.Context, serviceName string) (func(context.Context) error, error) {
	exp, err := otlptracegrpc.New(ctx, otlptracegrpc.WithInsecure())
	if err != nil {
		return nil, err
	}
	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithProcess(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(semconv.ServiceName(serviceName)),
	)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(2*time.Second)),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	return tp.Shutdown, nil
}

// JSONLogger returns a slog.Logger that emits JSON and stamps
// trace_id/span_id from the context's active span.
func JSONLogger(serviceName string) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				return slog.String("timestamp", a.Value.Time().UTC().Format(time.RFC3339Nano))
			}
			if a.Key == slog.MessageKey {
				return slog.String("msg", a.Value.String())
			}
			return a
		},
	})
	return slog.New(&traceHandler{Handler: h}).With("service", serviceName)
}

type traceHandler struct{ slog.Handler }

func (t *traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return t.Handler.Handle(ctx, r)
}

func (t *traceHandler) WithAttrs(as []slog.Attr) slog.Handler { return &traceHandler{Handler: t.Handler.WithAttrs(as)} }
func (t *traceHandler) WithGroup(g string) slog.Handler        { return &traceHandler{Handler: t.Handler.WithGroup(g)} }
