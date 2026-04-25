import { Pool } from "pg";

import { HttpError } from "./errors";
import { logger } from "./logger";
import { Envelope, Rabbit } from "./rabbit";
import { OrdersService } from "./services/orders";

const CONSUMER_NAME = "order-service";

interface PaymentCompletedData {
  payment_id: string;
  order_id: string;
}

interface PaymentFailedData {
  payment_id: string;
  order_id: string;
  reason: string;
}

/** Race-safe insert: returns true if this event_id was already processed. */
async function alreadyProcessed(pool: Pool, eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [CONSUMER_NAME, eventId],
  );
  return rowCount === 0;
}

export async function startConsumers(
  rabbit: Rabbit,
  pool: Pool,
  service: OrdersService,
): Promise<void> {
  await rabbit.subscribe(["payment.completed", "payment.failed"], async (env: Envelope) => {
    if (await alreadyProcessed(pool, env.event_id)) {
      logger.debug({ event_id: env.event_id }, "duplicate event, skipped");
      return;
    }

    if (env.event_type === "payment.completed") {
      const d = env.data as PaymentCompletedData;
      await service.markPaid(d.order_id);
      logger.info({ order_id: d.order_id, payment_id: d.payment_id }, "order marked paid");
      return;
    }

    if (env.event_type === "payment.failed") {
      const d = env.data as PaymentFailedData;
      try {
        await service.transitionStatus(
          d.order_id,
          "CANCELLED",
          { kind: "system" },
          { reason: d.reason },
        );
        logger.info({ order_id: d.order_id, payment_id: d.payment_id }, "order cancelled");
      } catch (e) {
        // 409 — order is already past PENDING; nothing to do. Anything else re-throws → retry.
        if (e instanceof HttpError && e.status === 409) {
          logger.info(
            { order_id: d.order_id, payment_id: d.payment_id },
            "payment failed but order not cancellable; ignoring",
          );
          return;
        }
        throw e;
      }
    }
  });
}
