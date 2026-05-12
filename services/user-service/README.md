# User Service

Go + Gin + Postgres. Issues RS256 JWTs (with a `kid` header) and publishes the
matching public key as a JWKS at `/.well-known/jwks.json`; other services fetch
and cache it from there. This is the only service that holds the signing key.

## Env
- `PORT` (default 8080)
- `DATABASE_URL` — e.g. `postgres://user:pass@postgres:5432/users?sslmode=disable`
- `JWT_PRIVATE_KEY_PATH` — PEM RSA private key (the public half is derived from it)
- `JWT_ISSUER` (default `user-service`)

## Generate the signing key (dev)
```
openssl genrsa -out jwt.key 2048
```

## Endpoints
- `POST /auth/register`
- `POST /auth/login`
- `GET /users/me` (auth)
- `PATCH /users/me` (auth)
- `GET /users/:id` (auth, limited fields)
- `GET /healthz`
- `GET /.well-known/jwks.json` — JWKS (RSA public key) for peer services

## Migrations
Run `migrations/001_init.sql` against the target DB.
