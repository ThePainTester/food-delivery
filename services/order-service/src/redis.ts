import Redis from "ioredis";

export function createRedis(url: string): Redis {
  return new Redis(url, { lazyConnect: false });
}

export function locationKey(orderId: string): string {
  return `order:${orderId}:location`;
}

export function locationChannel(orderId: string): string {
  return `order:${orderId}:location:stream`;
}
