import { Router } from "express";
import { z } from "zod";

import { Principal, requireAuth } from "../auth/jwt";
import { badRequest } from "../errors";
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
  jwt: { publicKey: Buffer; issuer: string };
}

export function locationRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

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

  return r;
}
