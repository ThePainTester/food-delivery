import { Router } from "express";
import { z } from "zod";

import { JwtConfig, Principal, requireAuth } from "../auth/jwt";
import { badRequest } from "../errors";
import { logger } from "../logger";
import { locationChannel } from "../redis";
import { ChannelStreamHub } from "../services/channel-stream-hub";
import { Actor } from "../services/orders";
import { LocationService } from "../services/location";

const postLocationSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
});

const userActor = (p: Principal): Actor => ({
  kind: "user",
  role: p.role,
  userId: p.userId,
  rawToken: p.rawToken,
});

interface Deps {
  service: LocationService;
  hub: ChannelStreamHub;
  jwt: JwtConfig;
}

export function locationRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);
  // SSE handshake can't carry an Authorization header (EventSource API
  // doesn't support custom headers), so this one route also accepts the
  // token via `?token=` for the customer's live-tracking stream.
  const authStream = requireAuth(deps.jwt, { allowQueryToken: true });

  r.post("/:id/location", auth, async (req, res, next) => {
    try {
      const body = postLocationSchema.parse(req.body);
      await deps.service.writeLocation(req.params.id, userActor(req.principal!), body);
      res.status(204).end();
    } catch (e) {
      if (e instanceof z.ZodError) return next(badRequest(e.errors.map((x) => x.message).join("; ")));
      next(e);
    }
  });

  r.get("/:id/location", auth, async (req, res, next) => {
    try {
      const raw = await deps.service.readLocation(req.params.id, userActor(req.principal!));
      res.type("application/json").send(raw);
    } catch (e) {
      next(e);
    }
  });

  r.get("/:id/location/stream", authStream, async (req, res, next) => {
    const orderId = req.params.id;
    try {
      await deps.service.authorizeStream(orderId, userActor(req.principal!));
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

    // Send the latest known fix so the map renders immediately rather
    // than waiting up to 5s for the next driver POST.
    const latest = await deps.service.readLatestRaw(orderId);
    if (latest) res.write(`data: ${latest}\n\n`);

    // Hand off to the per-pod fanout hub. One Redis subscriber connection
    // is shared across every SSE client on this pod; multiple customers
    // watching the same order share a single SUBSCRIBE.
    let release: () => void;
    try {
      release = await deps.hub.subscribe(locationChannel(orderId), (msg) => {
        res.write(`data: ${msg}\n\n`);
      });
    } catch (err) {
      logger.error({ err, orderId }, "stream subscribe failed");
      return next(err);
    }

    // Comment line keeps idle connections alive through proxies that
    // close on no-traffic. SSE clients ignore lines starting with `:`.
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
