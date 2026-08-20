#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

for command in node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: required command not found: $command" >&2
    exit 1
  fi
done

node_version="$(node -p 'process.versions.node')"
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 15 ? 0 : 1)'; then
  echo "error: Node 24.15+ and below Node 25 is required (found $node_version)" >&2
  exit 1
fi

npm run validate:json

if [ ! -f .env ]; then
  echo "warning: .env is missing; validating Compose with placeholders from .env.example" >&2
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if [ -f .env ]; then
    docker compose config --quiet
  else
    docker compose --env-file .env.example config --quiet
  fi
else
  echo "warning: Docker Compose v2 is unavailable; compose syntax was not checked" >&2
fi

echo "preflight passed"
