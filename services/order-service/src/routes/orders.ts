import { Router } from "express";
import { z } from "zod";

import { JwtConfig, Principal, requireAuth, requireRole } from "../auth/jwt";
import { OrderStatus } from "../domain/statuses";
import { badRequest } from "../errors";
import { minorToDecimal } from "../money";
import { OrderRow } from "../repositories/orders";
import { Actor, OrdersService } from "../services/orders";

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
  delivery_latitude: z.number().min(-90).max(90).optional(),
  delivery_longitude: z.number().min(-180).max(180).optional(),
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

const userActor = (p: Principal): Actor => ({
  kind: "user",
  role: p.role,
  userId: p.userId,
  rawToken: p.rawToken,
});

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
      unit_price: minorToDecimal(i.unit_price),
    })),
    subtotal: minorToDecimal(r.subtotal_minor),
    delivery_fee: minorToDecimal(r.delivery_fee_minor),
    total: minorToDecimal(r.total_minor),
    status: r.status,
    paid: r.paid,
    delivery_address: r.delivery_address,
    delivery_latitude: r.delivery_latitude,
    delivery_longitude: r.delivery_longitude,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

interface Deps {
  service: OrdersService;
  jwt: JwtConfig;
}

export function ordersRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps.jwt);

  r.post("/", auth, requireRole("customer"), async (req, res, next) => {
    try {
      const body = createOrderSchema.parse(req.body);
      const order = await deps.service.createOrder(req.principal!.userId, {
        restaurantId: body.restaurant_id,
        items: body.items.map((i) => ({ menuItemId: i.menu_item_id, quantity: i.quantity })),
        deliveryAddress: body.delivery_address,
        deliveryLatitude: body.delivery_latitude ?? null,
        deliveryLongitude: body.delivery_longitude ?? null,
      });
      res.status(201).json(toApi(order));
    } catch (e) {
      if (e instanceof z.ZodError) return next(badRequest(e.errors.map((x) => x.message).join("; ")));
      next(e);
    }
  });

  r.get("/:id", auth, async (req, res, next) => {
    try {
      const order = await deps.service.getOrder(req.params.id, userActor(req.principal!));
      res.json(toApi(order));
    } catch (e) {
      next(e);
    }
  });

  r.get("/", auth, async (req, res, next) => {
    try {
      const orders = await deps.service.listOrders(userActor(req.principal!), {
        customerId: req.query.customer_id ? String(req.query.customer_id) : undefined,
        restaurantId: req.query.restaurant_id ? String(req.query.restaurant_id) : undefined,
        deliveryUserId: req.query.delivery_user_id ? String(req.query.delivery_user_id) : undefined,
      });
      res.json(orders.map(toApi));
    } catch (e) {
      next(e);
    }
  });

  r.patch("/:id/status", auth, async (req, res, next) => {
    try {
      const body = patchStatusSchema.parse(req.body);
      const order = await deps.service.transitionStatus(
        req.params.id,
        body.status as OrderStatus,
        userActor(req.principal!),
        { reason: body.reason },
      );
      res.json(toApi(order));
    } catch (e) {
      if (e instanceof z.ZodError) return next(badRequest(e.errors.map((x) => x.message).join("; ")));
      next(e);
    }
  });

  return r;
}
