import { Router } from "express";
import { Pool } from "pg";
import Redis from "ioredis";
import { z } from "zod";

import { requireAuth } from "../auth/jwt";
import { RestaurantClient } from "../clients/restaurants";
import { badRequest, forbidden, notFound } from "../errors";
import { locationKey } from "../redis";

interface Deps {
  pool: Pool;
  redis: Redis;
  restaurants: RestaurantClient;
  jwt: { publicKey: Buffer; issuer: string };
  ttlSeconds: number;
}

const postLocationSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
});

interface OrderOwners {
  customer_id: string;
  delivery_user_id: string | null;
  restaurant_id: string;
}

async function orderOwners(pool: Pool, id: string): Promise<OrderOwners | null> {
  const { rows } = await pool.query<OrderOwners>(
    `SELECT customer_id, delivery_user_id, restaurant_id FROM orders WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export function locationRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

  r.post("/:id/location", auth, async (req, res, next) => {
    try {
      const body = postLocationSchema.parse(req.body);
      const o = await orderOwners(deps.pool, req.params.id);
      if (!o) throw notFound("order not found");
      const p = req.principal!;
      if (p.role !== "delivery" || o.delivery_user_id !== p.userId) {
        throw forbidden("must be assigned delivery user");
      }
      const payload = JSON.stringify({
        order_id: req.params.id,
        latitude: body.latitude,
        longitude: body.longitude,
        updated_at: new Date().toISOString(),
      });
      await deps.redis.set(locationKey(req.params.id), payload, "EX", deps.ttlSeconds);
      res.status(204).end();
    } catch (e) {
      if (e instanceof z.ZodError) return next(badRequest(e.errors.map((x) => x.message).join("; ")));
      next(e);
    }
  });

  r.get("/:id/location", auth, async (req, res, next) => {
    try {
      const o = await orderOwners(deps.pool, req.params.id);
      if (!o) throw notFound("order not found");
      const p = req.principal!;
      if (p.role === "customer") {
        if (o.customer_id !== p.userId) throw forbidden("not allowed");
      } else if (p.role === "restaurant") {
        const ownerId = await deps.restaurants.getOwnerId(o.restaurant_id, p.rawToken);
        if (ownerId !== p.userId) throw forbidden("not restaurant owner");
      } else {
        throw forbidden("not allowed");
      }

      const raw = await deps.redis.get(locationKey(req.params.id));
      if (!raw) throw notFound("no location available");
      res.type("application/json").send(raw);
    } catch (e) {
      next(e);
    }
  });

  return r;
}
