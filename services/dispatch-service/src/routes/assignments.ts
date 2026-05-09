import { Router } from "express";
import Redis from "ioredis";

import { Principal, requireAuth, requireRole } from "../auth/jwt";
import { logger } from "../logger";
import { dispatchAssignments } from "../observability";
import { Rabbit } from "../rabbit";
import {
  DRIVERS_AVAILABLE_GEO,
  driverHashKey,
  responsesChannel,
} from "../redis";
import { AssignmentsRepo } from "../repositories/assignments";

interface Deps {
  repo: AssignmentsRepo;
  redis: Redis;
  rabbit: Rabbit;
  jwt: { publicKey: Buffer; issuer: string };
}

export function assignmentsRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

  r.post("/:orderId/accept", auth, requireRole("delivery"), async (req, res, next) => {
    try {
      const principal = req.principal as Principal;
      const driverId = principal.userId;
      const orderId = req.params.orderId;

      // Postgres is the only authority. INSERT … ON CONFLICT decides
      // the winner; rowCount=0 means another accept already won (or this
      // is a duplicate retry) — return 409 with no side effects.
      const { inserted } = await deps.repo.tryClaim(orderId, driverId);
      if (!inserted) {
        return res.status(409).json({ error: "conflict", message: "order already assigned" });
      }

      await deps.redis
        .multi()
        .zrem(DRIVERS_AVAILABLE_GEO, driverId)
        .hset(driverHashKey(driverId), { available: "false" })
        .exec();

      await deps.rabbit.publish("delivery.assigned", {
        order_id: orderId,
        delivery_user_id: driverId,
      });

      await deps.redis.publish(
        responsesChannel(orderId),
        JSON.stringify({ driverId, outcome: "accepted" }),
      );

      dispatchAssignments.inc();
      logger.info({ orderId, driverId }, "assignment finalized");
      res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post("/:orderId/reject", auth, requireRole("delivery"), async (req, res, next) => {
    try {
      const principal = req.principal as Principal;
      const driverId = principal.userId;
      const orderId = req.params.orderId;

      await deps.redis.publish(
        responsesChannel(orderId),
        JSON.stringify({ driverId, outcome: "rejected" }),
      );

      logger.info({ orderId, driverId }, "offer rejected");
      res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
