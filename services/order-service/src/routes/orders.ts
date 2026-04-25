import { Router } from "express";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { Principal, requireAuth, requireRole } from "../auth/jwt";
import { RestaurantClient, RestaurantNotFoundError } from "../clients/restaurants";
import { OrderStatus, canTransition } from "../domain/statuses";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { Rabbit } from "../rabbit";

interface Deps {
  pool: Pool;
  rabbit: Rabbit;
  restaurants: RestaurantClient;
  jwt: { publicKey: Buffer; issuer: string };
  deliveryFeeCents: number;
}

interface OrderItemRow {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price: string; // cents-as-string
}

interface OrderRow {
  id: string;
  customer_id: string;
  restaurant_id: string;
  delivery_user_id: string | null;
  items: OrderItemRow[];
  subtotal_cents: string;
  delivery_fee_cents: string;
  total_cents: string;
  status: OrderStatus;
  paid: boolean;
  delivery_address: string;
  created_at: string;
  updated_at: string;
}

const ORDER_RETURNING = `id, customer_id, restaurant_id, delivery_user_id, items,
  subtotal_cents::text, delivery_fee_cents::text, total_cents::text,
  status, paid, delivery_address, created_at, updated_at`;

function toApi(r: OrderRow) {
  return {
    id: r.id,
    customer_id: r.customer_id,
    restaurant_id: r.restaurant_id,
    delivery_user_id: r.delivery_user_id,
    items: r.items.map((i) => ({
      menu_item_id: i.menu_item_id,
      name: i.name,
      quantity: i.quantity,
      unit_price: centsToDecimal(i.unit_price),
    })),
    subtotal: centsToDecimal(r.subtotal_cents),
    delivery_fee: centsToDecimal(r.delivery_fee_cents),
    total: centsToDecimal(r.total_cents),
    status: r.status,
    paid: r.paid,
    delivery_address: r.delivery_address,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function centsToDecimal(cents: string | number): string {
  const n = BigInt(typeof cents === "number" ? Math.trunc(cents) : cents);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

function decimalToCents(v: string | number): number {
  const n = Number(v);
  if (!isFinite(n)) throw new Error(`invalid decimal: ${v}`);
  return Math.round(n * 100);
}

const createOrderSchema = z.object({
  restaurant_id: z.string().uuid(),
  items: z
    .array(
      z.object({
        menu_item_id: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  delivery_address: z.string().min(1),
});

const patchStatusSchema = z.object({
  status: z.enum([
    "ACCEPTED",
    "REJECTED",
    "PREPARING",
    "READY",
    "PICKED_UP",
    "DELIVERED",
    "CANCELLED",
  ]),
  reason: z.string().optional(),
});

async function fetchOrder(pool: Pool, id: string): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT ${ORDER_RETURNING} FROM orders WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Ensure the principal owns the given restaurant; throws on mismatch. */
async function assertRestaurantOwner(
  restaurants: RestaurantClient,
  restaurantId: string,
  p: Principal,
): Promise<void> {
  const ownerId = await restaurants.getOwnerId(restaurantId, p.rawToken);
  if (ownerId === null) throw notFound("restaurant not found");
  if (ownerId !== p.userId) throw forbidden("not restaurant owner");
}

export function ordersRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

  // POST /orders — customer creates an order
  r.post("/", auth, requireRole("customer"), async (req, res, next) => {
    try {
      const body = createOrderSchema.parse(req.body);

      let menu;
      try {
        menu = await deps.restaurants.getMenu(body.restaurant_id);
      } catch (e) {
        if (e instanceof RestaurantNotFoundError) throw notFound("restaurant not found");
        throw e;
      }
      const menuById = new Map(menu.map((m) => [m.id, m]));

      const items: OrderItemRow[] = [];
      let subtotalCents = 0;
      for (const it of body.items) {
        const m = menuById.get(it.menu_item_id);
        if (!m) throw badRequest(`menu item ${it.menu_item_id} not found`);
        if (!m.is_available) throw badRequest(`menu item ${m.name} not available`);
        const unit = decimalToCents(m.price);
        subtotalCents += unit * it.quantity;
        items.push({
          menu_item_id: m.id,
          name: m.name,
          quantity: it.quantity,
          unit_price: String(unit),
        });
      }
      const totalCents = subtotalCents + deps.deliveryFeeCents;

      const id = uuidv4();
      const { rows } = await deps.pool.query<OrderRow>(
        `INSERT INTO orders (
            id, customer_id, restaurant_id, items,
            subtotal_cents, delivery_fee_cents, total_cents,
            status, delivery_address
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'PENDING',$8)
         RETURNING ${ORDER_RETURNING}`,
        [
          id,
          req.principal!.userId,
          body.restaurant_id,
          JSON.stringify(items),
          subtotalCents,
          deps.deliveryFeeCents,
          totalCents,
          body.delivery_address,
        ],
      );
      const order = rows[0];

      await deps.rabbit.publish("order.placed", {
        order_id: order.id,
        customer_id: order.customer_id,
        restaurant_id: order.restaurant_id,
        items: order.items.map((i) => ({
          menu_item_id: i.menu_item_id,
          name: i.name,
          quantity: i.quantity,
          unit_price: Number(centsToDecimal(i.unit_price)),
        })),
        subtotal: Number(centsToDecimal(order.subtotal_cents)),
        delivery_fee: Number(centsToDecimal(order.delivery_fee_cents)),
        total: Number(centsToDecimal(order.total_cents)),
        delivery_address: order.delivery_address,
      });
      res.status(201).json(toApi(order));
    } catch (e) {
      if (e instanceof z.ZodError) return next(badRequest(e.errors.map((x) => x.message).join("; ")));
      next(e);
    }
  });

  // GET /orders/:id
  r.get("/:id", auth, async (req, res, next) => {
    try {
      const o = await fetchOrder(deps.pool, req.params.id);
      if (!o) throw notFound("order not found");
      const p = req.principal!;
      if (p.role === "customer") {
        if (o.customer_id !== p.userId) throw forbidden("not allowed");
      } else if (p.role === "delivery") {
        if (o.delivery_user_id !== p.userId) throw forbidden("not allowed");
      } else if (p.role === "restaurant") {
        await assertRestaurantOwner(deps.restaurants, o.restaurant_id, p);
      } else {
        throw forbidden("unknown role");
      }
      res.json(toApi(o));
    } catch (e) {
      next(e);
    }
  });

  // GET /orders — role-scoped listing
  r.get("/", auth, async (req, res, next) => {
    try {
      const p = req.principal!;
      const q = req.query;
      let sql: string;
      let args: unknown[];

      if (p.role === "customer") {
        if (q.customer_id && q.customer_id !== p.userId) throw forbidden("cannot query other customers");
        sql = `WHERE customer_id = $1`;
        args = [p.userId];
      } else if (p.role === "delivery") {
        if (q.delivery_user_id && q.delivery_user_id !== p.userId) throw forbidden("cannot query other delivery users");
        sql = `WHERE delivery_user_id = $1`;
        args = [p.userId];
      } else if (p.role === "restaurant") {
        if (!q.restaurant_id) throw badRequest("restaurant_id query param required");
        const restaurantId = String(q.restaurant_id);
        await assertRestaurantOwner(deps.restaurants, restaurantId, p);
        sql = `WHERE restaurant_id = $1`;
        args = [restaurantId];
      } else {
        throw forbidden("unknown role");
      }

      const { rows } = await deps.pool.query<OrderRow>(
        `SELECT ${ORDER_RETURNING} FROM orders ${sql} ORDER BY created_at DESC`,
        args,
      );
      res.json(rows.map(toApi));
    } catch (e) {
      next(e);
    }
  });

  // PATCH /orders/:id/status
  r.patch("/:id/status", auth, async (req, res, next) => {
    try {
      const body = patchStatusSchema.parse(req.body);
      const target = body.status as OrderStatus;

      const o = await fetchOrder(deps.pool, req.params.id);
      if (!o) throw notFound("order not found");
      const p = req.principal!;

      // Per-target authorization.
      if (["ACCEPTED", "REJECTED", "PREPARING", "READY"].includes(target)) {
        if (p.role !== "restaurant") throw forbidden("restaurant role required");
        await assertRestaurantOwner(deps.restaurants, o.restaurant_id, p);
      } else if (["PICKED_UP", "DELIVERED"].includes(target)) {
        if (p.role !== "delivery" || o.delivery_user_id !== p.userId) {
          throw forbidden("must be assigned delivery user");
        }
      } else if (target === "CANCELLED") {
        if (p.role !== "customer" || o.customer_id !== p.userId) {
          throw forbidden("only the customer can cancel");
        }
      }

      if (!canTransition(o.status, target, p.role)) {
        throw conflict(`cannot transition ${o.status} -> ${target}`);
      }

      const { rows } = await deps.pool.query<OrderRow>(
        `UPDATE orders SET status = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING ${ORDER_RETURNING}`,
        [o.id, target],
      );
      const updated = rows[0];

      const now = new Date().toISOString();
      switch (target) {
        case "ACCEPTED":
          await deps.rabbit.publish("order.accepted", {
            order_id: updated.id,
            customer_id: updated.customer_id,
            restaurant_id: updated.restaurant_id,
            accepted_at: now,
          });
          break;
        case "REJECTED":
          await deps.rabbit.publish("order.rejected", {
            order_id: updated.id,
            customer_id: updated.customer_id,
            restaurant_id: updated.restaurant_id,
            reason: body.reason ?? null,
          });
          break;
        case "READY":
          await deps.rabbit.publish("order.ready", {
            order_id: updated.id,
            restaurant_id: updated.restaurant_id,
            delivery_address: updated.delivery_address,
          });
          break;
        case "PICKED_UP":
          await deps.rabbit.publish("order.picked_up", {
            order_id: updated.id,
            customer_id: updated.customer_id,
            delivery_user_id: updated.delivery_user_id!,
            picked_up_at: now,
          });
          break;
        case "DELIVERED":
          await deps.rabbit.publish("order.delivered", {
            order_id: updated.id,
            customer_id: updated.customer_id,
            restaurant_id: updated.restaurant_id,
            delivery_user_id: updated.delivery_user_id!,
            delivered_at: now,
          });
          break;
        case "CANCELLED":
          await deps.rabbit.publish("order.cancelled", {
            order_id: updated.id,
            customer_id: updated.customer_id,
            restaurant_id: updated.restaurant_id,
            cancelled_by: p.role,
            cancelled_at: now,
          });
          break;
      }
      res.json(toApi(updated));
    } catch (e) {
      if (e instanceof z.ZodError) return next(badRequest(e.errors.map((x) => x.message).join("; ")));
      next(e);
    }
  });

  // POST /orders/:id/assign — delivery self-assigns to a READY, unassigned order
  r.post("/:id/assign", auth, requireRole("delivery"), async (req, res, next) => {
    try {
      const { rows } = await deps.pool.query<OrderRow>(
        `UPDATE orders
            SET delivery_user_id = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'READY' AND delivery_user_id IS NULL
          RETURNING ${ORDER_RETURNING}`,
        [req.params.id, req.principal!.userId],
      );
      if (rows.length === 0) {
        const o = await fetchOrder(deps.pool, req.params.id);
        if (!o) throw notFound("order not found");
        throw conflict("order not available for assignment");
      }
      const order = rows[0];
      await deps.rabbit.publish("delivery.assigned", {
        order_id: order.id,
        delivery_user_id: order.delivery_user_id!,
        assigned_at: new Date().toISOString(),
      });
      res.json(toApi(order));
    } catch (e) {
      next(e);
    }
  });

  return r;
}
