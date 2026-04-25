import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

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
  publicKey: Buffer;
  issuer: string;
}

export function requireAuth(cfg: JwtConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const h = req.header("authorization");
    if (!h || !h.startsWith("Bearer ")) {
      return res.status(401).json({ error: "unauthorized", message: "missing bearer token" });
    }
    const token = h.slice("Bearer ".length);
    try {
      const claims = jwt.verify(token, cfg.publicKey, {
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
