import { v4 as uuidv4 } from "uuid";

import { RestaurantClient, RestaurantNotFoundError } from "../clients/restaurants";
import { ActorKind, OrderStatus, Role, canTransition } from "../domain/statuses";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { centsToDecimal, decimalToCents } from "../money";
import { Rabbit } from "../rabbit";
import { OrderItemRow, OrderRow, OrdersRepo } from "../repositories/orders";

export type Actor =
  | { kind: "user"; role: Role; userId: string; rawToken: string }
  | { kind: "system" };

const userActorKind = (a: Actor): ActorKind =>
  a.kind === "system" ? "system" : a.role;

export interface CreateOrderInput {
  restaurantId: string;
  items: { menuItemId: string; quantity: number }[];
  deliveryAddress: string;
}

export interface ListQuery {
  customerId?: string;
  restaurantId?: string;
  deliveryUserId?: string;
}

export class OrdersService {
  constructor(
    private repo: OrdersRepo,
    private rabbit: Rabbit,
    private restaurants: RestaurantClient,
    private deliveryFeeCents: number,
  ) {}

  /** Throws if the user is not the owner of the given restaurant. */
  private async assertRestaurantOwner(
    restaurantId: string,
    actor: Extract<Actor, { kind: "user" }>,
  ): Promise<void> {
    const ownerId = await this.restaurants.getOwnerId(restaurantId, actor.rawToken);
    if (ownerId === null) throw notFound("restaurant not found");
    if (ownerId !== actor.userId) throw forbidden("not restaurant owner");
  }

