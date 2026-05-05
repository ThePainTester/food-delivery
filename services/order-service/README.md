# Order Service

Node 20 + TypeScript + Express + Postgres (pg) + Redis (ioredis) + RabbitMQ (amqplib).
Verifies JWTs (RS256) using the shared public key issued by User Service.

## Env
- `PORT` (default 8080)
- `DATABASE_URL` — `postgres://...`
- `REDIS_URL` — `redis://redis:6379`
- `RABBIT_URL` — `amqp://guest:guest@rabbitmq:5672`
- `JWT_PUBLIC_KEY_PATH` — same public key used by User Service
- `JWT_ISSUER` (default `user-service`)
- `RESTAURANT_SERVICE_URL` — e.g. `http://restaurant-service:8080`
- `DELIVERY_FEE_MINOR` (default 3000)
- `LOCATION_TTL_SECONDS` (default 120)

## Events
- **Publishes:** `OrderPlaced`, `OrderStatusChanged`, `OrderAccepted`, `OrderDelivered` on exchange `food_delivery` (topic, routing key = event name).
- **Consumes:** `PaymentCompleted` (logs for now).

## Endpoints
- `POST /orders` — role=customer; validates menu via Restaurant Service, snapshots name/price.
- `GET /orders/:id` — customer / restaurant / assigned delivery.
- `GET /orders?customer_id=|restaurant_id=|delivery_user_id=` — role-scoped.
- `PATCH /orders/:id/status` — role-gated state machine.
- `POST /orders/:id/assign` — role=delivery, self-assign to READY+unassigned order.
- `POST /orders/:id/location` — assigned delivery; writes to Redis (TTL).
- `GET /orders/:id/location` — customer or restaurant.
- `GET /healthz`

## Money
Stored as integer minor units (`BIGINT`) in Postgres; converted to/from decimal strings at API boundary.
