# RBAC and access requests

## 1. Implemented scope

Stage 04 implements the local access-control boundary while Jira write remains disabled:

- durable `GUEST`, `PENDING`, `CREATOR`, `SUSPENDED`, and `BLOCKED` user lifecycle;
- at most one `PENDING` access request per user and one live (`ACTIVE` or `SUSPENDED`) Creator grant;
- Business Admin approve, deny, pending-request block, grant suspend/restore/revoke/block, and explicit user unblock;
- opaque action references plus record-version CAS for deterministic anti-replay;
- atomic access/role mutation and append-only audit writes in `criticalTransaction`;
- reusable own-Draft and active-Creator authorization APIs for duplicate disclosure, operation claim, and the immediate pre-POST recheck;
- public Telegram private-DM ingress with a typed `/request_access` fast path for every numeric sender;
- deterministic `before_agent_run` interception: only an active Creator grant or a startup-validated non-blocked Business Admin reaches the model;
- typed `/request_access` and `/access` handlers that bypass the LLM.

Corporate SSO, Feature-specific approval, Business Admin host/OpenClaw access, and host control routes such as `/delete/disable` remain out of scope. This stage does not enable Jira POST.

## 2. Trusted identity boundary

Authorization keys are assembled only from OpenClaw-owned context:

- agent `idea-mvp`;
- channel `telegram`;
- canonical Telegram account `default` (the single `TELEGRAM_BOT_TOKEN` account);
- user-triggered direct message;
- numeric `senderId` equal to the direct-message destination;
- no thread/topic.

The Telegram channel and canonical account use `dmPolicy: "open"` plus `allowFrom: ["*"]`; both keep `groupPolicy: "disabled"`. Open transport admission is not application authorization. The plugin still rejects non-numeric, wrong-agent, wrong-channel/account, non-user, destination-mismatched and threaded contexts before any access mutation or model run. There is no exact pilot-sender comparison in requester validation.

`PluginCommandContext.senderId`, channel/account, `from`/`to`, and thread fields are validated before a command reaches `AccessService`. On the confirmed Telegram native-command path, `senderId` is the plain numeric identity while both `from` and `to` must equal `telegram:<senderId>`; the adapter normalizes that verified binding back to the numeric access key. Command arguments, prompt text, username, display name, and opaque action references never establish actor identity. The Business Admin capability comes only from the startup-validated `BUSINESS_ADMIN_TELEGRAM_IDS` allowlist.

Free-form turns are gated by the typed `before_agent_run` hook before model execution. The hook consumes OpenClaw's trusted `accountId`, `channelId`, `senderId`, direct-chat facts and authoritative access storage; it does not reconstruct identity from prompt text or usernames. `BLOCKED` always wins. Non-blocked Business Admins and users whose `CREATOR` state is backed by an `ACTIVE` Creator grant pass through. Guest, Pending, Suspended, Blocked, stale Creator, malformed identity, and storage failures are blocked without invoking the model. A Guest receives a fixed Russian instruction to send `/request_access`; Pending and Suspended users receive fixed status guidance. Typed `/request_access` and `/access` plugin commands are resolved before this hook and retain their non-LLM handlers.

Core OpenClaw commands and directives are a separate boundary. Native and text core-command parsing is disabled, bash/config/MCP/plugin/debug/restart command surfaces are disabled, and `commands.allowFrom.telegram` plus `commands.ownerAllowFrom` contain only the controlled operator ID (`TELEGRAM_PILOT_SENDER_ID`) for any remaining directive/owner authorization. `/request_access` remains public because its plugin definition explicitly uses `requireAuth: false` and performs its own strict requester validation. Other Guest slash input is treated as untrusted text and then stopped by `before_agent_run`.

The installed OpenClaw `2026.7.1-2` declarations were checked at the public `/plugin-sdk/core` command/runtime surface and the plugin registry surface represented by `/plugins/registry-types.d.ts`. The confirmed integration points are `OpenClawPluginApi.registerCommand`, `PluginCommandContext`, and `api.runtime.channel.outbound.loadAdapter(...).sendText(...)`.

OpenClaw exposes a generic `registerInteractiveHandler`, but the installed public declarations do not define a Telegram callback context with a verified actor/chat/account binding contract for this plugin. No callback interface is invented or registered. The stage therefore uses deterministic typed commands with the same opaque-reference/version anti-replay contract. Callback support must be added only after a concrete Telegram SDK contract is available and tested on the real boundary.

Username and display-name fields are not present in the confirmed command, tool-factory, or `before_agent_run` identity context. The database supports bounded untrusted snapshots, and `AccessService` stores them when a trusted adapter can supply them, but they are never required and never participate in authorization.

## 3. Commands

### User command

```text
/request_access
```

A new numeric private-DM sender becomes `GUEST`. The first request atomically moves the user to `PENDING`, creates an opaque action reference, and appends `ACCESS_REQUESTED` audit evidence. Repeating the command returns the current status without creating a second request or notification. Creator or suspended users also receive current status; blocked users are denied.

