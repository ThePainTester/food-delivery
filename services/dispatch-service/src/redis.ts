import Redis from "ioredis";

export function createRedis(url: string): Redis {
  return new Redis(url, { lazyConnect: false });
}

export const DRIVERS_AVAILABLE_GEO = "drivers:available";
export const OFFERS_CHANNEL = "dispatch.offers";

export function driverHashKey(driverId: string): string {
  return `driver:${driverId}`;
}

export function dispatchLockKey(orderId: string): string {
  return `dispatch:lock:${orderId}`;
}

export function offeredDriversKey(orderId: string): string {
  return `order:${orderId}:offered_drivers`;
}

export function responsesChannel(orderId: string): string {
  return `dispatch.responses:${orderId}`;
}

// SSE channel local to a driver — published to by the pod that received
// the broadcast offer if it holds that driver's SSE connection. Other pods
// drop the message.
export function driverOffersChannel(driverId: string): string {
  return `driver:${driverId}:offers`;
}
