// MUST be the first import — auto-instrumentations monkey-patch
// http/express/pg/amqplib/ioredis at require time.
import { startTracing, shutdownTracing } from "./observability";
startTracing();

import { JwksCache } from "./auth/jwks";
import { loadConfig } from "./config";
import { startConsumers } from "./consumers";
import { createPool } from "./db";
import { logger } from "./logger";
import { Rabbit } from "./rabbit";
import {
  createRedis,
  driverOffersChannel,
  OFFERS_CHANNEL,
} from "./redis";
import { AssignmentsRepo } from "./repositories/assignments";
import { buildApp } from "./server";
import { DispatchService } from "./services/dispatch";
import { ChannelStreamHub } from "./stream-hub";

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const redis = createRedis(cfg.redisUrl);

  const rabbit = new Rabbit(cfg.rabbitUrl, "dispatch-service", "dispatch");
  await rabbit.connect();

  const jwks = new JwksCache(cfg.jwksUrl);
  await jwks.init();

  const repo = new AssignmentsRepo(pool);
  const hub = new ChannelStreamHub(redis);

  // Pod-wide subscriber for the broadcast offers channel. Every dispatch
  // pod subscribes; only the pod that holds the destination driver's SSE
  // connection republishes locally to deliver the offer. All other pods
  // drop the message — no sticky sessions needed.
  const offersSubscriber = redis.duplicate();
  await offersSubscriber.subscribe(OFFERS_CHANNEL);
  offersSubscriber.on("message", (ch, raw) => {
    if (ch !== OFFERS_CHANNEL) return;
    let msg: { driverId?: string };
    try {
      msg = JSON.parse(raw) as { driverId?: string };
    } catch {
      return;
    }
    if (!msg.driverId) return;
    const local = driverOffersChannel(msg.driverId);
    if (!hub.hasLocalListener(local)) return;
    hub.publishLocal(local, raw);
  });

  const dispatch = new DispatchService({
    redis,
    rabbit,
    searchRadiusM: cfg.searchRadiusM,
    offerTimeoutMs: cfg.offerTimeoutMs,
    heartbeatStaleMs: cfg.heartbeatStaleMs,
  });

  await startConsumers(rabbit, redis, dispatch, cfg);

  const app = buildApp({ cfg, jwt: { jwks, issuer: cfg.jwtIssuer }, redis, rabbit, repo, hub });
  const server = app.listen(cfg.port, () => {
    logger.info({ port: cfg.port, instance: cfg.instanceId }, "dispatch-service listening");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    await rabbit.close();
    await pool.end();
    await hub.close();
    offersSubscriber.disconnect();
    redis.disconnect();
    await shutdownTracing();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
});
