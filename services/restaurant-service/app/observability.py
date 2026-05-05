"""OTel + JSON logging + Prometheus instrumentation bootstrap.

Endpoint and service name come from env (OTEL_EXPORTER_OTLP_ENDPOINT,
OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES).
"""

import logging
import os
import sys

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.pymongo import PymongoInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from prometheus_fastapi_instrumentator import Instrumentator
from pythonjsonlogger import jsonlogger


_SERVICE = os.getenv("OTEL_SERVICE_NAME", "restaurant-service")


class _TraceContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        ctx = trace.get_current_span().get_span_context()
        if ctx and ctx.is_valid:
            record.trace_id = format(ctx.trace_id, "032x")
            record.span_id = format(ctx.span_id, "016x")
        return True


def _configure_logging() -> None:
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(
        jsonlogger.JsonFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s %(trace_id)s %(span_id)s",
            rename_fields={
                "asctime": "timestamp",
                "levelname": "level",
                "message": "msg",
                "name": "logger",
            },
        )
    )
    handler.addFilter(_TraceContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    logging.LoggerAdapter(root, {"service": _SERVICE})


def _configure_tracing() -> None:
    resource = Resource.create({"service.name": _SERVICE})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(insecure=True)))
    trace.set_tracer_provider(provider)


def init_observability(app: FastAPI) -> None:
    _configure_logging()
    _configure_tracing()
    FastAPIInstrumentor.instrument_app(app)
    PymongoInstrumentor().instrument()
    Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
