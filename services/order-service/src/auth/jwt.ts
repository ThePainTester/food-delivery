import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { JwksCache } from "./jwks";

export type Role = "customer" | "restaurant" | "delivery";

export interface Principal {
  userId: string;
  role: Role;
  rawToken: string;
}

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

export interface JwtConfig {
  jwks: JwksCache;
  issuer: string;
}

export function requireAuth(cfg: JwtConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const h = req.header("authorization");
    const token = h && h.startsWith("Bearer ") ? h.slice("Bearer ".length) : undefined;
    if (!token) {
      return res.status(401).json({ error: "unauthorized", message: "missing bearer token" });
    }
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === "string") {
      return res.status(401).json({ error: "unauthorized", message: "invalid token" });
    }
    let key;
    try {
      key = await cfg.jwks.getKey(decoded.header.kid);
    } catch {
      return res.status(401).json({ error: "unauthorized", message: "key resolution failed" });
    }
    if (!key) {
      return res.status(401).json({ error: "unauthorized", message: "unknown signing key" });
    }
    try {
      const claims = jwt.verify(token, key, {
        algorithms: ["RS256"],
        issuer: cfg.issuer,
      }) as jwt.JwtPayload & { user_id?: string; role?: Role };

      if (!claims.user_id || !claims.role) {
        return res.status(401).json({ error: "unauthorized", message: "invalid token claims" });
      }
      req.principal = { userId: claims.user_id, role: claims.role, rawToken: token };
      next();
    } catch {
      return res.status(401).json({ error: "unauthorized", message: "invalid token" });
    }
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.principal) {
      return res.status(401).json({ error: "unauthorized", message: "missing principal" });
    }
    if (!roles.includes(req.principal.role)) {
      return res.status(403).json({ error: "forbidden", message: "insufficient role" });
    }
    next();
  };
}
