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
npm run check
npm run build
npm run verify:create-disabled

validation_home="${TMPDIR:-/tmp}/idea-to-jira-openclaw-validation-2026.7.1-2"
mkdir -p "$validation_home"
HOME="$validation_home" \
OPENCLAW_CONFIG_PATH="$PWD/config/openclaw.json5" \
IDEA_TO_JIRA_PLUGIN_PATH="$PWD/packages/idea-to-jira-plugin" \
OPENCLAW_GATEWAY_TOKEN="preflight-placeholder-gateway-token" \
TELEGRAM_BOT_TOKEN="preflight-placeholder-telegram-token" \
JIRA_BASE_URL="https://jira.example.test" \
JIRA_TOKEN="preflight-placeholder-jira-token" \
BUSINESS_ADMIN_TELEGRAM_IDS="123456789" \
PRODUCT_OWNER_TELEGRAM_IDS="987654321" \
npm exec -- openclaw config validate

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
