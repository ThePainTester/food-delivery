import amqp, { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { v4 as uuidv4 } from "uuid";

import { logger } from "./logger";

export const EXCHANGE = "food_delivery";
export const RETRY_EXCHANGE = "food_delivery.retry";
export const DLX = "food_delivery.dlx";
export const MAX_RETRIES = 3;
export const RETRY_TTL_MS = 30_000;
export const PREFETCH = 10;

export type EventType =
  | "order.placed"
  | "order.accepted"
  | "order.rejected"
  | "order.ready"
  | "order.picked_up"
  | "order.delivered"
  | "order.cancelled"
  | "payment.completed"
  | "payment.failed"
  | "delivery.assigned";

export interface Envelope<T = unknown> {
  event_id: string;
  event_type: EventType;
  event_version: string;
  occurred_at: string;
  producer: string;
  data: T;
}

export class Rabbit {
  private conn!: ChannelModel;
  private ch!: Channel;

  constructor(
    private url: string,
    private producer: string,
    private serviceQueueBase: string, // e.g. "order"
  ) {}

  async connect(): Promise<void> {
    this.conn = await amqp.connect(this.url);
    this.ch = await this.conn.createChannel();
    await this.ch.prefetch(PREFETCH);

    await this.ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await this.ch.assertExchange(RETRY_EXCHANGE, "direct", { durable: true });
    await this.ch.assertExchange(DLX, "fanout", { durable: true });

    const main = `${this.serviceQueueBase}.events`;
    const retry = `${this.serviceQueueBase}.events.retry`;
    const dlq = `${this.serviceQueueBase}.events.dlq`;

    await this.ch.assertQueue(main, { durable: true });
    await this.ch.assertQueue(retry, {
      durable: true,
      arguments: {
        "x-message-ttl": RETRY_TTL_MS,
        "x-dead-letter-exchange": RETRY_EXCHANGE,
        "x-dead-letter-routing-key": main,
      },
    });
    await this.ch.assertQueue(dlq, { durable: true });

    // Retry exchange routes back to main queue so retried messages are reprocessed.
    await this.ch.bindQueue(main, RETRY_EXCHANGE, main);
    await this.ch.bindQueue(dlq, DLX, "");

    this.conn.on("error", (err) => logger.error({ err }, "rabbit connection error"));
  }

  async publish<T>(event: EventType, data: T): Promise<void> {
    const envelope: Envelope<T> = {
      event_id: uuidv4(),
      event_type: event,
      event_version: "1.0",
      occurred_at: new Date().toISOString(),
      producer: this.producer,
      data,
    };
    this.ch.publish(EXCHANGE, event, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: "application/json",
      messageId: envelope.event_id,
    });
  }

  /**
   * Subscribe to one or more routing keys on the service's main queue.
   * Handler receives the parsed envelope. Throwing routes to retry/DLQ.
   */
  async subscribe(
    routingKeys: EventType[],
    handler: (env: Envelope) => Promise<void>,
  ): Promise<void> {
    const main = `${this.serviceQueueBase}.events`;
    for (const k of routingKeys) {
      await this.ch.bindQueue(main, EXCHANGE, k);
    }
    await this.ch.consume(main, async (msg) => {
      if (!msg) return;
      try {
        const env = JSON.parse(msg.content.toString()) as Envelope;
        await handler(env);
        this.ch.ack(msg);
      } catch (err) {
        const retries = countRetries(msg);
        if (retries >= MAX_RETRIES) {
          logger.error({ err, retries }, "max retries exceeded → DLQ");
          this.ch.publish(DLX, "", msg.content, {
            persistent: true,
            contentType: "application/json",
            messageId: msg.properties.messageId,
          });
          this.ch.ack(msg);
        } else {
          logger.warn({ err, retries }, "consumer error → retry");
          this.ch.publish(RETRY_EXCHANGE, `${this.serviceQueueBase}.events.retry`, msg.content, {
            persistent: true,
            contentType: "application/json",
            messageId: msg.properties.messageId,
            headers: { "x-retry-count": retries + 1 },
          });
          // Route through retry queue for the TTL delay.
          await this.routeViaRetryQueue(msg);
          this.ch.ack(msg);
        }
      }
    });
  }

  private async routeViaRetryQueue(msg: ConsumeMessage): Promise<void> {
    const retry = `${this.serviceQueueBase}.events.retry`;
    this.ch.sendToQueue(retry, msg.content, {
      persistent: true,
      contentType: "application/json",
      messageId: msg.properties.messageId,
      headers: { ...(msg.properties.headers ?? {}) },
    });
  }

  async close(): Promise<void> {
    try {
      await this.ch?.close();
      await this.conn?.close();
    } catch {
      // ignore
    }
  }
}

function countRetries(msg: ConsumeMessage): number {
  const xDeath = msg.properties.headers?.["x-death"] as Array<{ count: number }> | undefined;
  if (Array.isArray(xDeath) && xDeath.length > 0) {
    return Number(xDeath[0]?.count ?? 0);
  }
  const explicit = msg.properties.headers?.["x-retry-count"];
  return typeof explicit === "number" ? explicit : 0;
}
