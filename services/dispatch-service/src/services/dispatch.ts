import Redis from "ioredis";

import { logger } from "../logger";
import {
  dispatchNoDrivers,
  dispatchOfferOutcomes,
  dispatchOffersOffered,
} from "../observability";
import { Rabbit } from "../rabbit";
import {
  OFFERS_CHANNEL,
  offeredDriversKey,
  responsesChannel,
} from "../redis";
import { findByDistance, LatLon } from "./candidates";

export type Outcome = "accepted" | "rejected" | "timeout" | "cancelled";

interface ResponseMessage {
  driverId?: string;
  outcome: Outcome;
}

interface RunDeps {
  redis: Redis;
  rabbit: Rabbit;
  searchRadiusM: number;
  offerTimeoutMs: number;
  heartbeatStaleMs: number;
}

export class DispatchService {
  constructor(private deps: RunDeps) {}

  async run(orderId: string, pickup: LatLon): Promise<void> {
    const { redis, rabbit, searchRadiusM, offerTimeoutMs, heartbeatStaleMs } = this.deps;

    const ranked = await findByDistance(redis, {
      pickup,
      radiusM: searchRadiusM,
      heartbeatStaleMs,
    });
    logger.info({ orderId, candidates: ranked.length }, "dispatch candidates");

    if (ranked.length === 0) {
      dispatchNoDrivers.inc();
      await rabbit.publish("dispatch.no_drivers", { order_id: orderId });
      return;
    }

    // Dedicated subscriber connection — Redis client switches modes when
    // subscribing, so we cannot share with publish/command path. Subscribe
    // BEFORE publishing the first offer to close the publish/subscribe race.
    const subscriber = redis.duplicate();
    const channel = responsesChannel(orderId);
    const inbox: ResponseMessage[] = [];
    let resolveNext: ((m: ResponseMessage) => void) | null = null;

    subscriber.on("message", (ch, raw) => {
      if (ch !== channel) return;
      let msg: ResponseMessage;
      try {
        msg = JSON.parse(raw) as ResponseMessage;
      } catch {
        return;
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(msg);
      } else {
        inbox.push(msg);
      }
    });

    try {
      await subscriber.subscribe(channel);

      let cancelled = false;
      let lastOfferedDriver: string | undefined;

      for (const d of ranked) {
        if (cancelled) break;
        const fresh = await redis.sadd(offeredDriversKey(orderId), d.id);
        if (fresh === 0) continue;

        lastOfferedDriver = d.id;
        await redis.publish(
          OFFERS_CHANNEL,
          JSON.stringify({
            driverId: d.id,
            orderId,
            pickup,
            expires_in_s: Math.floor(offerTimeoutMs / 1000),
          }),
        );
        dispatchOffersOffered.inc();

        const outcome = await waitNext(d.id, offerTimeoutMs);
        dispatchOfferOutcomes.inc({ outcome });
        logger.info({ orderId, driverId: d.id, outcome }, "offer resolved");

        if (outcome === "accepted") return;
        if (outcome === "cancelled") {
          cancelled = true;
          await redis.publish(
            OFFERS_CHANNEL,
            JSON.stringify({ driverId: d.id, orderId, type: "cancelled" }),
          );
          return;
        }
      }

      if (!cancelled) {
        dispatchNoDrivers.inc();
        await rabbit.publish("dispatch.no_drivers", { order_id: orderId });
        logger.info({ orderId }, "dispatch exhausted candidates");
      }
      void lastOfferedDriver;
    } finally {
      subscriber.disconnect();
    }

    // Pull next response matching this driver, or "cancelled" regardless of
    // driverId, or "timeout" after timeoutMs. Drains the inbox first so a
    // late accept queued before we awaited isn't lost.
    function waitNext(driverId: string, timeoutMs: number): Promise<Outcome> {
      const matches = (m: ResponseMessage): Outcome | null => {
        if (m.outcome === "cancelled") return "cancelled";
        if (m.driverId === driverId) return m.outcome;
        return null;
      };
      while (inbox.length > 0) {
        const m = inbox.shift()!;
        const o = matches(m);
        if (o) return Promise.resolve(o);
      }
      return new Promise<Outcome>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolveNext = null;
          resolve("timeout");
        }, timeoutMs);

        const accept = (m: ResponseMessage) => {
          const o = matches(m);
          if (o === null) {
            // not for us — re-arm and keep waiting
            resolveNext = accept;
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(o);
        };
        resolveNext = accept;
      });
    }
  }
}
