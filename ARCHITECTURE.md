# Architecture

## Target deployment

One dedicated containerized OpenClaw Gateway hosts one dedicated agent, one Telegram bot account, and the `idea-to-jira` plugin. There is no separate application backend.

## Components

```text
Telegram user
   |
   v
Dedicated Telegram bot/account
   |
   v
Dedicated OpenClaw agent
   |-- text/voice intake and clarification dialogue
   |-- Knowledge Catalog retrieval
   |-- plugin tools only
   v
idea-to-jira plugin
   |-- SQLite RBAC, draft, operation and audit state
   |-- bounded Jira duplicate search
   |-- fail-closed Jira payload mapper and create/reconciliation
   |-- notifications to author, Business Admin and PO
   v
Jira Server
```

## Trust boundaries

- Telegram is untrusted input; identity is the verified Telegram sender id supplied by the channel adapter.
- The OpenClaw agent owns the conversation, transcription and structured drafting, but cannot grant its own permissions.
- The plugin owns authorization, state transitions, duplicate decision recording, Jira mappings, idempotency and notifications.
- The agent receives only explicit plugin tools; it has no generic shell, filesystem, browser, HTTP, message, memory, scheduler or subagent tools.
- Business Admin decisions are checked server-side, are atomic, and are recorded in the audit log.
- Jira create payloads are constructed by a whitelist mapper; user or model JSON is never forwarded directly.

## Data ownership

| Data | Owner | Persistence |
| --- | --- | --- |
| Draft and dialogue state | plugin/OpenClaw session | SQLite + OpenClaw state volume |
| Creator grants/revocations | plugin | SQLite |
| Business Admin allowlist | operator config | secret/config runtime |
| Operation and idempotency state | plugin | SQLite |
| Knowledge Catalog | OpenClaw | versioned Markdown source + normalized runtime index |
| Jira issue | Jira | Jira Server |
| Audit events | plugin | SQLite/operational export |

## Main state path

`Guest -> access request -> Business Admin decision -> Creator -> ready draft -> duplicate search -> accepted duplicate OR idempotent Jira create -> notifications`

A denial keeps the user as Guest. Revocation blocks future privileged operations. The same ready draft may resume after a grant. If a Jira POST outcome is unknown, reconciliation must run before any retry.

## Current scaffold boundary

The checked-in plugin currently validates and normalizes a Jira Feature draft. RBAC, SQLite migrations, transcript correction state, Knowledge Catalog refresh, duplicate search, Jira POST/reconciliation and notification delivery are intentionally represented by package boundaries and requirements rather than falsely claimed as implemented.

## Deployment boundary

The production container uses an explicit OpenClaw release tag, a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, persistent state/workspace mounts and loopback-only Gateway publishing. Runtime secrets are injected at deployment and excluded from Git.
