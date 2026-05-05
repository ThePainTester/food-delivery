// MUST be imported before express/pg/amqplib/ioredis so the
// auto-instrumentations can monkey-patch them.

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { AmqplibInstrumentation } from "@opentelemetry/instrumentation-amqplib";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import client from "prom-client";
import express from "express";
import type { Request, Response, NextFunction } from "express";

const SERVICE = process.env.OTEL_SERVICE_NAME ?? "order-service";

export const sdk = new NodeSDK({
  resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: SERVICE }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
    new AmqplibInstrumentation({
      publishHook: (span, info) => {
        span.setAttribute("messaging.message.id", String(info.options?.messageId ?? ""));
      },
    }),
    new IORedisInstrumentation(),
  ],
});

export function startTracing(): void {
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  try {
    await sdk.shutdown();
  } catch {
    /* swallow */
  }
}

client.collectDefaultMetrics({ prefix: "nodejs_" });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled.",
  labelNames: ["method", "route", "status"],
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds.",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    // Use the route template ("/orders/:id") not the raw path, to keep
    // metric label cardinality bounded.
    const route = (req.route?.path as string | undefined) ?? req.path ?? "unknown";
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequests.inc(labels);
    httpDuration.observe(labels, seconds);
  });
  next();
}

export function metricsRouter(): express.Router {
  const r = express.Router();
  r.get("/metrics", async (_req, res) => {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  });
  return r;
}
