# Order Service

Node 20 + TypeScript + Express + Postgres (pg) + Redis (ioredis) + RabbitMQ (amqplib).
Verifies JWTs (RS256) against User Service's JWKS endpoint (keys fetched and cached locally).

## Env
- `PORT` (default 8080)
- `DATABASE_URL` — `postgres://...`
- `REDIS_URL` — `redis://redis:6379`
- `RABBIT_URL` — `amqp://guest:guest@rabbitmq:5672`
- `JWKS_URL` — User Service's JWKS endpoint, e.g. `http://user-service:8080/.well-known/jwks.json`
- `JWT_ISSUER` (default `user-service`)
- `RESTAURANT_SERVICE_URL` — e.g. `http://restaurant-service:8080`
- `DELIVERY_FEE_MINOR` (default 3000)
- `LOCATION_TTL_SECONDS` (default 120)

## Events

Topic exchange `food_delivery`; routing key = event name.

- **Publishes:** `order.placed` (on `DRAFT → PENDING`), `order.accepted`
  (carries `pickup_location` for dispatch-service), `order.rejected`,
  `order.ready`, `order.picked_up`, `order.delivered`, `order.cancelled`.
- **Consumes:** `payment.pending` and `payment.completed` (both move
  `DRAFT → PENDING`; `payment.completed` also marks the order paid),
  `payment.failed` (cancels the order), `delivery.assigned` (writes
  `orders.driver_id` and fans out to the SSE channels — the publish itself
  comes from dispatch-service).

Driver assignment is handled by **dispatch-service** (push-based offer loop),
not here; this service just records the assignment when `delivery.assigned`
arrives.

## Endpoints
- `POST /orders` — role=customer; validates menu via Restaurant Service, snapshots name/price. Order starts in `DRAFT`.
- `GET /orders/:id` — customer / restaurant / assigned delivery.
- `GET /orders?customer_id=|restaurant_id=|delivery_user_id=` — role-scoped.
- `PATCH /orders/:id/status` — role-gated state machine (restaurant advances accept→preparing→ready; the assigned rider does picked_up→delivered).
- `POST /orders/:id/location` — assigned delivery; writes to Redis (TTL) and publishes on Redis Pub/Sub.
- `GET /orders/:id/location` — customer or restaurant; one-shot read.
- `GET /orders/:id/location/stream` — customer or restaurant; SSE. Pushes the latest fix on connect, then every driver POST as it arrives.
- `GET /orders/stream` — SSE stream of order-state changes for the calling principal. Customers get their own orders; riders get their own deliveries; restaurants pass `?restaurant_id=` and receive that restaurant's orders (ownership verified). Each event is a small envelope `{event, order_id, status, paid, ...}`; the SPA reacts by refetching whichever list/order it's rendering.
- `GET /healthz`

Both SSE routes authenticate with the standard `Authorization: Bearer` header — the SPA reads them over `fetch()` (via `@microsoft/fetch-event-source`), not native `EventSource`.

## Money
Stored as integer minor units (`BIGINT`) in Postgres; converted to/from decimal strings at API boundary.
