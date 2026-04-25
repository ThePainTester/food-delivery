# Frontend

Static SPA (vanilla JS + Tailwind CDN + Leaflet) served by NGINX. The same
container also reverse-proxies `/api/*` to the four backend services so the
browser only sees same-origin traffic.

## Stack

- **HTML + Tailwind (CDN) + vanilla JS** — no bundler, no framework. The
  course is ops-focused; everything ships as static files.
- **Leaflet + OpenStreetMap tiles** for live tracking.
- **NGINX 1.27 (alpine)** serves `/usr/share/nginx/html` and proxies `/api/*`.

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

## Reverse proxy map

```
/api/auth/*         -> ${USER_SERVICE_HOST}:${USER_SERVICE_PORT}/auth/*
/api/users/*        -> ${USER_SERVICE_HOST}:${USER_SERVICE_PORT}/users/*
/api/restaurants/*  -> ${RESTAURANT_SERVICE_HOST}:${RESTAURANT_SERVICE_PORT}/restaurants/*
/api/orders/*       -> ${ORDER_SERVICE_HOST}:${ORDER_SERVICE_PORT}/orders/*
/api/payments/*     -> ${PAYMENT_SERVICE_HOST}:${PAYMENT_SERVICE_PORT}/payments/*
```

The host/port pairs are filled in at container startup by the stock
`nginx:alpine` template-substitution feature (`/etc/nginx/templates/*.template`
→ envsubst → `/etc/nginx/conf.d/*`).

## Auth

JWT lives in `localStorage` under `fd.token`. The role claim drives view
selection. The token is attached as `Authorization: Bearer …` on every API
call; NGINX forwards it through. There is no client-side signature
verification — the backends do that.
