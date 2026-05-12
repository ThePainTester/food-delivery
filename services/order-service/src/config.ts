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
  jwksUrl: string;
  jwtIssuer: string;
  restaurantServiceUrl: string;
  deliveryFeeMinor: number;
  locationTtlSeconds: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: req("DATABASE_URL"),
    redisUrl: req("REDIS_URL"),
    rabbitUrl: req("RABBIT_URL"),
    jwksUrl: req("JWKS_URL"),
    jwtIssuer: process.env.JWT_ISSUER ?? "user-service",
    restaurantServiceUrl: req("RESTAURANT_SERVICE_URL"),
    deliveryFeeMinor: Number(process.env.DELIVERY_FEE_MINOR ?? 3000),
    locationTtlSeconds: Number(process.env.LOCATION_TTL_SECONDS ?? 120),
  };
}
