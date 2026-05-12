import { Router } from "express";

import { JwtConfig, Principal, requireAuth } from "../auth/jwt";
import { RestaurantClient } from "../clients/restaurants";
import { badRequest, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import {
  customerOrdersChannel,
  deliveryOrdersChannel,
  restaurantOrdersChannel,
} from "../redis";
import { ChannelStreamHub } from "../services/channel-stream-hub";

interface Deps {
  hub: ChannelStreamHub;
  restaurants: RestaurantClient;
  jwt: JwtConfig;
}

// SSE stream for order-state changes. Channels subscribed to depend on the
// caller's role:
//   customer   -> their own orders
//   restaurant -> the restaurant's orders (ownership verified)
//   delivery   -> their own deliveries (drivers receive offers via the
//                 dispatch-service SSE stream, not via this one)
//
// Each Pub/Sub message is a small "order changed" envelope; the SPA reacts
// by refetching whichever list/order it's currently rendering.
export function ordersStreamRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt, { allowQueryToken: true });

  r.get("/stream", auth, async (req, res, next) => {
    const principal = req.principal as Principal;
    let channels: string[];
    try {
      channels = await resolveChannels(principal, req.query, deps.restaurants);
    } catch (e) {
      return next(e);
    }

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let release: () => void;
    try {
      release = await deps.hub.subscribeAll(channels, (msg) => {
        res.write(`data: ${msg}\n\n`);
      });
    } catch (err) {
      logger.error({ err, channels }, "orders stream subscribe failed");
      return next(err);
    }

    const heartbeat = setInterval(() => res.write(":hb\n\n"), 25_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      release();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  return r;
}

async function resolveChannels(
  principal: Principal,
  query: Record<string, unknown>,
  restaurants: RestaurantClient,
): Promise<string[]> {
  if (principal.role === "customer") {
    return [customerOrdersChannel(principal.userId)];
  }
  if (principal.role === "delivery") {
    return [deliveryOrdersChannel(principal.userId)];
  }
  if (principal.role === "restaurant") {
    const restaurantId = typeof query.restaurant_id === "string" ? query.restaurant_id : undefined;
    if (!restaurantId) throw badRequest("restaurant_id query param required");
    const ownerId = await restaurants.getOwnerId(restaurantId, principal.rawToken);
    if (ownerId === null) throw notFound("restaurant not found");
    if (ownerId !== principal.userId) throw forbidden("not restaurant owner");
    return [restaurantOrdersChannel(restaurantId)];
  }
  throw forbidden("unknown role");
}
