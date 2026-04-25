# food-delivery

Polyglot microservices food-delivery platform: User (Go), Restaurant (Python),
Order (Node/TS), Payment (Go mock), a static SPA frontend, and a stock Traefik
gateway that fronts everything.

## Running

One-time setup (per env):

```bash
cp compose/.env.example compose/.env.dev      # then edit COMPOSE_PROJECT_NAME=food-delivery-dev
cp compose/.env.example compose/.env.staging  # COMPOSE_PROJECT_NAME=food-delivery-staging
cp compose/.env.example compose/.env.prod     # COMPOSE_PROJECT_NAME=food-delivery-prod
compose/scripts/gen-keys.sh                   # writes compose/jwt/{jwt.key,jwt.pub}
```

Bring up a single env (dev shown):

```bash
docker compose \
  -f compose/docker-compose.yml \
  -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev \
  up --build
```

Swap the overlay file and the env file for staging/prod. Staging and prod
expect images already pushed to `${REGISTRY}` at the right tag — they don't
build.

## Running all three envs side-by-side

Each env's `COMPOSE_PROJECT_NAME` (set in its `.env.<env>` file) prefixes its
own networks, volumes, and containers, so the three stacks stay isolated.
Published ports also don't collide: dev exposes the gateway on `3000` plus
direct-debug ports on the data stores and service containers; staging exposes
only the gateway on `8080`; prod exposes only `80`/`443`.

Bring all three up in three terminals (or detached):

```bash
# dev
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev up -d --build

# staging
docker compose -f compose/docker-compose.yml -f compose/docker-compose.staging.yml \
  --env-file compose/.env.staging up -d

# prod
docker compose -f compose/docker-compose.yml -f compose/docker-compose.prod.yml \
  --env-file compose/.env.prod up -d
```

Inspect one stack at a time by passing the same `--env-file` (or `-p
<project-name>` together with `COMPOSE_PROJECT_NAME=<project-name>` in the
shell):

```bash
docker compose --env-file compose/.env.staging ps
docker compose --env-file compose/.env.staging logs -f gateway
```

Tear down a single env without touching the others:

```bash
docker compose -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev down -v
```

> Use `--env-file` not `-p` for stack selection. `-p` sets the project name
> for prefixing but does **not** populate `${COMPOSE_PROJECT_NAME}` for
> variable substitution in the compose file, which Traefik relies on. The env
> file feeds both paths from one source.

## Accessing the SPA

| Env | URL | Notes |
|---|---|---|
| Dev     | <http://localhost:3000>     | Traefik dashboard: <http://localhost:8090> |
| Staging | <http://\<host\>:8080>      | gateway only |
| Prod    | <http://\<host\>> / <https://\<host\>> | 80 + 443 published |

In every environment the browser talks only to the **gateway** container
(stock Traefik); the gateway forwards `/api/*` to the backend services and
`/` to the static frontend container, all over the internal compose
network. Routing rules live as `traefik.*` labels on each service in
`compose/docker-compose.yml`. Backend service ports are also published in
dev (8081–8084) for direct testing, but the browser doesn't use them.

See [`compose/README.md`](compose/README.md) for the full port map and
[`services/frontend/README.md`](services/frontend/README.md) for SPA
routes.
