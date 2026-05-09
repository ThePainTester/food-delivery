import Redis from "ioredis";

import { Config } from "./config";
import { logger } from "./logger";
import { dispatchLockContention } from "./observability";
import { Envelope, Rabbit } from "./rabbit";
import {
  dispatchLockKey,
  offeredDriversKey,
  responsesChannel,
} from "./redis";
import { DispatchService } from "./services/dispatch";

interface OrderAcceptedData {
  order_id: string;
  pickup_location?: { lat: number; lon: number };
  pickup?: { lat: number; lon: number };
}

interface OrderCancelledData {
  order_id: string;
}

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1]
  then return redis.call("del", KEYS[1])
  else return 0
end
`;

export async function startConsumers(
  rabbit: Rabbit,
  redis: Redis,
  dispatch: DispatchService,
  cfg: Config,
): Promise<void> {
  await rabbit.subscribe(["order.accepted", "order.cancelled"], async (env: Envelope) => {
    if (env.event_type === "order.accepted") {
      const d = env.data as OrderAcceptedData;
      const pickup = d.pickup_location ?? d.pickup;
      if (!pickup) {
        logger.warn({ order_id: d.order_id }, "order.accepted missing pickup_location, skipping");
        return;
      }
      const lockKey = dispatchLockKey(d.order_id);
      const got = await redis.set(lockKey, cfg.instanceId, "EX", cfg.dispatchLockTtlS, "NX");
      if (got !== "OK") {
        dispatchLockContention.inc();
        logger.info({ order_id: d.order_id }, "another pod holds the dispatch lock");
        return;
      }
      try {
        await dispatch.run(d.order_id, pickup);
      } catch (err) {
        logger.error({ err, order_id: d.order_id }, "dispatch loop failed");
      } finally {
        await redis
          .eval(RELEASE_LOCK_LUA, 1, lockKey, cfg.instanceId)
          .catch(() => {});
        await redis.del(offeredDriversKey(d.order_id)).catch(() => {});
      }
      return;
    }

    if (env.event_type === "order.cancelled") {
      const d = env.data as OrderCancelledData;
      // Global cancel on the per-order responses channel — any in-flight
      // dispatch loop on any pod treats this as an abort.
      await redis.publish(
        responsesChannel(d.order_id),
        JSON.stringify({ outcome: "cancelled" }),
      );
      // Also clear the offered set so a later re-trigger starts fresh.
      await redis.del(offeredDriversKey(d.order_id)).catch(() => {});
      logger.info({ order_id: d.order_id }, "broadcast cancellation");
    }
  });
}
