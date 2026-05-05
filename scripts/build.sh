#!/usr/bin/env bash
set -euo pipefail

SERVICE="${1:?usage: publish.sh <service> <tag>}"
TAG="${2:?usage: publish.sh <service> <tag>}"

docker build \
  -t "food-delivery/$SERVICE:$TAG" \
  "./services/$SERVICE"
