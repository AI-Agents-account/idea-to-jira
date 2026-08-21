# Stage-05A controlled Telegram DM text pilot runbook

**Scope:** one dedicated bot/account with public numeric private-DM access requests, a controlled operator for admin/owner-directive smoke, text messages only, Stages 01–05. This runbook does not authorize Jira traffic, unrestricted model access, voice, groups, or production go-live.

## Safety invariants

- Keep channel and account `dmPolicy: "open"`, `allowFrom: ["*"]`, `groupPolicy: "disabled"`, peer-scoped sessions and the exact ten-tool allowlist unchanged.
- Keep native/text core-command parsing and native skill menus disabled. Restrict any remaining directive/owner authorization through `commands.allowFrom.telegram` and `commands.ownerAllowFrom` to `TELEGRAM_PILOT_SENDER_ID`; keep bash/config/MCP/plugin/debug/restart command surfaces disabled.
- Public admission means only typed `/request_access` is available before role approval. Guest free-form text must be blocked before the model with the fixed Russian `/request_access` instruction; Draft/Jira tools must not be exposed.
- Do not put `JIRA_TOKEN` in `.env`. This text-only pilot leaves `data/secrets/jira-token` absent, so Jira tools remain unavailable while Draft continues to work.
- Generic HTTP, browser, exec, filesystem and arbitrary message tools remain absent; Jira tools are conditionally exposed only when the runtime file-secret exists.
- Catalog placeholder is not active evidence. Do not attempt duplicate, READY or create. A verified Catalog must precede all three in a future stage.
- Stop on any unexpected sender/model/tool, storage/readiness failure, Draft mutation from non-text input, raw private payload in logs, or external Jira request.

## Evidence record

Record only timestamp, reviewed commit SHA, OpenClaw image tag/digest, model route name, pass/fail codes, redacted Draft reference/version and operator decision. Never record bot/gateway tokens, auth-profile data, Telegram sender IDs, private Draft text, raw logs or request bodies.

## 1. Offline prechecks (no external calls)

From a clean checkout:

```bash
npm ci
npm run validate:json
npm run build
npm run lint
npm run test
./scripts/preflight.sh
```

Expected: all commands exit 0. `preflight.sh` performs structural OpenClaw/plugin validation with fixtures; it does not start the Gateway or call Telegram/OpenAI/Jira.

Inspect the rendered Compose config without pasting output into the evidence record:

```bash
docker compose --env-file .env config --quiet
```

Confirm manually that `JIRA_TOKEN` is absent from `.env` and rendered container environment and that `data/secrets/jira-token` is absent for this no-Jira pilot. Do not use a real Jira origin or credential to make readiness pass.

## 2. Prepare controlled runtime

1. Create `.env` from `.env.example` outside review artifacts.
2. Set a dedicated bot token, one numeric controlled operator ID, a new Gateway token, trusted admin/PO numeric routes, and a reviewed `OPENAI_MODEL=openai/<available-model>`. Include `TELEGRAM_PILOT_SENDER_ID` in `BUSINESS_ADMIN_TELEGRAM_IDS`; it authorizes the controlled admin/owner-directive smoke, not public requester admission.
3. Keep `JIRA_BASE_URL=https://jira.invalid`; do not add `JIRA_TOKEN` or `data/secrets/jira-token`.
4. Create private persistent mounts:

```bash
mkdir -p data/state data/workspace data/plugin-state data/auth-profile-secrets
```

5. Complete the documented OpenAI auth-profile login in the one-off CLI container. This is an external authentication action and requires the operator's approved pilot window.
6. Build but do not broaden policy:

```bash
docker compose build --pull openclaw-gateway
docker compose --env-file .env config --quiet
```

## 3. Live-local readiness before Telegram

After Technical Owner approval, the preferred launch is one fail-closed command:

```bash
./scripts/pilot-up.sh
```

The operator host needs Docker and Docker Compose v2 only; Node.js/npm are not launch prerequisites. Compose uses `.env` for interpolation and injects only the explicit runtime allowlist from `compose.yaml`. Before container creation, the launcher rejects `JIRA_TOKEN` and `OPENAI_API_KEY`; after image build, the Node-enabled container validates the injected environment. The image entrypoint repeats the forbidden-inline-credential gate so direct Compose startup cannot bypass it. If no persisted OpenAI OAuth profile exists, the launcher starts an interactive device-code login in the raised Gateway container, persists the profile in the mounted state/secret directories, restarts the Gateway and continues readiness checks. On any startup/readiness failure it stops the Gateway. Development `scripts/preflight.sh` remains a separate source/CI gate for reviewed revisions.

The equivalent manual readiness commands are:

```bash
docker compose up -d --wait --wait-timeout 180 openclaw-gateway
docker compose ps
docker compose exec openclaw-gateway node /app/scripts/healthcheck.mjs
docker compose exec openclaw-gateway node /app/scripts/pilot-readiness.mjs
```

Expected final readiness fields: `status=ready mode=live-local`, `runtime=ready`, healthy current schema, `jira_post=disabled`, `audio=disabled`. The script validates local effective config/Catalog and calls the authenticated loopback Gateway method `idea-to-jira.runtime-status`; only the active in-Gateway plugin generation can report runtime readiness. Opening SQLite in a separate process is not readiness evidence. The script does not contact Telegram, OpenAI or Jira.

