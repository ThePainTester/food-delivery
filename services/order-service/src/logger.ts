import pino from "pino";
import { trace } from "@opentelemetry/api";

// mixin stamps trace_id/span_id from the active OTel span on every line.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.OTEL_SERVICE_NAME ?? "order-service" },
  messageKey: "msg",
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin() {
    const ctx = trace.getActiveSpan()?.spanContext();
    if (!ctx) return {};
    return { trace_id: ctx.traceId, span_id: ctx.spanId };
  },
});
