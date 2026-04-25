import express from "express";
import pinoHttp from "pino-http";
import { Pool } from "pg";
import Redis from "ioredis";

import { Config } from "./config";
import { errorHandler } from "./errors";
import { logger } from "./logger";
import { Rabbit } from "./rabbit";
import { RestaurantClient } from "./clients/restaurants";
import { ordersRouter } from "./routes/orders";
import { locationRouter } from "./routes/location";

export function buildApp(cfg: Config, pool: Pool, redis: Redis, rabbit: Rabbit): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  const jwt = { publicKey: cfg.jwtPublicKey, issuer: cfg.jwtIssuer };
  const restaurants = new RestaurantClient(cfg.restaurantServiceUrl);

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.use(
    "/orders",
    ordersRouter({ pool, rabbit, restaurants, jwt, deliveryFeeCents: cfg.deliveryFeeCents }),
  );
  app.use(
    "/orders",
    locationRouter({ pool, redis, restaurants, jwt, ttlSeconds: cfg.locationTtlSeconds }),
  );

  app.use(errorHandler);
  return app;
}
