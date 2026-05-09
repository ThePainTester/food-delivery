// MUST be the first import — auto-instrumentations monkey-patch
// http/express/pg/amqplib/ioredis at require time.
import { startTracing, shutdownTracing } from "./observability";
startTracing();

import { RestaurantClient } from "./clients/restaurants";
import { loadConfig } from "./config";
import { startConsumers } from "./consumers";
import { createPool } from "./db";
import { logger } from "./logger";
import { Rabbit } from "./rabbit";
import { createRedis } from "./redis";
import { OrdersRepo } from "./repositories/orders";
import { buildApp } from "./server";
import { LocationStreamHub } from "./services/location-stream-hub";
import { LocationService } from "./services/location";
import { OrdersService } from "./services/orders";

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const redis = createRedis(cfg.redisUrl);

  const rabbit = new Rabbit(cfg.rabbitUrl, "order-service", "order");
  await rabbit.connect();

  const restaurants = new RestaurantClient(cfg.restaurantServiceUrl);
  const repo = new OrdersRepo(pool);
  const ordersService = new OrdersService(repo, rabbit, restaurants, cfg.deliveryFeeMinor);
  const locationService = new LocationService(repo, redis, restaurants, cfg.locationTtlSeconds);
  const locationHub = new LocationStreamHub(redis);

  await startConsumers(rabbit, pool, ordersService);

  const app = buildApp({ cfg, orders: ordersService, location: locationService, hub: locationHub });
  const server = app.listen(cfg.port, () => {
    logger.info({ port: cfg.port }, "order-service listening");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    await rabbit.close();
    await pool.end();
    await locationHub.close();
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
