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

// Per-recipient channels for order-state fan-out. Each backend mutation on
// an order publishes a small envelope to one or more of these so connected
// SSE clients refresh without polling.
export const DELIVERY_LOBBY_CHANNEL = "delivery:lobby";

export function customerOrdersChannel(userId: string): string {
  return `customer:${userId}:orders`;
}

export function restaurantOrdersChannel(restaurantId: string): string {
  return `restaurant:${restaurantId}:orders`;
}

export function deliveryOrdersChannel(userId: string): string {
  return `delivery:${userId}:orders`;
}
