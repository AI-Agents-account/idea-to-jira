#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

ENV_FILE=".env"
GATEWAY_SERVICE="openclaw-gateway"
FINGERPRINT_NODE_IMAGE="node:24.19.0-bookworm-slim"
gateway_started=0

compose() {
  docker compose --env-file "$ENV_FILE" "$@"
}

source_plugin_fingerprint() {
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges=true \
    --workdir /src \
    --mount "type=bind,source=$PWD/scripts/plugin-build-fingerprint.mjs,target=/src/scripts/plugin-build-fingerprint.mjs,readonly" \
    --mount "type=bind,source=$PWD/package.json,target=/src/package.json,readonly" \
    --mount "type=bind,source=$PWD/package-lock.json,target=/src/package-lock.json,readonly" \
    --mount "type=bind,source=$PWD/packages/idea-to-jira-plugin/package.json,target=/src/packages/idea-to-jira-plugin/package.json,readonly" \
    --mount "type=bind,source=$PWD/packages/idea-to-jira-plugin/openclaw.plugin.json,target=/src/packages/idea-to-jira-plugin/openclaw.plugin.json,readonly" \
    --mount "type=bind,source=$PWD/packages/idea-to-jira-plugin/src,target=/src/packages/idea-to-jira-plugin/src,readonly" \
    "$FINGERPRINT_NODE_IMAGE" \
    node scripts/plugin-build-fingerprint.mjs
}

cleanup_on_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$gateway_started" -eq 1 ]; then
    echo "pilot-up: startup failed; stopping $GATEWAY_SERVICE" >&2
    compose stop "$GATEWAY_SERVICE" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_on_failure EXIT

