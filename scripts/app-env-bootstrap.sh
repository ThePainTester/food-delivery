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
PUBKEY_MANIFEST="$REPO_ROOT/k8s/base/jwt-pubkey.yaml"

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

# Generate the JWT keypair manifests if missing. Both files are gitignored;
# templates live alongside as *.example.yaml.
if [ ! -f "$PRIVKEY_MANIFEST" ] || [ ! -f "$PUBKEY_MANIFEST" ]; then
  echo "Generating JWT RS256 keypair manifests..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  openssl genpkey -algorithm RSA -out "$TMP/jwt.key" -pkeyopt rsa_keygen_bits:2048 2>/dev/null
  openssl rsa -in "$TMP/jwt.key" -pubout -out "$TMP/jwt.pub" 2>/dev/null

  kubectl create secret generic jwt-privkey \
    --from-file=jwt.key="$TMP/jwt.key" \
    --dry-run=client -o yaml >"$PRIVKEY_MANIFEST"

  kubectl create configmap jwt-pubkey \
    --from-file=jwt.pub="$TMP/jwt.pub" \
    --dry-run=client -o yaml >"$PUBKEY_MANIFEST"

  echo "Wrote $PRIVKEY_MANIFEST"
  echo "Wrote $PUBKEY_MANIFEST"
else
  echo "JWT keypair manifests already present; leaving them alone."
fi

echo "Namespace $NS bootstrapped."
