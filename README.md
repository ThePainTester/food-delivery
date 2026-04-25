# food-delivery

Polyglot microservices food-delivery platform: User (Go), Restaurant (Python),
Order (Node/TS), Payment (Go mock), and a static SPA frontend served by NGINX
that doubles as the reverse proxy to all four services.

## Running

One-time setup:

```bash
cp compose/.env.example compose/.env.dev
compose/scripts/gen-keys.sh
```

Bring everything up (dev):

```bash
docker compose \
  -f compose/docker-compose.yml \
  -f compose/docker-compose.dev.yml \
  --env-file compose/.env.dev \
  up --build
```

## Accessing the SPA

| Env | URL |
|---|---|
| Dev     | <http://localhost:3000> |
| Staging | <http://\<host\>:8080>  |
| Prod    | <http://\<host\>> / <https://\<host\>>  (80 + 443 published) |

In every environment the browser talks only to the **gateway** container
(stock Traefik); the gateway forwards `/api/*` to the backend services and
`/` to the static frontend container, all over the internal compose
network. Routing rules live as `traefik.*` labels on each service in
`compose/docker-compose.yml`. In dev the Traefik dashboard is available at
<http://localhost:8090>. Backend service ports are still published in
dev/staging for direct testing but the browser does not use them.

See [`compose/README.md`](compose/README.md) for the full port map and
[`services/frontend/README.md`](services/frontend/README.md) for SPA
routes.
