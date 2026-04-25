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

// Allowed transitions: target status → (from statuses, allowed role)
const transitions: Record<OrderStatus, { from: OrderStatus[]; role: Role }[]> = {
  PENDING: [],
  ACCEPTED: [{ from: ["PENDING"], role: "restaurant" }],
  REJECTED: [{ from: ["PENDING"], role: "restaurant" }],
  PREPARING: [{ from: ["ACCEPTED"], role: "restaurant" }],
  READY: [{ from: ["PREPARING"], role: "restaurant" }],
  PICKED_UP: [{ from: ["READY"], role: "delivery" }],
  DELIVERED: [{ from: ["PICKED_UP"], role: "delivery" }],
  CANCELLED: [{ from: ["PENDING"], role: "customer" }],
};

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  role: Role,
): boolean {
  const rules = transitions[to];
  return rules.some((r) => r.role === role && r.from.includes(from));
}
