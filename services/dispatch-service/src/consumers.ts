import Redis from "ioredis";

import { Config } from "./config";
import { logger } from "./logger";
import { dispatchLockContention } from "./observability";
import { Envelope, Rabbit } from "./rabbit";
import { dispatchLockKey, responsesChannel } from "./redis";
import { DispatchService } from "./services/dispatch";

interface OrderAcceptedData {
  order_id: string;
  pickup_location?: { lat: number; lon: number };
  pickup?: { lat: number; lon: number };
}

interface OrderCancelledData {
  order_id: string;
}

// Compare-and-delete: only release the lock if it's still ours (the TTL may
// have lapsed and another pod taken it — don't delete someone else's lock).
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1]
  then return redis.call("del", KEYS[1])
  else return 0
end
`;

// Compare-and-extend: refresh the TTL only while we still own the lock.
// Returns 1 on success, 0 if the lock is gone or now held by another pod.
const RENEW_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1]
  then return redis.call("expire", KEYS[1], ARGV[2])
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

      // Renew the lock at ~half the TTL so it outlives the offer loop no
      // matter how long it runs (lots of drivers each timing out). The lock
      // then only truly lapses if this pod dies — at which point another pod
      // can re-trigger the order; the Postgres unique key still prevents a
      // double assignment regardless.
      const renewMs = Math.max(1, Math.floor(cfg.dispatchLockTtlS / 2)) * 1000;
      const renew = setInterval(() => {
        redis
          .eval(RENEW_LOCK_LUA, 1, lockKey, cfg.instanceId, String(cfg.dispatchLockTtlS))
          .then((r) => {
            if (r !== 1) logger.warn({ order_id: d.order_id }, "dispatch lock not renewed (lost?)");
          })
          .catch((err) => logger.warn({ err, order_id: d.order_id }, "dispatch lock renewal failed"));
      }, renewMs);
      renew.unref?.();

      try {
        await dispatch.run(d.order_id, pickup);
      } catch (err) {
        logger.error({ err, order_id: d.order_id }, "dispatch loop failed");
      } finally {
        clearInterval(renew);
        await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, cfg.instanceId).catch(() => {});
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
      logger.info({ order_id: d.order_id }, "broadcast cancellation");
    }
  });
}
