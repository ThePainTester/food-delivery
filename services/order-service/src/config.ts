import fs from "node:fs";

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
  restaurantServiceUrl: string;
  deliveryFeeCents: number;
  locationTtlSeconds: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: req("DATABASE_URL"),
    redisUrl: req("REDIS_URL"),
    rabbitUrl: req("RABBIT_URL"),
    jwtPublicKey: fs.readFileSync(req("JWT_PUBLIC_KEY_PATH")),
    jwtIssuer: process.env.JWT_ISSUER ?? "user-service",
    restaurantServiceUrl: req("RESTAURANT_SERVICE_URL"),
    deliveryFeeCents: Number(process.env.DELIVERY_FEE_CENTS ?? 250),
    locationTtlSeconds: Number(process.env.LOCATION_TTL_SECONDS ?? 120),
  };
}
