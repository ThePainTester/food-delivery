# Frontend

SPA (vanilla JS, no framework) served by a tiny `nginx:alpine` container.
**Static only** — no reverse proxying. A stock Traefik container fronts this
and the backend APIs and is the only component bound to the public network;
routing rules live as `traefik.*` labels in the compose file (see
`compose/docker-compose.yml`).

## Stack

- **Source:** `src/app.js` (logic), `src/styles.css` (Tailwind entry),
  `public/index.html` (shell).
- **`npm run build`** does two steps:
  1. **esbuild** bundles `src/app.js` + its deps —
     [`leaflet`](https://leafletjs.com) and
     [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source)
     (SSE over `fetch()` so the JWT rides in the `Authorization` header instead
     of a URL query param) — into `dist/app.js` (a single IIFE). Leaflet's
     marker images are emitted into `dist/` as hashed assets and Leaflet's
     default-icon paths are repointed at them.
  2. **Tailwind v4 CLI** compiles `src/styles.css` (`@import "tailwindcss"` +
     `@import "leaflet/dist/leaflet.css"` + a couple of app rules) into a
     tree-shaken, minified `dist/styles.css` — only the utility classes
     actually referenced in `src/app.js` / `public/index.html` are included.
- **No runtime CDNs.** Everything (`app.js`, `styles.css`, marker PNGs) is
  served from this origin; only OpenStreetMap *map tiles* are fetched
  externally. (The old in-browser Tailwind JIT CDN was removed — it's
  explicitly not meant for production.)
- **NGINX 1.27 (alpine)** serves `/usr/share/nginx/html` (= `public/` + `dist/`).

## Build (dev)

```bash
npm install
npm run build   # → dist/app.js, dist/styles.css, dist/marker-*.png
```

The image build does this for you; you only need it for a local non-Docker preview.

## Routes (hash-based)

| Hash | Role | Purpose |
|---|---|---|
| `#/login`, `#/register` | public | Auth |
| `#/c/restaurants` | customer | Browse restaurants |
| `#/c/restaurants/:id` | customer | Menu + cart, place order |
| `#/c/orders` | customer | Order history |
| `#/c/orders/:id` | customer | Status timeline + live map (state and driver location pushed over SSE) |
| `#/r/setup` | restaurant | First-run create-restaurant form |
| `#/r/orders` | restaurant | Accept / reject / advance status |
| `#/r/menu` | restaurant | Menu CRUD |
| `#/d/orders` | delivery | Available/off-duty toggle (heartbeats location while on-duty), active deliveries, push-offer modal from dispatch-service |
| `#/d/orders/:id` | delivery | Mark picked up / delivered, posts GPS every 5s while `PICKED_UP` |

## Auth

JWT lives in `localStorage` under `fd.token`. The role claim drives view
selection. The token is attached as `Authorization: Bearer …` on every
`/api/*` call — including the SSE streams, which are read over `fetch()`
(`@microsoft/fetch-event-source`) precisely so they can carry the header;
nothing goes in the URL. Traefik forwards it through. The browser hits
`/api/<service>/...` on the gateway origin — same-origin, no CORS — and
Traefik's `stripprefix` middleware drops `/api` so each backend receives
its native path layout.
