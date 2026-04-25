# Compose

Per-environment overlays over a shared `docker-compose.yml` base.

## Layout

| File | Purpose |
|---|---|
| `docker-compose.yml` | Base topology — every service, every dependency, every healthcheck. Image refs use `${REGISTRY}/${IMAGE_TAG}` so overlays decide where bits come from. |
| `docker-compose.dev.yml` | Builds images from `../services/*`, exposes every port to the host, `restart: "no"`. |
| `docker-compose.staging.yml` | Pulls `:staging` images from a registry, exposes only application services + the RabbitMQ UI, `restart: unless-stopped`. |
| `docker-compose.prod.yml` | Pulls pinned `:${IMAGE_TAG}` images, no host port exposure on data stores or the rabbit UI, resource limits + log rotation, `restart: always`. |
| `.env.example` | Template — copy to `.env.dev` / `.env.staging` / `.env.prod`. |
| `scripts/gen-keys.sh` | One-shot RS256 keypair for User Service signing. Writes `jwt/jwt.key` + `jwt/jwt.pub`, both mounted read-only into every service. |

## Topology

Each service owns its own data store (polyglot persistence per the architecture spec):

- `users-db` — Postgres 16
- `orders-db` — Postgres 16 (`orders-cache` Redis alongside)
- `payments-db` — Postgres 16
- `restaurants-db` — MongoDB 7
- `rabbitmq` — shared event bus (the only cross-service infrastructure)

Migrations are applied automatically on first volume init via `docker-entrypoint-initdb.d` — each service's `migrations/` directory is mounted into its own Postgres, so deleting a volume re-applies that service's schema.

## Usage

One-time setup:

```bash
cp compose/.env.example compose/.env.dev
compose/scripts/gen-keys.sh
```

Bring up dev:

```bash
docker compose \
  -f compose/docker-compose.yml \
  -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev \
  up --build
```

Staging / prod work the same way — swap the overlay file and the env file. Prod expects images already pushed to `${REGISTRY}` at tag `${IMAGE_TAG}`; it does not build.

## Dev port map

| Service | Host port |
|---|---|
| user-service | 8081 |
| restaurant-service | 8082 |
| order-service | 8083 |
| payment-service | 8084 |
| users-db | 5433 |
| orders-db | 5434 |
| payments-db | 5435 |
| restaurants-db (Mongo) | 27017 |
| orders-cache (Redis) | 6379 |
| RabbitMQ AMQP / UI | 5672 / 15672 |
