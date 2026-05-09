import { Router } from "express";
import Redis from "ioredis";
import { z } from "zod";

import { Principal, requireAuth, requireRole } from "../auth/jwt";
import { badRequest } from "../errors";
import {
  DRIVERS_AVAILABLE_GEO,
  driverHashKey,
} from "../redis";

interface Deps {
  redis: Redis;
  jwt: { publicKey: Buffer; issuer: string };
}

const heartbeatSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export function driversRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

  // Heartbeat — also marks the driver available. Posted every ~8s by the
  // driver UI while in `Available` mode.
  r.post("/heartbeat", auth, requireRole("delivery"), async (req, res, next) => {
    try {
      const principal = req.principal as Principal;
      const parsed = heartbeatSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequest("invalid lat/lon"));
      const { lat, lon } = parsed.data;
      const driverId = principal.userId;

      await deps.redis
        .multi()
        .geoadd(DRIVERS_AVAILABLE_GEO, lon, lat, driverId)
        .hset(driverHashKey(driverId), {
          lat: String(lat),
          lon: String(lon),
          available: "true",
          last_seen: String(Date.now()),
        })
        .exec();

      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Off-duty — remove from the pool.
  r.post("/off", auth, requireRole("delivery"), async (req, res, next) => {
    try {
      const principal = req.principal as Principal;
      const driverId = principal.userId;
      await deps.redis
        .multi()
        .zrem(DRIVERS_AVAILABLE_GEO, driverId)
        .hset(driverHashKey(driverId), { available: "false" })
        .exec();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
