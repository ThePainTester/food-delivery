import Redis from "ioredis";

import { DRIVERS_AVAILABLE_GEO, driverHashKey } from "../redis";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Candidate {
  id: string;
  distanceM: number;
  lat: number;
  lon: number;
}

export interface FindParams {
  pickup: LatLon;
  radiusM: number;
  heartbeatStaleMs: number;
}

// GEOSEARCH the available pool by radius, sorted by distance ascending.
// Then double-check each driver's HASH to drop entries that are no longer
// `available=true` or whose `last_seen` is stale. Both conditions are
// authoritative — the GEOSET can lag by a few seconds.
export async function findByDistance(
  redis: Redis,
  { pickup, radiusM, heartbeatStaleMs }: FindParams,
): Promise<Candidate[]> {
  // ioredis types vary by version; cast through unknown for the args.
  const raw = (await (redis as unknown as {
    geosearch: (...args: unknown[]) => Promise<unknown[]>;
  }).geosearch(
    DRIVERS_AVAILABLE_GEO,
    "FROMLONLAT",
    pickup.lon,
    pickup.lat,
    "BYRADIUS",
    radiusM,
    "m",
    "ASC",
    "WITHCOORD",
    "WITHDIST",
  )) as Array<[string, string, [string, string]]>;

  if (!raw || raw.length === 0) return [];

  const now = Date.now();
  const results: Candidate[] = [];
  for (const entry of raw) {
    const [id, distStr, coord] = entry;
    const hash = await redis.hgetall(driverHashKey(id));
    if (hash.available !== "true") continue;
    const lastSeen = Number(hash.last_seen ?? 0);
    if (!lastSeen || now - lastSeen > heartbeatStaleMs) continue;
    results.push({
      id,
      distanceM: Number(distStr),
      lon: Number(coord[0]),
      lat: Number(coord[1]),
    });
  }
  return results;
}
