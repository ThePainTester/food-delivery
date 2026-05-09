export type OrderStatus =
  | "DRAFT"
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "PREPARING"
  | "READY"
  | "PICKED_UP"
  | "DELIVERED"
  | "CANCELLED";

export type Role = "customer" | "restaurant" | "delivery";
export type ActorKind = Role | "system";

// Allowed transitions: target → list of (from-states, allowed actor-kind).
//
// DRAFT is the initial state for a freshly placed cart: the customer hasn't
// yet committed to a payment method. Restaurants don't see DRAFT orders.
// payment-service triggers DRAFT → PENDING via payment.pending (cash) or
// payment.completed (card success). Customer can abandon a DRAFT
// (customer → CANCELLED).
const transitions: Record<OrderStatus, { from: OrderStatus[]; actor: ActorKind }[]> = {
  DRAFT: [],
  PENDING: [{ from: ["DRAFT"], actor: "system" }],
  ACCEPTED: [{ from: ["PENDING"], actor: "restaurant" }],
  REJECTED: [{ from: ["PENDING"], actor: "restaurant" }],
  PREPARING: [{ from: ["ACCEPTED"], actor: "restaurant" }],
  READY: [{ from: ["PREPARING"], actor: "restaurant" }],
  PICKED_UP: [{ from: ["READY"], actor: "delivery" }],
  DELIVERED: [{ from: ["PICKED_UP"], actor: "delivery" }],
  CANCELLED: [
    { from: ["DRAFT", "PENDING"], actor: "customer" },
    { from: ["DRAFT", "PENDING"], actor: "system" }, // payment failure or GC
    { from: ["PENDING", "ACCEPTED", "PREPARING", "READY"], actor: "restaurant" },
  ],
};

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: ActorKind,
): boolean {
  return transitions[to].some((r) => r.actor === actor && r.from.includes(from));
}
