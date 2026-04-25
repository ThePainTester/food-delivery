# Payment Service (Mock)

Go + Gin + Postgres + RabbitMQ. Always succeeds. Layered: routes → service → repo + events.

## Env
- `PORT` (default 8080)
- `DATABASE_URL`
- `RABBIT_URL`
- `JWT_PUBLIC_KEY_PATH` — same RSA public key as User Service
- `JWT_ISSUER` (default `user-service`)
- `DEFAULT_PAYMENT_METHOD` (default `mock-card`)

## Behavior
- **Canonical flow:** consumes `order.placed` → creates COMPLETED payment → publishes `payment.completed`. Idempotent on `event_id` and on `order_id` (unique).
- **Refund stubs:** consumes `order.rejected`, `order.cancelled` → logs no-op refund.
- **Never publishes `payment.failed`** in mock mode.

## Endpoints
- `POST /payments` — auth required. Direct creation (mostly for testing the HTTP path).
- `GET /payments/:id` — auth required. Customer of linked order can read; payments without a known customer are readable by any authenticated principal (treated as internal).

## Topology
Service queue base: `payment` (so `payment.events`, `payment.events.retry`, `payment.events.dlq`).
Same retry/DLX pattern as Order Service: 30s retry queue, 3 attempts, fanout DLX.
