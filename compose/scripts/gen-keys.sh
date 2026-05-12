#!/bin/bash
# Generate the RS256 private key used by User Service to sign JWTs. The other
# services verify tokens by fetching User Service's JWKS endpoint
# (/.well-known/jwks.json) — they need no key file. Idempotent: skips if the
# key already exists.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/jwt"
mkdir -p "$DIR"

if [ -f "$DIR/jwt.key" ]; then
  echo "key already exists at $DIR/jwt.key — leaving it alone"
  exit 0
fi

openssl genrsa -out "$DIR/jwt.key" 2048
# Mode 644 so the non-root user inside the user-service container (UID 10001)
# can read the bind-mounted key. Acceptable for dev keys; in real prod the key
# lives in a Secret/secrets-manager, not a host file.
chmod 644 "$DIR/jwt.key"
echo "wrote $DIR/jwt.key"
