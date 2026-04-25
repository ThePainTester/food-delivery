import express from "express";
import pinoHttp from "pino-http";

import { Config } from "./config";
import { errorHandler } from "./errors";
import { logger } from "./logger";
import { ordersRouter } from "./routes/orders";
import { locationRouter } from "./routes/location";
import { LocationService } from "./services/location";
import { OrdersService } from "./services/orders";

interface Wired {
  cfg: Config;
  orders: OrdersService;
  location: LocationService;
}

export function buildApp({ cfg, orders, location }: Wired): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  const jwt = { publicKey: cfg.jwtPublicKey, issuer: cfg.jwtIssuer };

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/orders", ordersRouter({ service: orders, jwt }));
  app.use("/orders", locationRouter({ service: location, jwt }));

  app.use(errorHandler);
  return app;
}