  async createOrder(customerId: string, input: CreateOrderInput): Promise<OrderRow> {
    let menu;
    try {
      menu = await this.restaurants.getMenu(input.restaurantId);
    } catch (e) {
      if (e instanceof RestaurantNotFoundError) throw notFound("restaurant not found");
      throw e;
    }
    const menuById = new Map(menu.map((m) => [m.id, m]));

    const items: OrderItemRow[] = [];
    let subtotalCents = 0;
    for (const it of input.items) {
      const m = menuById.get(it.menuItemId);
      if (!m) throw badRequest(`menu item ${it.menuItemId} not found`);
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
    const totalCents = subtotalCents + this.deliveryFeeCents;

    const order = await this.repo.create({
      id: uuidv4(),
      customerId,
      restaurantId: input.restaurantId,
      items,
      subtotalCents,
      deliveryFeeCents: this.deliveryFeeCents,
      totalCents,
      deliveryAddress: input.deliveryAddress,
    });

    await this.rabbit.publish("order.placed", {
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

    return order;
  }

  async getOrder(orderId: string, actor: Actor): Promise<OrderRow> {
    const o = await this.repo.findById(orderId);
    if (!o) throw notFound("order not found");
    if (actor.kind === "system") return o;

    if (actor.role === "customer") {
      if (o.customer_id !== actor.userId) throw forbidden("not allowed");
    } else if (actor.role === "delivery") {
      if (o.delivery_user_id !== actor.userId) throw forbidden("not allowed");
    } else if (actor.role === "restaurant") {
      await this.assertRestaurantOwner(o.restaurant_id, actor);
    } else {
      throw forbidden("unknown role");
    }
    return o;
  }

  async listOrders(actor: Actor, query: ListQuery): Promise<OrderRow[]> {
    if (actor.kind === "system") throw forbidden("system actor cannot list");

    if (actor.role === "customer") {
      if (query.customerId && query.customerId !== actor.userId) {
        throw forbidden("cannot query other customers");
      }
      return this.repo.listByCustomer(actor.userId);
    }
    if (actor.role === "delivery") {
      if (query.deliveryUserId && query.deliveryUserId !== actor.userId) {
        throw forbidden("cannot query other delivery users");
      }
      return this.repo.listByDelivery(actor.userId);
    }
    if (actor.role === "restaurant") {
      if (!query.restaurantId) throw badRequest("restaurant_id query param required");
      await this.assertRestaurantOwner(query.restaurantId, actor);
      return this.repo.listByRestaurant(query.restaurantId);
    }
    throw forbidden("unknown role");
  }

  async transitionStatus(
    orderId: string,
    target: OrderStatus,
    actor: Actor,
    opts: { reason?: string | null } = {},
  ): Promise<OrderRow> {
    const o = await this.repo.findById(orderId);
    if (!o) throw notFound("order not found");

    // Per-target authorization (above and beyond state-machine rules).
    if (actor.kind === "user") {
      if (["ACCEPTED", "REJECTED", "PREPARING", "READY"].includes(target)) {
        if (actor.role !== "restaurant") throw forbidden("restaurant role required");
        await this.assertRestaurantOwner(o.restaurant_id, actor);
      } else if (["PICKED_UP", "DELIVERED"].includes(target)) {
        if (actor.role !== "delivery" || o.delivery_user_id !== actor.userId) {
          throw forbidden("must be assigned delivery user");
        }
      } else if (target === "CANCELLED") {
        if (actor.role !== "customer" || o.customer_id !== actor.userId) {
          throw forbidden("only the customer can cancel");
        }
      }
    }
    // System actor is only used for CANCELLED (e.g., payment.failed); state-machine guards below.

    if (!canTransition(o.status, target, userActorKind(actor))) {
      throw conflict(`cannot transition ${o.status} -> ${target}`);
    }

    const updated = await this.repo.setStatus(o.id, target);
    if (!updated) throw notFound("order not found"); // race

    const now = new Date().toISOString();
    switch (target) {
      case "ACCEPTED":
        await this.rabbit.publish("order.accepted", {
          order_id: updated.id,
          customer_id: updated.customer_id,
          restaurant_id: updated.restaurant_id,
          accepted_at: now,
        });
        break;
      case "REJECTED":
        await this.rabbit.publish("order.rejected", {
          order_id: updated.id,
          customer_id: updated.customer_id,
          restaurant_id: updated.restaurant_id,
          reason: opts.reason ?? null,
        });
        break;
      case "READY":
        await this.rabbit.publish("order.ready", {
          order_id: updated.id,
          restaurant_id: updated.restaurant_id,
          delivery_address: updated.delivery_address,
        });
        break;
      case "PICKED_UP":
        await this.rabbit.publish("order.picked_up", {
          order_id: updated.id,
          customer_id: updated.customer_id,
          delivery_user_id: updated.delivery_user_id!,
          picked_up_at: now,
        });
        break;
      case "DELIVERED":
        await this.rabbit.publish("order.delivered", {
          order_id: updated.id,
          customer_id: updated.customer_id,
          restaurant_id: updated.restaurant_id,
          delivery_user_id: updated.delivery_user_id!,
          delivered_at: now,
        });
        break;
      case "CANCELLED":
        await this.rabbit.publish("order.cancelled", {
          order_id: updated.id,
          customer_id: updated.customer_id,
          restaurant_id: updated.restaurant_id,
          cancelled_by: actor.kind === "system" ? "system" : actor.role,
          cancelled_at: now,
          reason: opts.reason ?? null,
        });
        break;
    }
    return updated;
  }

  async assignDelivery(orderId: string, deliveryUserId: string): Promise<OrderRow> {
    const claimed = await this.repo.claimDelivery(orderId, deliveryUserId);
    if (!claimed) {
      const o = await this.repo.findById(orderId);
      if (!o) throw notFound("order not found");
      throw conflict("order not available for assignment");
    }
    await this.rabbit.publish("delivery.assigned", {
      order_id: claimed.id,
      delivery_user_id: claimed.delivery_user_id!,
      assigned_at: new Date().toISOString(),
    });
    return claimed;
  }

  async markPaid(orderId: string): Promise<void> {
    await this.repo.markPaid(orderId);
  }
}
