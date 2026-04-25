#!/bin/bash
# Generate the RS256 keypair used by User Service to sign JWTs and by every
# other service to verify them. Idempotent: skips if keys already exist.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/jwt"
mkdir -p "$DIR"

if [ -f "$DIR/jwt.key" ] && [ -f "$DIR/jwt.pub" ]; then
  echo "keys already exist in $DIR — leaving them alone"
  exit 0
fi

openssl genrsa -out "$DIR/jwt.key" 2048
openssl rsa -in "$DIR/jwt.key" -pubout -out "$DIR/jwt.pub"
# Mode 644 so the non-root user inside each container (e.g. UID 10001 in
# user-service) can read the bind-mounted key. Acceptable for dev keys; in
# real prod the key lives in a Secret/secrets-manager, not a host file.
chmod 644 "$DIR/jwt.key" "$DIR/jwt.pub"
echo "wrote $DIR/jwt.key and $DIR/jwt.pub"
