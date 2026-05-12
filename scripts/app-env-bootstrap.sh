#!/usr/bin/env bash
# bootstrap-namespace.sh
set -euo pipefail

NS="${1:?usage: bootstrap-namespace.sh <namespace>}"

# CR_PAT is only needed for namespaces that pull from ghcr.io. The "food-delivery-dev"
# namespace runs against locally-built images on Minikube, so skip it there.
if [ "$NS" != "food-delivery-dev" ]; then
  : "${CR_PAT:?CR_PAT not set}"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRIVKEY_MANIFEST="$REPO_ROOT/k8s/base/secrets/jwt-privkey.yaml"
INFRA_DIR="$REPO_ROOT/k8s/base/infra"

# Random URL-safe-ish password — 24 bytes of entropy, base64'd.
gen_password() {
  openssl rand -base64 24 | tr -d '\n=+/' | head -c 24
}

# Create namespace if missing
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

# Create/refresh the pull secret (skipped in dev — images are local).
if [ "$NS" != "food-delivery-dev" ]; then
  kubectl create secret docker-registry ghcr-credentials \
    --docker-server=ghcr.io \
    --docker-username=thepaintester \
    --docker-password="$CR_PAT" \
    --namespace="$NS" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# Generate the JWT private-key Secret manifest if missing. Only user-service
# holds the key (it signs tokens and publishes the public key at
# /.well-known/jwks.json, which every other service fetches). The file is
# gitignored; a template lives alongside as jwt-privkey.example.yaml.
if [ ! -f "$PRIVKEY_MANIFEST" ]; then
  echo "Generating JWT RS256 private-key Secret manifest..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  openssl genpkey -algorithm RSA -out "$TMP/jwt.key" -pkeyopt rsa_keygen_bits:2048 2>/dev/null

  kubectl create secret generic jwt-privkey \
    --from-file=jwt.key="$TMP/jwt.key" \
    --dry-run=client -o yaml >"$PRIVKEY_MANIFEST"

  echo "Wrote $PRIVKEY_MANIFEST"
else
  echo "JWT private-key manifest already present; leaving it alone."
fi

# Generate per-infra Secret manifests if missing. Each subdir of k8s/base/infra
# ships a `secret.example.yaml` template with `password: REPLACE_ME`; we copy
# it to `secret.yaml` (gitignored) once and substitute a random password.
# Idempotent — existing files are left alone so kubectl apply is repeatable.
for tmpl in "$INFRA_DIR"/*/secret.example.yaml; do
  [ -f "$tmpl" ] || continue
  target="${tmpl%.example.yaml}.yaml"
  if [ -f "$target" ]; then
    echo "Infra secret already present: $target (leaving alone)."
    continue
  fi
  pw="$(gen_password)"
  # Use a python one-liner — sed -i with a base64-y password is brittle
  # because of slashes/backslashes in the random string.
  python3 - "$tmpl" "$target" "$pw" <<'PY'
import sys, pathlib
src, dst, pw = sys.argv[1:]
text = pathlib.Path(src).read_text()
text = text.replace("REPLACE_ME", pw)
pathlib.Path(dst).write_text(text)
PY
  echo "Wrote $target"
done

echo "Namespace $NS bootstrapped."
