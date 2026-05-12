import express from "express";
import Redis from "ioredis";
import pinoHttp from "pino-http";

import { JwtConfig } from "./auth/jwt";
import { Config } from "./config";
import { errorHandler } from "./errors";
import { logger } from "./logger";
import { metricsMiddleware, metricsRouter } from "./observability";
import { Rabbit } from "./rabbit";
import { AssignmentsRepo } from "./repositories/assignments";
import { assignmentsRouter } from "./routes/assignments";
import { driversRouter } from "./routes/drivers";
import { driverStreamRouter } from "./routes/stream";
import { ChannelStreamHub } from "./stream-hub";

interface Wired {
  cfg: Config;
  jwt: JwtConfig;
  redis: Redis;
  rabbit: Rabbit;
  repo: AssignmentsRepo;
  hub: ChannelStreamHub;
}

export function buildApp({ jwt, redis, rabbit, repo, hub }: Wired): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));
  app.use(metricsMiddleware);
  app.use(metricsRouter());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  // The gateway forwards /api/dispatch/* and strips only /api before
  // proxying, so the backend receives /dispatch/* on the wire (matching the
  // pattern used by user/restaurant/order/payment services).
  // Stream first so /drivers/stream is matched before any future /drivers/:id.
  app.use("/dispatch/drivers", driverStreamRouter({ hub, jwt }));
  app.use("/dispatch/drivers", driversRouter({ redis, jwt }));
  app.use("/dispatch/assignments", assignmentsRouter({ repo, redis, rabbit, jwt }));

  app.use(errorHandler);
  return app;
}
