#!/bin/sh
set -eu

# The complete .env is injected by Compose. Keep the Stage-05A image fail-closed
# if credentials that would change the pilot's billing or Jira boundary appear.
for forbidden_key in JIRA_TOKEN OPENAI_API_KEY; do
  if printenv "$forbidden_key" >/dev/null 2>&1; then
    echo "pilot-container status=blocked code=FORBIDDEN_CREDENTIAL_PRESENT key=$forbidden_key" >&2
    exit 1
  fi
done

fingerprint_file=/opt/openclaw-plugins/idea-to-jira/BUILD_FINGERPRINT
if [ ! -r "$fingerprint_file" ]; then
  echo "pilot-container status=blocked code=PLUGIN_BUILD_FINGERPRINT_MISSING" >&2
  exit 1
fi
IDEA_TO_JIRA_BUILD_FINGERPRINT=$(cat "$fingerprint_file")
if ! printf '%s\n' "$IDEA_TO_JIRA_BUILD_FINGERPRINT" | grep -Eq '^[a-f0-9]{64}$'; then
  echo "pilot-container status=blocked code=PLUGIN_BUILD_FINGERPRINT_INVALID" >&2
  exit 1
fi
export IDEA_TO_JIRA_BUILD_FINGERPRINT

exec openclaw "$@"
