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
| Dev     | <http://localhost:8080> |
| Staging | <http://\<host\>>      (NGINX bound on port 80) |
| Prod    | <http://\<host\>> / <https://\<host\>>  (80 + 443 published) |

In every environment the browser only talks to the frontend container; it
proxies `/api/*` to the backend services on the internal compose network.
Backend service ports are still published in dev/staging for direct testing
but the SPA does not need them.

See [`compose/README.md`](compose/README.md) for the full port map and
[`services/frontend/README.md`](services/frontend/README.md) for SPA route
and reverse-proxy details.
