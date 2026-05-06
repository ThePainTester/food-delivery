# Restaurant Service

Python 3.12 + FastAPI + MongoDB (Motor). Verifies JWTs issued by User Service using the shared RS256 public key.

## Env
- `PORT` (default 8080)
- `MONGO_URL` — e.g. `mongodb://mongo:27017`
- `MONGO_DB` (default `restaurants`)
- `JWT_PUBLIC_KEY_PATH` — same public key used by User Service
- `JWT_ISSUER` (default `user-service`)

## Endpoints
- `GET /restaurants` — public; query: `cuisine`, `is_open`, `search`
- `GET /restaurants/mine` — role=restaurant; the caller's own restaurant
- `GET /restaurants/:id` — public
- `GET /restaurants/:id/owner` — auth; resolves the owner user id
- `POST /restaurants` — role=restaurant
- `PATCH /restaurants/:id` — owner
- `GET /restaurants/:id/menu` — public
- `POST /restaurants/:id/menu` — owner
- `PATCH /restaurants/:id/menu/:item_id` — owner
- `DELETE /restaurants/:id/menu/:item_id` — owner
- `GET /healthz`
- `GET /docs` — OpenAPI UI
