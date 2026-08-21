# Stage-05A controlled Telegram DM text pilot runbook

**Scope:** one dedicated bot/account, one trusted numeric sender, text messages only, Stages 01–05. This runbook does not authorize Jira traffic, a broad beta, voice, groups, or production go-live.

## Safety invariants

- Keep `dmPolicy: "allowlist"`, `groupPolicy: "disabled"`, exact `TELEGRAM_PILOT_SENDER_ID`, peer-scoped sessions and the five-tool allowlist unchanged.
- Do not set or inject `JIRA_TOKEN`. `JIRA_BASE_URL` may remain `https://jira.invalid`; no pilot step requires Jira.
- `writeMode` must remain `disabled`; `jira_create`, generic HTTP, browser, exec, filesystem and arbitrary message tools must remain absent.
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

Confirm manually that `JIRA_TOKEN` is absent from `.env` and rendered container environment. Do not use a real Jira origin or credential to make readiness pass.

## 2. Prepare controlled runtime

1. Create `.env` from `.env.example` outside review artifacts.
2. Set a dedicated bot token, one numeric pilot sender ID, a new Gateway token, trusted admin/PO numeric routes, and a reviewed `OPENAI_MODEL=openai/<available-model>`. For this one-actor pilot, include the same pilot ID in `BUSINESS_ADMIN_TELEGRAM_IDS`; startup fails closed otherwise.
3. Keep `JIRA_BASE_URL=https://jira.invalid`; do not add `JIRA_TOKEN`.
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

The operator host needs Docker and Docker Compose v2 only; Node.js/npm are not launch prerequisites. Compose injects the complete `.env` into the container. Before container creation, the launcher rejects `JIRA_TOKEN` and `OPENAI_API_KEY`; after image build, the Node-enabled container validates the complete injected environment. The image entrypoint repeats the forbidden-credential gate so direct Compose startup cannot bypass it. If no persisted OpenAI OAuth profile exists, the launcher starts an interactive device-code login in the raised Gateway container, persists the profile in the mounted state/secret directories, restarts the Gateway and continues readiness checks. On any startup/readiness failure it stops the Gateway. Development `scripts/preflight.sh` remains a separate source/CI gate for reviewed revisions.

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
docker compose exec openclaw-gateway node /app/scripts/create-readiness.mjs --expect-disabled
```

Any non-zero pilot readiness is a stop. Fix configuration/auth/storage offline; never switch DM to open, add tools, provide Jira credentials, or bypass checks.

## 4. Controlled Telegram smoke

The operator performs these steps from the exact allowlisted Telegram user in a direct chat with the dedicated bot. Use synthetic, non-sensitive idea text.

1. **Context/boundary:** send one harmless text greeting. Verify the response comes from agent `idea-mvp` on the single Telegram account `default`; inspect sanitized logs only for pass/fail codes, not content.
2. **RBAC:** request access through the implemented command/tool flow. Verify a pending request and an allowlisted admin decision; repeat the same decision to prove anti-replay/stale rejection.
3. **Draft create:** send synthetic text sufficient to create a Draft. Record only redacted Draft reference and version `1`.
4. **Read/patch:** read the same Draft, apply one meaningful text update with expected version, and verify version increments exactly once.
5. **CAS:** attempt a second patch using the stale prior version. Verify conflict and no overwrite.
6. **Ownership/destination:** do not add a second actor to the allowlist. From any non-allowlisted account used by the operator's security test, the bot must not reach model/tool mutation. Stop if it does.
7. **Cancel (optional final mutation):** cancel with the current version and verify immutable history/current state.

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

- real dedicated Telegram bot token and exact numeric pilot sender ID;
- reviewed available `openai/*` model and valid mounted auth profile;
- reviewed OpenClaw image digest/release evidence, writable private mounts and restart window;
- explicit authorization for external Telegram/OpenAI activity;
- optional network telemetry if a measured zero-Jira-request claim is required;
- supported typed pre-model media discriminator if byte-level media rejection (rather than disabled audio understanding plus operational text-only policy) is mandatory.
