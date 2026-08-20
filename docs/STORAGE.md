# Persistence, schema and migrations

## 1. Runtime contract

Stage 02 uses the built-in `node:sqlite` API from the pinned Node `24.19.0` runtime. No additional SQLite package or native addon is installed. The plugin owns one database:

```text
<stateDir>/idea-to-jira.sqlite3
```

The effective `stateDir` comes from validated server-side configuration. It is not accepted from a user or model request. Startup uses an OpenClaw plugin service; requests and tools stay fail-closed until migration and consistency checks succeed. Jira create remains disabled independently of storage health.

## 2. Filesystem and connection policy

- state directory: mode `0700` and runtime UID/GID ownership;
- database, WAL, SHM and backup files: mode `0600` and runtime UID/GID ownership;
- symlink state/database paths and unsafe pre-existing sidecars: rejected before SQLite opens them;
- journal mode: WAL;
- foreign keys: enabled and verified;
- busy timeout: bounded, default 5000 ms;
- synchronous mode: `FULL`;
- trusted schema: disabled;
- defensive mode: enabled after migration;
- loadable extensions: disabled.

Container deployments must ensure the bind-mounted `data/plugin-state` path is owned by the UID/GID used by the target image. CI discovers that identity from the built image instead of assuming a host UID.

## 3. Schema v1

Migration `001_initial_schema` creates:

- `users`, `access_requests`, `role_grants`;
- `drafts` plus immutable `draft_versions`;
- `catalog_versions`, normalized `catalog_routes` and `catalog_route_options`;
- `duplicate_checks`;
- `posting_operations`;
- `notifications`;
- append-only `audit_log`.

Persistent enums follow D-025: Draft starts at `EDITING`; a posting operation starts at `PENDING`. `DRAFTING` and `CLAIMED` are not stored aliases.

Important invariants are database-enforced:

- foreign keys and strict tables;
- one active access request per user;
- one active grant per user and role;
- immutable `(draft_id, version)` rows;
- operation uniqueness on `(draft_id, draft_version, payload_hash)` plus a separate unique local idempotency key;
- required attempt count/timestamps before `POSTING`, with Jira identity permitted only in `CREATED`;
- a deferred FK from mutable Draft head to an existing immutable version;
- optimistic `record_version` fields for CAS updates;
- append-only audit triggers;
- checks on status transitions that require timestamps or a Jira key.

Payload hashes and local operation IDs are local consistency keys only. They are not Jira identities and never justify an automatic retry from `UNKNOWN`.

## 4. Migration contract

`schema_migrations` stores contiguous version, name, SHA-256 checksum and application time. `PRAGMA user_version` must exactly match the latest recorded migration. The runner:

1. validates the in-code contiguous migration registry;
2. inspects current history without mutating the database;
3. requires a verified private `pre-upgrade.sqlite3` snapshot before upgrading any non-empty existing schema;
4. acquires `BEGIN IMMEDIATE`;
5. creates metadata only for a genuinely empty fresh database;
6. compares all recorded names/checksums with code;
7. rejects future, partial or modified history;
8. applies each migration and its metadata in one transaction;
9. updates `user_version` in that same transaction;
10. reruns history validation after every version.

DDL or metadata failure rolls back the whole migration. A database with application tables but no migration history is rejected instead of guessed or adopted.

Published migrations are immutable. Schema changes require a new numbered file and contract tests; never edit an applied migration in place.

## 5. Health and startup failure

Startup accepts storage only after all of these pass:

- application ID equals `0x49544a31`;
- schema version equals the supported migration registry;
- `PRAGMA quick_check` returns exactly `ok`;
- `PRAGMA foreign_key_check` returns no rows;
- filesystem and connection policy checks pass.

A failed check disables the plugin's request/tool surface with a stable non-secret error code. The database is closed. Operators must repair or restore storage before service restart; Jira writes are not a recovery mechanism.

## 6. Transactions and concurrency

Use the repository unit-of-work boundary for reads and writes. The mutable `DatabaseSync` connection is private to the storage module and is not returned to callers. Transaction sessions accept only static application `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH` statements; PRAGMA, DDL and transaction control are denied. A callback must be synchronous; do not hold SQLite transactions across Jira, model, STT, Telegram or filesystem network work.

Critical role/posting transactions require `synchronous=FULL` and `BEGIN IMMEDIATE`. Concurrent writers receive a bounded busy/locked failure. Operation claiming is an insert with the unique operation key, so only one committed claim can win. Draft head updates use `record_version` in the `WHERE` clause; zero changed rows means a stale writer and must not be overwritten silently.

## 7. Backup and restore

Create a consistent snapshot only through `PluginDatabase.createConsistentBackup(destination)`, which uses Node's SQLite online backup API. The destination must be a new file under a private directory; backup never overwrites an existing target.

Before deploying a release with migrations beyond the live version, use the currently running release to create `<stateDir>/pre-upgrade.sqlite3`. Startup verifies ownership, mode, application ID, migration checksum history, current version, `quick_check` and foreign keys before applying the first pending migration. Missing, stale-version or tampered backup fails closed. A genuinely empty fresh database is the only exemption.

Minimum operator restore procedure:

1. stop the plugin service so no live connection references the target;
2. preserve the failed database and any WAL/SHM as incident evidence;
3. place the selected backup at a new private path with directory `0700` and file `0600`;
4. open it with the same release and run migration-history, application-ID, `quick_check` and foreign-key checks;
5. verify expected durable records and schema version;
6. switch the configured state path only through the normal reviewed deployment process;
7. start the service and confirm storage readiness while create mode remains disabled.

Do not copy only the live `.sqlite3` file while WAL mode is active. Use the backup API or stop the service and preserve the complete SQLite file set. RPO/RTO and backup cadence remain production inputs O-006.

## 8. Verification

Host checks:

```bash
npm run test
npm run check
npm run verify:create-disabled
```

Target-container check:

```bash
docker compose --env-file .env.example build openclaw-gateway
image="idea-to-jira-openclaw:2026.7.1-2"
runtime_uid="$(docker run --rm --entrypoint id "$image" -u)"
runtime_gid="$(docker run --rm --entrypoint id "$image" -g)"
sudo chown -R "$runtime_uid:$runtime_gid" data/plugin-state
chmod 0700 data/plugin-state
docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --mount type=bind,src="$PWD/data/plugin-state",dst=/home/node/.openclaw/plugin-state \
  --entrypoint node "$image" /app/scripts/storage-container-check.mjs
```

The automated suite covers fresh install, v0 upgrade, mandatory/tampered pre-upgrade backup, repeat execution, interrupted migration rollback, checksum drift, future/partial schema rejection, head/version FK integrity, constraints, CAS, concurrent claim, abrupt-process WAL restart, production-path restore, corruption, ownership and private modes.
