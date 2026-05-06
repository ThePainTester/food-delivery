# Payment Service (Mock)

Go + Gin + Postgres + RabbitMQ. Layered: routes → service → repo + events.
A simulated card gateway lets the demo exercise both success and failure
paths without random flakiness.

## Env
- `PORT` (default 8080)
- `DATABASE_URL`
- `RABBIT_URL`
- `JWT_PUBLIC_KEY_PATH` — same RSA public key as User Service
- `JWT_ISSUER` (default `user-service`)
- `DEFAULT_PAYMENT_METHOD` (default `mock-card`)

## Behavior

**Card payments (entry point: `POST /payments`).** The handler calls a
simulated gateway (`internal/services/gateway.go`) that approves any card
**except** numbers ending in `0000`, which are declined as
`card_declined`. On approval the payment is stored as `COMPLETED` and
`payment.completed` is published. On decline the payment is stored as
`FAILED`, `payment.failed` is published, and the API returns `402
Payment Required` — order-service consumes `payment.failed` and
cancels the order. Idempotent on `order_id` (unique).

**Cash on delivery.** When `method=cash` the gateway is bypassed; the
payment is created as `PENDING` and `payment.pending` is published. The
delivery rider settles it on arrival via
`POST /payments/by-order/:orderId/collect`, which flips it to
`COMPLETED` and publishes `payment.completed`.

**Refund stubs.** Consumes `order.rejected` and `order.cancelled` →
logs a no-op refund (kept here so the wire-up is end-to-end).
`order.placed` is **not** consumed — charge initiation is now
synchronous from the SPA.

## Endpoints

All under `/payments`, auth required.

- `POST /payments` — create a payment for an order. Card flow runs the
  gateway synchronously; `402` on decline.
- `GET /payments/by-order/:orderId` — fetch a payment by order id.
- `POST /payments/by-order/:orderId/collect` — role=`delivery`. Marks
  the order's cash payment as `COMPLETED`.
- `GET /payments/:id` — owning customer (or system) only.
- `GET /healthz`, `GET /metrics`.

## Events

- **Publishes:** `payment.pending` (cash), `payment.completed`,
  `payment.failed`.
- **Consumes:** `order.rejected`, `order.cancelled` (refund stubs).

## Topology

Service queue base: `payment` (so `payment.events`,
`payment.events.retry`, `payment.events.dlq`). Same retry/DLX pattern
as Order Service: 30s retry queue, 3 attempts, fanout DLX.
