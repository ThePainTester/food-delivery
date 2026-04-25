# User Service

Go + Gin + Postgres. Issues RS256 JWTs; other services verify with the public key.

## Env
- `PORT` (default 8080)
- `DATABASE_URL` — e.g. `postgres://user:pass@postgres:5432/users?sslmode=disable`
- `JWT_PRIVATE_KEY_PATH` — PEM RSA private key
- `JWT_PUBLIC_KEY_PATH` — PEM RSA public key
- `JWT_ISSUER` (default `user-service`)

## Generate keys (dev)
```
openssl genrsa -out jwt.key 2048
openssl rsa -in jwt.key -pubout -out jwt.pub
```

## Endpoints
- `POST /auth/register`
- `POST /auth/login`
- `GET /users/me` (auth)
- `PATCH /users/me` (auth)
- `GET /users/:id` (auth, limited fields)
- `GET /healthz`
- `GET /.well-known/jwks.pem` — public key for peer services

## Migrations
Run `migrations/001_init.sql` against the target DB.
