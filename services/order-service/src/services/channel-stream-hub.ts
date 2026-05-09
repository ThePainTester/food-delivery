import Redis from "ioredis";

import { logger } from "../logger";

type Subscriber = (payload: string) => void;

// ChannelStreamHub holds a *single* Redis subscriber connection per pod
// and demultiplexes incoming Pub/Sub messages to in-process listeners.
//
// Naive per-SSE-client `redis.duplicate()` opens one Redis connection per
// connected customer. At scale that exhausts Redis's `maxclients` long
// before Node's HTTP server is the bottleneck. With this hub:
//
//   - one Redis SUBSCRIBE connection for the whole pod (lifetime: process)
//   - one channel SUBSCRIBE per *channel* with at least one listener
//   - any number of HTTP/SSE clients fan out locally via Map<channel, Set>
//
// When the last listener for a channel disconnects we UNSUBSCRIBE so we're
// not holding subscriptions for channels nobody is watching.
export class ChannelStreamHub {
  private subscriber: Redis;
  private listeners = new Map<string, Set<Subscriber>>();

  constructor(redis: Redis) {
    // ioredis dedicates a connection once it enters subscriber mode, so
    // duplicate once at construction and reuse it for the pod's lifetime.
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

  // Register `fn` to receive every Pub/Sub message for `channel` until the
  // returned unsubscribe handle is called. The first listener for a channel
  // triggers a Redis SUBSCRIBE; the last one to leave triggers UNSUBSCRIBE.
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
        // Fire-and-forget — best effort. If unsubscribe fails we'll just
        // receive a few more messages and ignore them on the next tick.
        this.subscriber.unsubscribe(channel).catch((err) => {
          logger.warn({ err, channel }, "redis unsubscribe failed");
        });
      }
    };
  }

  // Convenience: subscribe to several channels at once. The returned
  // release closes all of them.
  async subscribeAll(channels: string[], fn: Subscriber): Promise<() => void> {
    const releases: (() => void)[] = [];
    try {
      for (const ch of channels) {
        releases.push(await this.subscribe(ch, fn));
      }
    } catch (err) {
      releases.forEach((r) => r());
      throw err;
    }
    return () => releases.forEach((r) => r());
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.subscriber.disconnect();
  }
}