For a newly created request, the plugin sends a content-free card to every server-side Business Admin destination through the fixed Telegram account. The card contains only sender ID, optional untrusted identity snapshots, action reference, and version. It contains no idea, Draft, duplicate, Jira candidate, credential, or audit detail.

### Business Admin commands

```text
/access status
/access approve <action-reference> <version> [bounded reason]
/access deny <action-reference> <version> [bounded reason]
/access block <action-reference> <version> [bounded reason]
/access suspend <grant-reference> <version> [bounded reason]
/access restore <grant-reference> <version> [bounded reason]
/access revoke <grant-reference> <version> [bounded reason]
/access block-role <grant-reference> <version> [bounded reason]
/access unblock <user-reference> <version>
```

Every mutating action revalidates the host-derived Business Admin identity, Telegram DM/channel/account binding, current database state, and expected record version. References identify server-side records but confer no authority. A completed, stale, or replayed action returns a bounded stale response and performs no second state or audit transition.

`/access` is a Business Admin-only command, including its status form. Ordinary users receive only the instruction to send `/request_access`; transition syntax and access records are not disclosed. Every `/access` action fails before usage/action details are rendered unless the host-derived sender is in `BUSINESS_ADMIN_TELEGRAM_IDS`.

The public `/request_access` handler consumes the existing process-local per-sender token bucket before it reads or mutates access state. Repeated requests remain idempotent and cannot create duplicate pending rows or duplicate Admin notifications; excessive retries receive a bounded retry-later response without invoking the model or Jira.

## 4. State transitions

| Current state | Action | Next user state | Request/grant result |
| --- | --- | --- | --- |
| unknown | first trusted activity | `GUEST` | no role |
| `GUEST` | request | `PENDING` | request `PENDING` v1 |
| `PENDING` | request again | `PENDING` | same request/version |
| `PENDING` | approve | `CREATOR` | request `APPROVED`; grant `ACTIVE` v1 |
| `PENDING` | deny | `GUEST` | request `DENIED` |
| `PENDING` | block | `BLOCKED` | request `BLOCKED` |
| `CREATOR` | suspend | `SUSPENDED` | grant `SUSPENDED`; version increments |
| `SUSPENDED` | restore | `CREATOR` | grant `ACTIVE`; version increments |
| `CREATOR`/`SUSPENDED` | revoke | `GUEST` | grant `REVOKED`; version increments |
| `CREATOR`/`SUSPENDED` | block role | `BLOCKED` | grant `REVOKED`; version increments |
| `BLOCKED` | explicit unblock | `GUEST` | no role backfill or automatic restore |

All other transitions fail closed. There is no automatic role backfill and no path from username/display name to access.

## 5. Persistence and atomicity

Migration `003_rbac_access_requests` advances the schema to v3 and:

- adds bounded untrusted username/display-name snapshots;
- adds bounded decision/transition reason fields;
- creates/backfills unique opaque access action references and rejects later `NULL` inserts/updates;
- replaces the active-only role index with a unique live-grant index covering `ACTIVE` and `SUSPENDED`.

Critical transitions run under `synchronous=FULL` plus `BEGIN IMMEDIATE`. Request/user/grant updates use `record_version` in their predicates. Approve writes request decision, user state, Creator grant, `ACCESS_DECISION`, and `ROLE_TRANSITION` evidence in one transaction. Audit failure or any constraint/CAS failure rolls back the entire transaction. Concurrent winners commit once; losers observe stale/conflict and do not overwrite the winner.

Existing pending requests receive an opaque random action reference during migration. Existing users remain in their persisted state, and no Creator grant is inferred or backfilled. Deployments upgrading a non-empty database still require the verified pre-upgrade backup described in `STORAGE.md`.

## 6. Authorization API for later stages

`AccessService.authorizeOwnDraft(requester, draftId)` checks the trusted sender against the stored Draft owner and denies unknown, cross-peer, or blocked subjects.

`AccessService.authorizeCreatorOperation(requester, draftId)` additionally requires user state `CREATOR` and a live Creator grant in state `ACTIVE`. Stage 05 and later must call this server-side API before Jira candidate disclosure and operation claim. The same role check must run again immediately before POST; model parameters and earlier readiness results are not authorization evidence.

Guest, suspended, revoked, blocked, unknown, and cross-peer callers receive no Jira candidate or private Draft detail through these guards.

## 7. Verification and recovery

Automated tests cover public numeric requester admission, non-numeric/group/thread/destination rejection, duplicate request idempotency, Guest pre-model blocking with `/request_access` guidance, role-gated tool exposure, two-admin stale races, approve-vs-deny, role CAS, stale replay, audit rollback, forged admin IDs in command text, hidden non-admin transitions, cross-peer Draft access, blocked/suspended callers, fixed Admin destinations, and content-free cards.

After restart, request/action/grant state is read from SQLite. No in-memory callback authority exists. Rollback of this code must use the normal database backup/restore procedure; revoking a role never attempts to delete or reverse an already created Jira issue. Jira write remains disabled until the later create stage satisfies its independent gates.
