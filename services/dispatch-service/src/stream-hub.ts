import Redis from "ioredis";

import { logger } from "./logger";

type Subscriber = (payload: string) => void;

// ChannelStreamHub holds a single Redis subscriber connection per pod and
// demultiplexes Pub/Sub messages to in-process listeners. Mirrors the
// pattern used in order-service.
export class ChannelStreamHub {
  private subscriber: Redis;
  private listeners = new Map<string, Set<Subscriber>>();

  constructor(redis: Redis) {
    this.subscriber = redis.duplicate();
    this.subscriber.on("message", (channel, message) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(message);
        } catch (err) {
          logger.error({ err, channel }, "sse listener threw");
        }
      }
    });
    this.subscriber.on("error", (err) => {
      logger.error({ err }, "channel stream subscriber error");
    });
  }

  async subscribe(channel: string, fn: Subscriber): Promise<() => void> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(fn);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.subscriber.unsubscribe(channel).catch((err) => {
          logger.warn({ err, channel }, "redis unsubscribe failed");
        });
      }
    };
  }

  // True when this pod has at least one local listener for the channel.
  // Used by the broadcast-offer fan-in: the pod that holds the driver's
  // SSE connection is the one that delivers; all others drop.
  hasLocalListener(channel: string): boolean {
    const set = this.listeners.get(channel);
    return !!set && set.size > 0;
  }

  publishLocal(channel: string, payload: string): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        logger.error({ err, channel }, "sse listener threw");
      }
    }
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.subscriber.disconnect();
  }
}
