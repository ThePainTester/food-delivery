import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export interface Config {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  rabbitUrl: string;
  jwtPublicKey: Buffer;
  jwtIssuer: string;
  instanceId: string;
  offerTimeoutMs: number;
  dispatchLockTtlS: number;
  searchRadiusM: number;
  heartbeatStaleMs: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: req("DATABASE_URL"),
    redisUrl: req("REDIS_URL"),
    rabbitUrl: req("RABBIT_URL"),
    jwtPublicKey: fs.readFileSync(req("JWT_PUBLIC_KEY_PATH")),
    jwtIssuer: process.env.JWT_ISSUER ?? "user-service",
    instanceId: process.env.HOSTNAME ?? `dispatch-${uuidv4()}`,
    offerTimeoutMs: Number(process.env.OFFER_TIMEOUT_MS ?? 12_000),
    dispatchLockTtlS: Number(process.env.DISPATCH_LOCK_TTL_S ?? 60),
    searchRadiusM: Number(process.env.SEARCH_RADIUS_M ?? 3000),
    heartbeatStaleMs: Number(process.env.HEARTBEAT_STALE_MS ?? 30_000),
  };
}
