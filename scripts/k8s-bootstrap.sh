#!/usr/bin/env bash
# bootstrap-namespace.sh
set -euo pipefail

NS="${1:?usage: bootstrap-namespace.sh <namespace>}"
: "${CR_PAT:?CR_PAT not set}"

# Create namespace if missing
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

# Create/refresh the pull secret
kubectl create secret docker-registry ghcr-credentials \
  --docker-server=ghcr.io \
  --docker-username=thepaintester \
  --docker-password="$CR_PAT" \
  --namespace="$NS" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Namespace $NS bootstrapped."
