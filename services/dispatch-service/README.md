# dispatch-service

Push-based driver assignment. Replaces the previous "rider self-claims a
READY order from the lobby" pull flow.

## Trigger

`order.accepted` (RabbitMQ topic). The trigger queue is shared across all
dispatch-service replicas as a competing-consumer set; whichever replica
picks up the message tries to acquire a Redis lock and runs the loop.

## Algorithm

```
SET dispatch:lock:{orderId} <instanceId> NX EX 60   ← exclusive ownership
GEOSEARCH drivers:available BYRADIUS pickup 3km ASC ← spatial candidates
filter (HMGET driver:{id} available last_seen)      ← drop stale/off
for driver in ranked:
  SADD order:{orderId}:offered_drivers driver       ← per-cycle dedupe
  PUBLISH dispatch.offers {driverId, orderId, …}    ← broadcast
  await dispatch.responses:{orderId} (≤12s)         ← per-order channel
  if accepted: stop
```

Postgres `assignments.order_id PK` + `INSERT … ON CONFLICT DO NOTHING` is
the only mechanism that decides a winner. Concurrent accepts hit the same
key; rowCount=1 wins, rowCount=0 is a 409. Redis state is purely
ephemeral — losing it never causes a double assignment, only a few
in-flight offers turning into UI-side timeouts.

## Endpoints

All routes live under `/dispatch/*` (the gateway forwards
`/api/dispatch/...` and strips only `/api`).

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/dispatch/drivers/heartbeat` | delivery | `{lat, lon}` — also marks the driver `available`. Posted every ~8s by the driver UI. |
| POST | `/dispatch/drivers/off` | delivery | Removes the driver from the available pool. |
| GET  | `/dispatch/drivers/stream` | delivery | SSE — server pushes `{driverId, orderId, pickup, expires_in_s}` offers and `{type: cancelled}` events. EventSource auth via `?token=`. |
| POST | `/dispatch/assignments/:orderId/accept` | delivery | Postgres INSERT … ON CONFLICT decides; on success runs all side effects (Redis pool, RabbitMQ `delivery.assigned`, broadcast on `dispatch.responses:{orderId}`). |
| POST | `/dispatch/assignments/:orderId/reject` | delivery | Publishes `{driverId, outcome: rejected}` so the loop falls through to the next driver. |
| GET  | `/healthz` | – | Liveness/readiness. |

## State

### Redis

| Key | Type | Purpose |
|---|---|---|
| `drivers:available` | GEOSET | Lon/lat per driver. `GEOADD` on heartbeat; `ZREM` on accept/off. |
| `driver:{id}` | HASH | `lat`, `lon`, `available`, `last_seen` (epoch ms). Filtered against `HEARTBEAT_STALE_MS`. |
| `dispatch:lock:{orderId}` | string + EX 60 | Loop ownership. Compare-and-delete via Lua so a TTL-expired lock acquired by another pod isn't clobbered on release. |
| `order:{orderId}:offered_drivers` | SET | Best-effort dedupe within a single dispatch cycle. Not load-bearing. |
| `dispatch.offers` | pubsub | Broadcast offer fan-in. Every pod subscribes; only the pod that holds the destination driver's SSE delivers. |
| `dispatch.responses:{orderId}` | pubsub | Accept/reject signal back to the loop's pod. |

### Postgres

```sql
CREATE TABLE assignments (
  order_id     UUID PRIMARY KEY,
  driver_id    UUID NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

That's the entire schema. No `offer_attempts`, no `driver_stats` —
analytics-grade telemetry is left to logs.

## Events

- **Consumed:** `order.accepted` (runs the loop), `order.cancelled`
  (publishes a global `{outcome: cancelled}` to
  `dispatch.responses:{orderId}` so the loop's `waitForResponse` resolves
  immediately and the iteration aborts).
- **Published:** `delivery.assigned` (after a successful Postgres INSERT —
  order-service's existing consumer is what writes `orders.driver_id` and
  fans the change out to customer/restaurant/delivery SSE), and
  `dispatch.no_drivers` (informational, when the candidate set is
  exhausted).

## Why it's horizontally scalable

- The trigger queue is competing-consumer; any replica may take the
  message.
- The Redis lock guarantees only one pod runs a loop per order.
- The accept HTTP endpoint can land on any pod. Postgres uniqueness
  enforces the single-writer rule even when accept and the loop are on
  different pods.
- SSE registries are per-pod and local — no sticky sessions. The pod
  holding a given driver's connection is the one that delivers the offer;
  every other pod ignores the broadcast.

## Env vars

| Var | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `DATABASE_URL` | required | |
| `REDIS_URL` | required | |
| `RABBIT_URL` | required | |
| `JWKS_URL` | required | User Service's JWKS endpoint, e.g. `http://user-service:8080/.well-known/jwks.json` |
| `JWT_ISSUER` | `user-service` | |
| `OFFER_TIMEOUT_MS` | 12000 | per-driver wait window |
| `DISPATCH_LOCK_TTL_S` | 60 | lock lifetime |
| `SEARCH_RADIUS_M` | 3000 | candidate radius |
| `HEARTBEAT_STALE_MS` | 30000 | drop drivers older than this |
| `HOSTNAME` | random uuid | used as the lock value (`INSTANCE_ID`) |
