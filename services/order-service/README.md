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

- **Publishes:** `order.placed`, `order.accepted`, `order.rejected`,
  `order.ready`, `order.picked_up`, `order.delivered`, `order.cancelled`,
  `delivery.assigned`.
- **Consumes:** `payment.completed` (marks the order paid),
  `payment.failed` (cancels the order).

## Endpoints
- `POST /orders` — role=customer; validates menu via Restaurant Service, snapshots name/price.
- `GET /orders/:id` — customer / restaurant / assigned delivery.
- `GET /orders?customer_id=|restaurant_id=|delivery_user_id=` — role-scoped.
- `PATCH /orders/:id/status` — role-gated state machine.
- `POST /orders/:id/assign` — role=delivery, self-assign to READY+unassigned order.
- `POST /orders/:id/location` — assigned delivery; writes to Redis (TTL) and publishes on Redis Pub/Sub.
- `GET /orders/:id/location` — customer or restaurant; one-shot read.
- `GET /orders/:id/location/stream` — customer or restaurant; SSE. Pushes the latest fix on connect, then every driver POST as it arrives. Token via `?token=` (EventSource can't set headers).
- `GET /orders/stream` — SSE stream of order-state changes for the calling principal. Customers get their own orders; riders get their own deliveries plus the global `delivery:lobby` channel; restaurants pass `?restaurant_id=` and receive that restaurant's orders (ownership verified). Each event is a small envelope `{event, order_id, status, paid, ...}`; the SPA reacts by refetching whichever list/order it's rendering. Token via `?token=`.
- `GET /healthz`

## Money
Stored as integer minor units (`BIGINT`) in Postgres; converted to/from decimal strings at API boundary.
