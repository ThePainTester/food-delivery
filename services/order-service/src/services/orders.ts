import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

import { RestaurantClient, RestaurantNotFoundError } from "../clients/restaurants";
import { ActorKind, OrderStatus, Role, canTransition } from "../domain/statuses";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import { minorToDecimal, decimalToMinor } from "../money";
import { Rabbit } from "../rabbit";
import {
  DELIVERY_LOBBY_CHANNEL,
  customerOrdersChannel,
  deliveryOrdersChannel,
  restaurantOrdersChannel,
} from "../redis";
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
  deliveryLatitude?: number | null;
  deliveryLongitude?: number | null;
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
    private redis: Redis,
    private restaurants: RestaurantClient,
    private deliveryFeeMinor: number,
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

  // Fan out a small "order changed" envelope to every Redis Pub/Sub channel
  // whose connected SSE clients should care. Customers always care about
  // their own orders; the restaurant always cares about its orders; the
  // assigned rider (when present) cares about their orders. `delivery.lobby`
  // is the global rider list channel — every rider on the lobby view sees
  // ready orders appear and disappear via this.
  //
  // Best effort — a failed publish should not roll back the persisted state
  // change. Worst case the user's UI stays stale until their next manual
  // navigation.
  private async fanoutOrder(eventType: string, order: OrderRow): Promise<void> {
    const payload = JSON.stringify({
      event: eventType,
      order_id: order.id,
      status: order.status,
      paid: order.paid,
      delivery_user_id: order.delivery_user_id,
      updated_at: new Date().toISOString(),
    });
    const targets = new Set<string>([customerOrdersChannel(order.customer_id)]);
    // DRAFT orders are still in checkout — restaurants and riders should
    // not learn about them yet. Once confirmDraft fires, the next event
    // is published with status=PENDING and the restaurant SSE picks it up.
    if (order.status !== "DRAFT") {
      targets.add(restaurantOrdersChannel(order.restaurant_id));
      if (order.delivery_user_id) {
        targets.add(deliveryOrdersChannel(order.delivery_user_id));
      }
      // The lobby reflects what's claimable / has been claimed. Any of these
      // events changes the lobby's view, so push to it.
      if (
        eventType === "order.ready" ||
        eventType === "delivery.assigned" ||
        eventType === "order.cancelled"
      ) {
        targets.add(DELIVERY_LOBBY_CHANNEL);
      }
    }
    try {
      await Promise.all([...targets].map((ch) => this.redis.publish(ch, payload)));
    } catch (err) {
      logger.warn({ err, eventType, orderId: order.id }, "order fanout failed");
    }
  }

  async createOrder(customerId: string, input: CreateOrderInput): Promise<OrderRow> {
    let menu;
    let restaurant;
    try {
      [restaurant, menu] = await Promise.all([
        this.restaurants.getRestaurant(input.restaurantId),
        this.restaurants.getMenu(input.restaurantId),
      ]);
    } catch (e) {
      if (e instanceof RestaurantNotFoundError) throw notFound("restaurant not found");
      throw e;
    }
    if (!restaurant.is_open) {
      throw badRequest("This restaurant isn't accepting orders right now. Please try again later.");
    }
    const menuById = new Map(menu.map((m) => [m.id, m]));

    const items: OrderItemRow[] = [];
    let subtotalMinor = 0;
    for (const it of input.items) {
      const m = menuById.get(it.menuItemId);
      if (!m) throw badRequest(`menu item ${it.menuItemId} not found`);
      if (!m.is_available) throw badRequest(`menu item ${m.name} not available`);
      const unit = decimalToMinor(m.price);
      subtotalMinor += unit * it.quantity;
      items.push({
        menu_item_id: m.id,
        name: m.name,
        quantity: it.quantity,
        unit_price: String(unit),
      });
    }
    const totalMinor = subtotalMinor + this.deliveryFeeMinor;

    const order = await this.repo.create({
      id: uuidv4(),
      customerId,
      restaurantId: input.restaurantId,
      items,
      subtotalMinor,
      deliveryFeeMinor: this.deliveryFeeMinor,
      totalMinor,
      deliveryAddress: input.deliveryAddress,
      deliveryLatitude: input.deliveryLatitude ?? null,
      deliveryLongitude: input.deliveryLongitude ?? null,
    });

    // DRAFT — only the customer should see it appear in their list. The
    // rabbit `order.placed` event is delayed until confirmDraft (i.e. when
    // payment is actually initiated), so external consumers and the
    // restaurant don't see the order until it's real.
    await this.fanoutOrder("order.draft", order);

    return order;
  }

  // confirmDraft transitions a DRAFT order to PENDING. Triggered by the
  // payment-service event consumer when a payment.pending (cash) or
  // payment.completed (card success) message arrives. No-op if the order
  // is already past DRAFT (idempotent — both events can fire for the same
  // order in unusual orderings).
  async confirmDraft(orderId: string): Promise<OrderRow | null> {
    const o = await this.repo.findById(orderId);
    if (!o) return null;
    if (o.status !== "DRAFT") return o;

    const updated = await this.repo.setStatus(orderId, "PENDING");
    if (!updated) return null;

    await this.rabbit.publish("order.placed", {
      order_id: updated.id,
      customer_id: updated.customer_id,
      restaurant_id: updated.restaurant_id,
      items: updated.items.map((i) => ({
        menu_item_id: i.menu_item_id,
        name: i.name,
        quantity: i.quantity,
        unit_price: Number(minorToDecimal(i.unit_price)),
      })),
      subtotal: Number(minorToDecimal(updated.subtotal_minor)),
      delivery_fee: Number(minorToDecimal(updated.delivery_fee_minor)),
      total: Number(minorToDecimal(updated.total_minor)),
      delivery_address: updated.delivery_address,
    });
    await this.fanoutOrder("order.placed", updated);
    return updated;
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
        if (actor.role === "customer") {
          if (o.customer_id !== actor.userId) throw forbidden("not your order");
        } else if (actor.role === "restaurant") {
          await this.assertRestaurantOwner(o.restaurant_id, actor);
        } else {
          throw forbidden("customer or restaurant role required to cancel");
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
    await this.fanoutOrder(`order.${target.toLowerCase()}`, updated);
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
    await this.fanoutOrder("delivery.assigned", claimed);
    return claimed;
  }

  async markPaid(orderId: string): Promise<void> {
    await this.repo.markPaid(orderId);
    const o = await this.repo.findById(orderId);
    if (o) await this.fanoutOrder("order.paid", o);
  }
}
