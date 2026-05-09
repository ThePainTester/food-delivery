import { Pool } from "pg";

import { OrderStatus } from "../domain/statuses";

export interface OrderItemRow {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price: string; // minor-units-as-string
}

export interface OrderRow {
  id: string;
  customer_id: string;
  restaurant_id: string;
  delivery_user_id: string | null;
  items: OrderItemRow[];
  subtotal_minor: string;
  delivery_fee_minor: string;
  total_minor: string;
  status: OrderStatus;
  paid: boolean;
  delivery_address: string;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrderOwners {
  customer_id: string;
  delivery_user_id: string | null;
  restaurant_id: string;
}

const RETURNING = `id, customer_id, restaurant_id, delivery_user_id, items,
  subtotal_minor::text, delivery_fee_minor::text, total_minor::text,
  status, paid, delivery_address, delivery_latitude, delivery_longitude,
  created_at, updated_at`;

export class OrdersRepo {
  constructor(private pool: Pool) { }

  async create(input: {
    id: string;
    customerId: string;
    restaurantId: string;
    items: OrderItemRow[];
    subtotalMinor: number;
    deliveryFeeMinor: number;
    totalMinor: number;
    deliveryAddress: string;
    deliveryLatitude?: number | null;
    deliveryLongitude?: number | null;
  }): Promise<OrderRow> {
    const { rows } = await this.pool.query<OrderRow>(
      `INSERT INTO orders (
          id, customer_id, restaurant_id, items,
          subtotal_minor, delivery_fee_minor, total_minor,
          status, delivery_address, delivery_latitude, delivery_longitude
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'DRAFT',$8,$9,$10)
       RETURNING ${RETURNING}`,
      [
        input.id,
        input.customerId,
        input.restaurantId,
        JSON.stringify(input.items),
        input.subtotalMinor,
        input.deliveryFeeMinor,
        input.totalMinor,
        input.deliveryAddress,
        input.deliveryLatitude ?? null,
        input.deliveryLongitude ?? null,
      ],
    );
    return rows[0];
  }

  async findById(id: string): Promise<OrderRow | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${RETURNING} FROM orders WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findOwners(id: string): Promise<OrderOwners | null> {
    const { rows } = await this.pool.query<OrderOwners>(
      `SELECT customer_id, delivery_user_id, restaurant_id FROM orders WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listByCustomer(customerId: string): Promise<OrderRow[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${RETURNING} FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId],
    );
    return rows;
  }

  async listByDelivery(deliveryUserId: string): Promise<OrderRow[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${RETURNING} FROM orders WHERE delivery_user_id = $1 ORDER BY created_at DESC`,
      [deliveryUserId],
    );
    return rows;
  }

  async listByRestaurant(restaurantId: string): Promise<OrderRow[]> {
    // DRAFT orders are still in customer checkout — invisible to restaurants.
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${RETURNING} FROM orders
        WHERE restaurant_id = $1 AND status <> 'DRAFT'
        ORDER BY created_at DESC`,
      [restaurantId],
    );
    return rows;
  }

  async setStatus(id: string, target: OrderStatus): Promise<OrderRow | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING ${RETURNING}`,
      [id, target],
    );
    return rows[0] ?? null;
  }

  async markPaid(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE orders SET paid = TRUE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  // Idempotent set: only writes when delivery_user_id is NULL or already
  // matches. Lets duplicate "delivery.assigned" events from dispatch-service
  // be replayed without clobbering an established assignment.
  async setDeliveryUser(id: string, deliveryUserId: string): Promise<OrderRow | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
          SET delivery_user_id = $2, updated_at = NOW()
        WHERE id = $1 AND (delivery_user_id IS NULL OR delivery_user_id = $2)
        RETURNING ${RETURNING}`,
      [id, deliveryUserId],
    );
    return rows[0] ?? null;
  }
}

export { RETURNING as ORDER_COLUMNS };
