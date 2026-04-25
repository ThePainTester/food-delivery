import Redis from "ioredis";

import { RestaurantClient } from "../clients/restaurants";
import { forbidden, notFound } from "../errors";
import { locationKey } from "../redis";
import { OrdersRepo } from "../repositories/orders";
import { Actor } from "./orders";

export class LocationService {
  constructor(
    private repo: OrdersRepo,
    private redis: Redis,
    private restaurants: RestaurantClient,
    private ttlSeconds: number,
  ) {}

  async writeLocation(
    orderId: string,
    actor: Actor,
    coords: { latitude: number; longitude: number },
  ): Promise<void> {
    const o = await this.repo.findOwners(orderId);
    if (!o) throw notFound("order not found");
    if (actor.kind !== "user" || actor.role !== "delivery" || o.delivery_user_id !== actor.userId) {
      throw forbidden("must be assigned delivery user");
    }
    const payload = JSON.stringify({
      order_id: orderId,
      latitude: coords.latitude,
      longitude: coords.longitude,
      updated_at: new Date().toISOString(),
    });
    await this.redis.set(locationKey(orderId), payload, "EX", this.ttlSeconds);
  }

  /** Returns the raw JSON string from Redis (already in the API shape). */
  async readLocation(orderId: string, actor: Actor): Promise<string> {
    const o = await this.repo.findOwners(orderId);
    if (!o) throw notFound("order not found");
    if (actor.kind !== "user") throw forbidden("not allowed");

    if (actor.role === "customer") {
      if (o.customer_id !== actor.userId) throw forbidden("not allowed");
    } else if (actor.role === "restaurant") {
      const ownerId = await this.restaurants.getOwnerId(o.restaurant_id, actor.rawToken);
      if (ownerId !== actor.userId) throw forbidden("not restaurant owner");
    } else {
      throw forbidden("not allowed");
    }

    const raw = await this.redis.get(locationKey(orderId));
    if (!raw) throw notFound("no location available");
    return raw;
  }
}
