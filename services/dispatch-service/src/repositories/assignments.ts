import { Pool } from "pg";

export interface AssignmentInsertResult {
  inserted: boolean;
}

export class AssignmentsRepo {
  constructor(private pool: Pool) {}

  // The single authority for ownership of an order. Returns `inserted: true`
  // only for the first successful caller; subsequent callers (concurrent
  // accept, retry of a successful accept) return `inserted: false` and the
  // handler maps that to 409 with no side effects.
  async tryClaim(orderId: string, driverId: string): Promise<AssignmentInsertResult> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO assignments (order_id, driver_id)
         VALUES ($1, $2)
         ON CONFLICT (order_id) DO NOTHING`,
      [orderId, driverId],
    );
    return { inserted: rowCount === 1 };
  }
}
