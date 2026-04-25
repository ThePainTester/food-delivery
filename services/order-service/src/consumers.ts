import { Pool } from "pg";

import { logger } from "./logger";
import { Envelope, Rabbit } from "./rabbit";

const CONSUMER_NAME = "order-service";

interface PaymentCompletedData {
  payment_id: string;
  order_id: string;
  amount: number;
  method: string;
  completed_at: string;
}

interface PaymentFailedData {
  payment_id: string;
  order_id: string;
  reason: string;
  failed_at: string;
}

/**
 * Returns true if the event was already processed (and thus should be skipped).
 * Otherwise records it and returns false. Single-statement so it's race-safe.
 */
async function alreadyProcessed(pool: Pool, eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [CONSUMER_NAME, eventId],
  );
  return rowCount === 0;
}

export async function startConsumers(rabbit: Rabbit, pool: Pool): Promise<void> {
  await rabbit.subscribe(["payment.completed", "payment.failed"], async (env: Envelope) => {
    if (await alreadyProcessed(pool, env.event_id)) {
      logger.debug({ event_id: env.event_id }, "duplicate event, skipped");
      return;
    }

    if (env.event_type === "payment.completed") {
      const d = env.data as PaymentCompletedData;
      await pool.query(
        `UPDATE orders SET paid = TRUE, updated_at = NOW() WHERE id = $1`,
        [d.order_id],
      );
      logger.info({ order_id: d.order_id, payment_id: d.payment_id }, "order marked paid");
    } else if (env.event_type === "payment.failed") {
      const d = env.data as PaymentFailedData;
      // Auto-cancel the order if payment failed (only if still PENDING).
      const { rowCount } = await pool.query(
        `UPDATE orders SET status = 'CANCELLED', updated_at = NOW()
          WHERE id = $1 AND status = 'PENDING'`,
        [d.order_id],
      );
      logger.info(
        { order_id: d.order_id, payment_id: d.payment_id, cancelled: rowCount },
        "payment failed → order cancellation attempted",
      );
      if (rowCount && rowCount > 0) {
        await rabbit.publish("order.cancelled", {
          order_id: d.order_id,
          cancelled_by: "system",
          cancelled_at: new Date().toISOString(),
          reason: d.reason,
        });
      }
    }
  });
}