fail() {
  echo "pilot-up: error: $1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "required command not found: docker"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
[ -f "$ENV_FILE" ] || fail "environment file not found: $ENV_FILE"

# Stage-05A is subscription-backed and must contain no Jira credential.
# The Compose env_file is injected wholesale, so reject forbidden credentials
# before rendering or creating a container.
for forbidden_key in JIRA_TOKEN OPENAI_API_KEY; do
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${forbidden_key}[[:space:]]*=" "$ENV_FILE"; then
    fail "$forbidden_key must be absent from $ENV_FILE for the controlled pilot"
  fi
done

mkdir -p data/config data/state data/workspace data/plugin-state data/auth-profile-secrets
# The runtime config is a generated deployment artifact. Refresh it from the
# reviewed template on every launch so an earlier pilot run cannot retain stale
# bindings or plugin settings. The template contains references, not secrets.
runtime_config_tmp="data/config/openclaw.json5.tmp.$$"
cp config/openclaw.json5 "$runtime_config_tmp"
chmod 600 "$runtime_config_tmp"
mv "$runtime_config_tmp" data/config/openclaw.json5

printf '%s\n' "pilot-up: validating Compose configuration"
compose config --quiet

printf '%s\n' "pilot-up: building reviewed image"
compose build --pull "$GATEWAY_SERVICE"

# Compute the expected value from the reviewed host source in an isolated Node
# container. The macOS host needs only Docker Compose, and the source check is
# independent from the fingerprint self-reported by the application image.
expected_plugin_fingerprint=$(source_plugin_fingerprint)
if ! printf '%s\n' "$expected_plugin_fingerprint" | grep -Eq '^[a-f0-9]{64}$'; then
  fail "local plugin source fingerprint is invalid"
fi
built_plugin_fingerprint=$(compose run --rm --no-deps --entrypoint cat openclaw-cli \
  /opt/openclaw-plugins/idea-to-jira/BUILD_FINGERPRINT)
if ! printf '%s\n' "$built_plugin_fingerprint" | grep -Eq '^[a-f0-9]{64}$'; then
  fail "built plugin image fingerprint is invalid"
fi
if [ "$built_plugin_fingerprint" != "$expected_plugin_fingerprint" ]; then
  fail "built plugin image does not match the reviewed source"
fi

printf '%s\n' "pilot-up: validating the injected container environment"
compose run --rm --no-deps --entrypoint node openclaw-cli \
  /app/scripts/pilot-env-check.mjs --process-env

printf '%s\n' "pilot-up: starting Gateway"
compose up -d --wait --wait-timeout 180 --force-recreate "$GATEWAY_SERVICE"
gateway_started=1

printf '%s\n' "pilot-up: verifying the running plugin build fingerprint"
running_plugin_fingerprint=$(compose exec -T "$GATEWAY_SERVICE" \
  cat /opt/openclaw-plugins/idea-to-jira/BUILD_FINGERPRINT)
if [ "$running_plugin_fingerprint" != "$expected_plugin_fingerprint" ]; then
  fail "running plugin build does not match the reviewed source"
fi
current_plugin_fingerprint=$(source_plugin_fingerprint)
if [ "$current_plugin_fingerprint" != "$expected_plugin_fingerprint" ]; then
  fail "plugin source changed during image startup verification"
fi
printf '%s\n' "pilot-up: plugin build fingerprint=$running_plugin_fingerprint"

printf '%s\n' "pilot-up: verifying the custom plugin is loaded"
if ! compose exec -T "$GATEWAY_SERVICE" sh -c '
  openclaw plugins list --json |
    node -e '\''
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(input);
          const loaded = Array.isArray(parsed.plugins) && parsed.plugins.some(
            (plugin) => plugin?.id === "idea-to-jira" && plugin?.status === "loaded" && plugin?.enabled === true,
          );
          process.exit(loaded ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    '\''
'; then
  fail "idea-to-jira plugin is not loaded"
fi

has_openai_oauth() {
  compose exec -T "$GATEWAY_SERVICE" sh -c '
    openclaw models auth list --provider openai --json 2>/dev/null |
      node -e '\''
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const parsed = JSON.parse(input);
            const found = Array.isArray(parsed.profiles) && parsed.profiles.some(
              (profile) => profile?.provider === "openai" && profile?.type === "oauth",
            );
            process.exit(found ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      '\''
  '
}

if ! has_openai_oauth; then
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    fail "OpenAI OAuth is missing and interactive device-code login requires a terminal"
  fi

  printf '%s\n' "pilot-up: OpenAI OAuth is missing; complete the device-code login now"
  compose exec "$GATEWAY_SERVICE" \
    openclaw models auth login --provider openai --device-code

  has_openai_oauth || fail "OpenAI OAuth profile was not created"

  printf '%s\n' "pilot-up: restarting Gateway with the persisted OAuth profile"
  compose restart "$GATEWAY_SERVICE"
  compose up -d --wait --wait-timeout 180 "$GATEWAY_SERVICE"
else
  printf '%s\n' "pilot-up: existing OpenAI OAuth profile found"
fi

printf '%s\n' "pilot-up: verifying the configured OpenAI model is available"
if ! compose exec -T "$GATEWAY_SERVICE" sh -c '
  openclaw models list --provider openai --json |
    node -e '\''
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(input);
          const target = process.env.OPENAI_MODEL;
          const available = Array.isArray(parsed.models) && parsed.models.some(
            (model) => model?.key === target && model?.available === true,
          );
          process.exit(available ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    '\''
'; then
  fail "configured OpenAI model is not available to the OAuth account"
fi

printf '%s\n' "pilot-up: verifying live-local boundaries"
compose exec -T "$GATEWAY_SERVICE" node /app/scripts/healthcheck.mjs
compose exec -T "$GATEWAY_SERVICE" node /app/scripts/pilot-readiness.mjs
compose exec -T "$GATEWAY_SERVICE" node /app/scripts/create-readiness.mjs --expect-disabled

trap - EXIT
printf '%s\n' "pilot-up: ready; Gateway is running on the configured loopback port"