Also confirm create readiness remains closed:

```bash
docker compose exec openclaw-gateway node /app/scripts/create-readiness.mjs --verify-contract
```

Any non-zero pilot readiness is a stop. Fix configuration/auth/storage offline; never enable groups, broaden core-command authorization, add tools, provide Jira credentials, or bypass checks.

## 4. Controlled Telegram smoke

Use two operator-controlled Telegram accounts when available: a non-admin public requester and the controlled Business Admin. All traffic must be private DM with the dedicated bot and use synthetic, non-sensitive text.

1. **Guest pre-model gate:** from the non-admin requester, send one harmless free-form greeting. Verify the fixed Russian denial names `/request_access`, no model response is produced, and no Draft/Jira tool runs.
2. **Public typed request:** send `/request_access` from that same requester. Verify a `PENDING` request is created without model execution and only configured Business Admin destinations receive the content-free card. Repeat `/request_access`; verify the same current status is returned and no second request/card is created.
3. **Core-command/directive boundary:** from the requester, send one harmless core command and one harmless directive-only test approved for the window. Verify neither executes and neither bypasses the Guest pre-model gate. Native/text core commands stay disabled for every sender; if the smoke window includes a remaining owner-directive check, perform it only from the controlled operator.
4. **RBAC:** approve through `/access` from the controlled Business Admin. From the requester, attempt a mutating `/access` action with synthetic invalid data and verify no admin transition usage/details are disclosed. Repeat the admin decision to prove anti-replay/stale rejection.
5. **Draft create:** after approval, send synthetic text sufficient to create a Draft. Record only redacted Draft reference and version `1`.
6. **Read/patch:** read the same Draft, apply one meaningful text update with expected version, and verify version increments exactly once.
7. **CAS:** attempt a second patch using the stale prior version. Verify conflict and no overwrite.
8. **Identity/destination:** from a third unapproved numeric private-DM account, verify `/request_access` reaches only `PENDING` while free-form text remains model/tool blocked. Stop if any group/topic, destination mismatch, username claim, or unapproved account reaches model/tool mutation.
9. **Cancel (optional final mutation):** cancel with the current version and verify immutable history/current state.

Do not send real business content, links requiring fetch, files, photos, voice, Jira keys or credentials.

## 5. Restart durability proof

Before restart, record only Draft reference/current version and access state. Then:

```bash
docker compose restart openclaw-gateway
docker compose ps
docker compose exec openclaw-gateway node /app/scripts/healthcheck.mjs
docker compose exec openclaw-gateway node /app/scripts/pilot-readiness.mjs
```

From the trusted DM, read the same Draft/status. Pass only if ID, current version, history semantics and RBAC state survive unchanged. A missing/rewound Draft, schema failure or new access grant is a stop and rollback trigger.

## 6. Text-only limitation and negative evidence

OpenClaw `2026.7.1-2` provides verified config for `tools.media.audio.enabled: false`, and the pilot tool allowlist contains no STT/media tool. The installed `before_agent_run` SDK event exposes trusted account/channel/sender but no typed attachment/media discriminator. Therefore Stage-05A does **not** claim a byte-level inbound media rejection hook that the SDK does not evidence.

Operationally, admit text only. If the Technical Owner separately approves one synthetic voice-note negative test, it must not produce a transcript or any Draft/RBAC mutation. Any mutation is a blocker: stop the pilot and defer until a supported pre-model media gate is evidenced. Do not treat this test as Stage-07 voice acceptance.

## 7. Zero-Jira proof

During the window:

- no Jira credential exists in the container;
- no Jira/create/generic network tool exists in the agent allowlist;
- the only Jira adapter deterministically throws disabled;
- no smoke instruction names a Jira endpoint or executes a request.

If network telemetry is available, attach only the count `Jira HTTP requests = 0`; do not attach headers/URLs containing internal details. Any Jira request, including GET, fails this Stage-05A smoke.

## 8. Stop, rollback and closeout

Immediate stop conditions: unexpected sender accepted, group/topic processing, non-text mutation, repeated/stale CAS accepted, lost state after restart, Jira traffic, secret/private content in logs, or readiness failure.

```bash
npm run pilot:down
```

Equivalent direct command:

```bash
docker compose --env-file .env down
```

`down` must not delete volumes. Preserve state for incident analysis under existing access controls; do not copy SQLite/logs into Git. Rotate a token only through the operator's normal secret procedure if exposure is suspected.

Closeout decision: `continue controlled pilot`, `fix and repeat`, or `close pilot`. This decision does not approve Stage-06 full lifecycle, Stage-07 voice, production traffic or Jira POST.

## Current blockers before a real smoke

- real dedicated Telegram bot token, controlled operator ID and preferably a separate non-admin requester account;
- reviewed available `openai/*` model and valid mounted auth profile;
- reviewed OpenClaw image digest/release evidence, writable private mounts and restart window;
- explicit authorization for external Telegram/OpenAI activity;
- optional network telemetry if a measured zero-Jira-request claim is required;
- supported typed pre-model media discriminator if byte-level media rejection (rather than disabled audio understanding plus operational text-only policy) is mandatory.
