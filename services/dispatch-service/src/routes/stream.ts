import { Router } from "express";

import { JwtConfig, Principal, requireAuth, requireRole } from "../auth/jwt";
import { logger } from "../logger";
import { driverOffersChannel } from "../redis";
import { ChannelStreamHub } from "../stream-hub";

interface Deps {
  hub: ChannelStreamHub;
  jwt: JwtConfig;
}

// SSE for the driver UI. Subscribes the connection to the driver's
// per-id channel; the dispatch.offers fan-in (see index.ts) republishes
// matching offers locally on this channel.
export function driverStreamRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

  r.get("/stream", auth, requireRole("delivery"), async (req, res, next) => {
    const principal = req.principal as Principal;
    const channel = driverOffersChannel(principal.userId);

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let release: () => void;
    try {
      release = await deps.hub.subscribe(channel, (msg) => {
        res.write(`data: ${msg}\n\n`);
      });
    } catch (err) {
      logger.error({ err, channel }, "driver stream subscribe failed");
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
