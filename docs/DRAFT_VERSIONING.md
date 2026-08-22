# Draft versioning and READY foundation

## Status and boundary

Stage 05 implements the persisted Draft domain contract. Jira write remains disabled. The Draft tools do not expose a create callback, preview entity, arbitrary Jira fields, JQL, URL, HTTP or transport operation.

Published code constants:

- Draft schema: `DRAFT_SCHEMA_VERSION = 1`;
- JC-004 formatter: `DESCRIPTION_FORMATTER_VERSION = 1`;
- storage schema: migration `004_draft_versioning_readiness` / version 4;
- active Draft limit: `limits.activeDrafts`, deployed default `3`.

## Versioned Draft

A Draft is owned by the user resolved from host-derived Telegram sender identity. The client cannot supply or change an owner. Every read, patch and cancel query joins `drafts` to `users` and includes the sender predicate. A resource owned by another sender is reported as `DRAFT_NOT_FOUND` without its current version.

Each immutable version records:

- `summary`;
- the eight JC-004 description sections: context; goal/problem/opportunity; target audience; proposed solution; acceptance criteria; success metrics; risks/constraints/dependencies; additional details and HTTPS links;
- semantic choice IDs for Marketing Required, Category, Moscow and Impacted Metrics;
- route candidates and selected route ID;
- Catalog, transcript, duplicate, payload-hash and posting references;
- completeness and readiness results;
- Draft schema and formatter versions.

Every field value carries one provenance value:

- `USER_STATED`;
- `USER_CONFIRMED`;
- `MODEL_PROPOSED`;
- `UNKNOWN`;
- `CATALOG_DERIVED`.

`evidenceRef` is an opaque bounded reference, not copied source text. A model proposal cannot replace a confirmed value. A proposal becomes confirmed only through the explicit confirmation transition. Required `MODEL_PROPOSED` and `UNKNOWN` values remain incomplete.

The retained Stage-01 `IdeaInput` name is only a source-compatible intake alias. The former `JiraIssueDraft.status: "ready"` DTO no longer exists and intake now creates a persisted `EDITING` Draft.

## Typed tools

The plugin manifest and agent allowlist contain exactly:

- `idea_to_jira_create_draft`;
- `idea_to_jira_read_draft`;
- `idea_to_jira_patch_draft`;
- `idea_to_jira_cancel_draft`;
- `idea_to_jira_request_access`.

Patch accepts only the declared domain fields, `expectedVersion`, typed provenance and optional evidence references. Unknown properties, arbitrary Jira JSON and client-supplied identity are rejected. Jira create is absent from the tool graph.

### OpenClaw tool-discovery execution

Normal `registrationMode: "full"` keeps the existing service-owned runtime,
hooks, commands and Gateway status method. `registrationMode: "tool-discovery"`
does not register those channel/runtime surfaces. OpenClaw may invoke a factory
for catalog discovery with only workspace and agent metadata, so the factory
publishes the four callable Draft schemas when that sparse context contains no
contradictory route facts. Explicit wrong-agent, wrong-channel, wrong-account,
threaded or mismatched sender/destination contexts receive no schema.
Registration and catalog discovery do not open SQLite, run migrations,
construct Jira clients or start timers. The access-request and Jira tools are
not published by this mode.

A discovered Draft tool executes through a bounded Draft-only runtime lease.
Before SQLite can open, execution requires a complete host-derived Telegram
private-DM identity and enforces payload, create-disabled and
registration-scoped rate gates. The lease borrows a READY Gateway runtime when
one exists and additionally enforces its live policy; otherwise it opens only
the existing configured SQLite database after verifying the exact current
schema version. It never creates or migrates storage. Owned storage closes when
the final overlapping call ends; a failed final close poisons that boundary and
prevents further connections until process restart rather than leaking
unbounded runtimes. It never constructs or starts the Jira workflow.

After storage is available, execution revalidates current conversation RBAC and
records bounded mandatory security audit decisions before owner checks and
Draft CAS rules. Guest, PENDING, SUSPENDED, BLOCKED, malformed, cross-route and
stale-role callers therefore fail closed even though schema discovery itself is
non-activating. BLOCKED overrides configured Business Admin membership. Tool
input remains unable to supply identity, and operational diagnostics disclose
only bounded context shape and reason codes, never sender or route identifiers.

## Validation and formatting

Content is normalized and bounded before persistence:

- summary: 255 characters;
- prose fields: 10,000 characters;
- bounded unique arrays (generally 20 items, route candidates 3, links 10);
- HTTPS links only, with no embedded credentials and no network fetch;
- blank/control-only and placeholder-only values are rejected;
- recognizable credential/private-key input is rejected with only `DRAFT_INVALID`; offending content is not copied into the error or audit.

JC-004 formatter v1 uses fixed Russian headings and confirmed values only. Empty optional sections are omitted uniformly. It emits no hidden markers, correlation IDs, operation markers or placeholders.

## CAS, invalidation and recovery

Create inserts Draft version 1 and its audit event in one `BEGIN IMMEDIATE`, `synchronous=FULL` transaction. Patches compare both `head_version` and `record_version`; a stale writer receives `DRAFT_CONFLICT` with only the current version. A meaningful patch creates one immutable version and advances the head once. An exact no-op does not increment.

Payload/route/fingerprint-significant changes:

- force the new version back to fail-closed evaluation;
- clear Catalog/duplicate/payload/posting references for the new version;
- mark any not-started `PENDING` operation `FAILED_FINAL` with `DRAFT_VERSION_INVALIDATED`;
- retain completed, in-flight and `UNKNOWN` operations and expose them as blocking prior operations.

Evidence-reference-only changes create an immutable provenance version but preserve dependent results because payload semantics did not change. Cancel creates a final immutable version, changes state to `CANCELLED`, preserves history and audit, and releases the active-Draft slot.

SQLite keeps every Draft version. Restart reconstructs the current head, provenance, invalidation and blockers from storage. Existing pre-v4 synthetic Draft rows are backfilled into schema v1 as incomplete and unverified; migration does not infer READY.

## Completeness, questions and READY

Completeness is deterministic. Required content/custom values and selected route must be confirmed or trusted derived data. Question policy returns at most three questions, prioritizes missing/ambiguous required values and never asks a confirmed field again.

`evaluateReadiness` is a pure function with typed snapshots. READY requires all of:

- complete Draft and non-empty deterministic description;
- active Creator proof;
- confirmed/not-required transcript;
- exact current Catalog reference;
- metadata/options proof for the same Draft version;
- duplicate decision `NOT_DUPLICATE` or `NO_CANDIDATES` for the same Draft and Catalog version;
- no current or prior blocking operation.

Missing, stale, failed or unavailable role/Catalog/metadata/duplicate/transcript proof produces a `BLOCKED` reason. The evaluator imports no Jira adapter and cannot perform POST. Runtime still constructs `DisabledJiraIssueClient`, validates `writeMode: "disabled"`, and the readiness script must continue to report create disabled.

## Verification

The suite covers provenance transitions, validation, exact formatter output, bounded questions, readiness matrices, stale CAS, cross-sender denial, significant/non-significant invalidation, `UNKNOWN` preservation, active limit, cancel, restart and end-to-end typed-tool execution. CI continues to run JSON/config validation, type-check/tests, build, create-disabled verification, Compose rendering, container build/storage checks and secret scanning.
