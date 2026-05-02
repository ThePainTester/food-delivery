#!/usr/bin/env bash
set -euo pipefail

SERVICE="${1:?usage: publish.sh <service> <version>}"
VERSION="${2:?usage: publish.sh <service> <version>}"
OWNER="thepaintester"
PLATFORM="linux/amd64"

docker buildx build \
  --platform "$PLATFORM" \
  -t "ghcr.io/$OWNER/$SERVICE:$VERSION" \
  -t "ghcr.io/$OWNER/$SERVICE:latest" \
  --push \
  "./services/$SERVICE"
