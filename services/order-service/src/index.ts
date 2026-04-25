import { loadConfig } from "./config";
import { startConsumers } from "./consumers";
import { createPool } from "./db";
import { logger } from "./logger";
import { Rabbit } from "./rabbit";
import { createRedis } from "./redis";
import { buildApp } from "./server";

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const redis = createRedis(cfg.redisUrl);

  const rabbit = new Rabbit(cfg.rabbitUrl, "order-service", "order");
  await rabbit.connect();
  await startConsumers(rabbit, pool);

  const app = buildApp(cfg, pool, redis, rabbit);
  const server = app.listen(cfg.port, () => {
    logger.info({ port: cfg.port }, "order-service listening");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    await rabbit.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
});
