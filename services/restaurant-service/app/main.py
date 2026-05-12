from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from jwt import PyJWKClient

from .config import load_settings
from .db import Mongo
from .errors import (
    http_exception_handler,
    unhandled_exception_handler,
    validation_handler,
)
from .observability import init_observability
from .routers import menu, restaurants


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    mongo = Mongo(settings.mongo_url, settings.mongo_db)
    await mongo.ensure_indexes()
    app.state.mongo = mongo
    # PyJWKClient fetches and caches the issuer's keys lazily on first use and
    # refetches on an unknown `kid`, so there's no hard startup ordering on
    # user-service.
    app.state.jwks_client = PyJWKClient(settings.jwks_url)
    app.state.jwt_issuer = settings.jwt_issuer
    try:
        yield
    finally:
        mongo.close()


_settings = load_settings()
app = FastAPI(
    title="Restaurant Service",
    lifespan=lifespan,
    root_path=_settings.root_path,
    # FastAPI's slash-redirect Location header doesn't account for a
    # path-stripping gateway, so disable it; callers must hit the exact path.
    redirect_slashes=False,
)

init_observability(app)

app.add_exception_handler(HTTPException, http_exception_handler)  # type: ignore
app.add_exception_handler(Exception, unhandled_exception_handler)  # type: ignore
app.add_exception_handler(RequestValidationError, validation_handler)  # type: ignore

app.include_router(restaurants.router)
app.include_router(menu.router)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
