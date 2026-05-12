import express from "express";
import pinoHttp from "pino-http";

import { JwtConfig } from "./auth/jwt";
import { RestaurantClient } from "./clients/restaurants";
import { Config } from "./config";
import { errorHandler } from "./errors";
import { logger } from "./logger";
import { metricsMiddleware, metricsRouter } from "./observability";
import { ordersRouter } from "./routes/orders";
import { ordersStreamRouter } from "./routes/orders-stream";
import { locationRouter } from "./routes/location";
import { ChannelStreamHub } from "./services/channel-stream-hub";
import { LocationService } from "./services/location";
import { OrdersService } from "./services/orders";

interface Wired {
  cfg: Config;
  jwt: JwtConfig;
  orders: OrdersService;
  location: LocationService;
  hub: ChannelStreamHub;
  restaurants: RestaurantClient;
}

export function buildApp({ jwt, orders, location, hub, restaurants }: Wired): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));
  app.use(metricsMiddleware);
  app.use(metricsRouter());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // Stream router goes first so GET /orders/stream matches before
  // ordersRouter's GET /orders/:id.
  app.use("/orders", ordersStreamRouter({ hub, restaurants, jwt }));
  app.use("/orders", ordersRouter({ service: orders, jwt }));
  app.use("/orders", locationRouter({ service: location, hub, jwt }));

  app.use(errorHandler);
  return app;
}
