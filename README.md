# Idea-to-Jira MVP

Public scaffold for a dedicated Telegram bot and a dedicated OpenClaw agent that turn an external user's idea into a Jira `Feature`.

## MVP flow

1. Accept text or voice from any Telegram user.
2. Transcribe voice, show the transcript, and accept corrections.
3. Structure the idea and ask only the missing questions.
4. Resolve product/team/PO from the OpenClaw-owned Knowledge Catalog.
5. Search Jira for probable duplicates.
6. Show duplicate links only to a Creator; if no accepted duplicate exists, create the Jira Feature automatically for a Creator.
7. For a Guest, open a Creator access request; an authorized Business Admin may grant or deny it. A granted ready draft resumes automatically.
8. Send the resulting Jira link to the author, Business Admin, and responsible PO.

Preview and a separate “Create in Jira” confirmation are intentionally post-MVP.

## Repository layout

- `docs/BUSINESS_REQUIREMENTS.md` — current business requirements.
- `docs/FUNCTIONAL_REQUIREMENTS.md` — current functional requirements and acceptance criteria.
- `docs/NON_FUNCTIONAL_REQUIREMENTS.md` — current non-functional and security requirements.
- `docs/JIRA_CREATE_CONTRACT.md` — verified Jira create contract and mapping boundary.
- `docs/DECISIONS.md` — accepted scope and architecture decisions.
- `ARCHITECTURE.md` — target components, data ownership, and trust boundaries.
- `packages/idea-to-jira-plugin/` — OpenClaw plugin scaffold.
- `config/openclaw.json5` — dedicated agent, Telegram account, binding, and plugin configuration.
- `knowledge/catalog.md` — fail-closed catalog seed; production content is a separate task.
- `compose.yaml`, `Dockerfile` — isolated OpenClaw deployment.

## Current implementation status

The repository contains the deployable project structure, requirements baseline, Docker/OpenClaw configuration, plugin manifest, one draft-validation tool, unit tests, and CI. Full RBAC, SQLite state machine, transcription, Knowledge Catalog refresh, duplicate search, Jira creation, and notifications remain implementation work tracked by the requirements.

## Local verification

Requirements: Node.js 24.15+ and Docker Compose v2.

```bash
npm ci
npm run check
npm run build
cp .env.example .env
# Replace every placeholder in .env before rendering or starting Compose.
docker compose config --quiet
```

## Start OpenClaw in Docker

1. Create a dedicated bot with BotFather.
2. Put runtime secrets only in `.env` or a production secret manager; never commit them.
3. Complete OpenClaw model-provider onboarding against the mounted `data/state` volume.
4. Start the dedicated gateway:

```bash
docker compose build --pull openclaw-gateway
docker compose up -d openclaw-gateway
docker compose ps
```

The Control UI binds only to `127.0.0.1:18789`. The Telegram account is public for DMs, groups are disabled, sessions are isolated per account/channel/peer, and the dedicated agent is allowlisted only for project plugin tools. The checked-in Knowledge Catalog is deliberately incomplete and must block routing/create until the separate catalog task replaces it with verified production mappings.

## Release pinning

`OPENCLAW_VERSION` defaults to the latest publicly available stable package/image tag verified when this scaffold was created (`2026.7.1-2`). Production upgrades are deliberate: update the version, rebuild with `--pull`, run checks and the security/E2E suite, then deploy. Use the official `ghcr.io/openclaw/openclaw` image only.

## Security

See [SECURITY.md](SECURITY.md). Jira, Telegram, model credentials, OAuth state, OpenClaw auth state, SQLite runtime data, transcripts, and user content must remain outside Git.
