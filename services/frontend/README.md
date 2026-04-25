# Frontend

Static SPA (vanilla JS + Tailwind CDN + Leaflet) served by a tiny
`nginx:alpine` container. **Static only** — no reverse proxying. A stock
Traefik container fronts this and the backend APIs and is the only
component bound to the public network; routing rules live as `traefik.*`
labels in the compose file (see `compose/docker-compose.yml`).

## Stack

- **HTML + Tailwind (CDN) + vanilla JS** — no bundler, no framework. The
  course is ops-focused; everything ships as static files.
- **Leaflet + OpenStreetMap tiles** for live tracking.
- **NGINX 1.27 (alpine)** serves `/usr/share/nginx/html`.

## Routes (hash-based)

| Hash | Role | Purpose |
|---|---|---|
| `#/login`, `#/register` | public | Auth |
| `#/c/restaurants` | customer | Browse restaurants |
| `#/c/restaurants/:id` | customer | Menu + cart, place order |
| `#/c/orders` | customer | Order history |
| `#/c/orders/:id` | customer | Status timeline + live map (polls every 3s while `PICKED_UP`) |
| `#/r/setup` | restaurant | First-run create-restaurant form |
| `#/r/orders` | restaurant | Accept / reject / advance status |
| `#/r/menu` | restaurant | Menu CRUD |
| `#/d/orders` | delivery | Active deliveries + claim form |
| `#/d/orders/:id` | delivery | Mark picked up / delivered, posts GPS every 5s while `PICKED_UP` |

## Auth

JWT lives in `localStorage` under `fd.token`. The role claim drives view
selection. The token is attached as `Authorization: Bearer …` on every
`/api/*` call; Traefik forwards it through. The browser hits
`/api/<service>/...` on the gateway origin — same-origin, no CORS — and
Traefik's `stripprefix` middleware drops `/api` so each backend receives
its native path layout.
