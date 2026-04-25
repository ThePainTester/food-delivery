export type OrderStatus =
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
const transitions: Record<OrderStatus, { from: OrderStatus[]; actor: ActorKind }[]> = {
  PENDING: [],
  ACCEPTED: [{ from: ["PENDING"], actor: "restaurant" }],
  REJECTED: [{ from: ["PENDING"], actor: "restaurant" }],
  PREPARING: [{ from: ["ACCEPTED"], actor: "restaurant" }],
  READY: [{ from: ["PREPARING"], actor: "restaurant" }],
  PICKED_UP: [{ from: ["READY"], actor: "delivery" }],
  DELIVERED: [{ from: ["PICKED_UP"], actor: "delivery" }],
  CANCELLED: [
    { from: ["PENDING"], actor: "customer" },
    { from: ["PENDING"], actor: "system" }, // e.g. payment failure
  ],
};

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: ActorKind,
): boolean {
  return transitions[to].some((r) => r.actor === actor && r.from.includes(from));
}
