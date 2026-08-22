import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DATABASE_FILENAME,
  openPluginDatabase,
  type PluginDatabase,
} from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations/index.js";
import { runMigrations, MigrationError } from "../src/storage/migrations/runner.js";
import { defineMigration } from "../src/storage/migrations/types.js";
import type { SqlExecutor } from "../src/storage/transaction.js";
import { ensurePrivateStateDirectory } from "../src/runtime/state.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function stateDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `idea-to-jira-${label}-`));
  const stateDir = join(root, "state");
  ensurePrivateStateDirectory(stateDir);
  return stateDir;
}

function withSql<T>(storage: PluginDatabase, work: (sql: SqlExecutor) => T): T {
  return storage.repositories.transaction(({ sql }) => work(sql));
}

function insertUser(storage: PluginDatabase, id: string, senderId: string): void {
  withSql(storage, (sql) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run(id, senderId);
  });
}

function insertDraft(storage: PluginDatabase, id: string, ownerId: string): void {
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare("INSERT INTO drafts(id, owner_user_id) VALUES (?, ?)").run(id, ownerId);
    sql.prepare(
      "INSERT INTO draft_versions(draft_id, version, summary, problem, desired_outcome, provenance_hash) VALUES (?, 1, ?, ?, ?, ?)",
    ).run(id, "Summary", "Problem", "Outcome", HASH_A);
  });
}

function insertPendingOperation(
  storage: PluginDatabase,
  operationId: string,
  draftId: string,
  idempotencyKey: string,
): void {
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key) VALUES (?, ?, 1, ?, ?)",
    ).run(operationId, draftId, HASH_A, idempotencyKey);
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function assertRuntimeOwner(path: string): void {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("POSIX_IDENTITY_REQUIRED");
  }
  assert.equal(statSync(path).uid, process.getuid());
  assert.equal(statSync(path).gid, process.getgid());
}

test("fresh storage schema v5 is deterministic and fixes canonical persistent enums", () => {
  const stateDir = stateDirectory("fresh");
  const storage = openPluginDatabase({ stateDir });
  assert.deepEqual(storage.health, {
    healthy: true,
    schemaVersion: 5,
    quickCheck: "ok",
    foreignKeyViolations: 0,
  });

  const tables = withSql(storage, (sql) => sql.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => (row as { name: string }).name));
  assert.deepEqual(tables, [
    "access_requests",
    "audit_log",
    "catalog_route_options",
    "catalog_routes",
    "catalog_versions",
    "draft_versions",
    "drafts",
    "duplicate_checks",
    "jira_confirmations",
    "jira_duplicate_decisions",
    "jira_field_answers",
    "notifications",
    "posting_operations",
    "role_grants",
    "schema_migrations",
    "users",
  ]);

  insertUser(storage, "user-1", "123456789");
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("INSERT INTO drafts(id, owner_user_id, state) VALUES (?, ?, ?)").run(
      "draft-invalid",
      "user-1",
      "DRAFTING",
    );
  }), /constraint/i);
  insertDraft(storage, "draft-1", "user-1");
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare(
      "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key, state) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("operation-invalid", "draft-1", 1, HASH_A, "idem-invalid", "CLAIMED");
  }), /constraint/i);

  assert.equal(mode(stateDir), 0o700);
  assert.equal(mode(storage.path), 0o600);
  assertRuntimeOwner(stateDir);
  assertRuntimeOwner(storage.path);
  storage.close();
});

test("FK, CHECK and unique constraints enforce access, draft and claim invariants", () => {
  const storage = openPluginDatabase({ stateDir: stateDirectory("constraints") });
  insertUser(storage, "user-1", "123456789");
  insertUser(storage, "admin-1", "987654321");
  insertDraft(storage, "draft-1", "user-1");

  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("INSERT INTO drafts(id, owner_user_id) VALUES (?, ?)").run("orphan", "missing");
  }), /foreign key/i);
  withSql(storage, (sql) => {
    sql.prepare("INSERT INTO access_requests(id, user_id, action_ref) VALUES (?, ?, ?)").run(
      "request-1",
      "user-1",
      "request_action_ref_000001",
    );
  });
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("INSERT INTO access_requests(id, user_id, action_ref) VALUES (?, ?, ?)").run(
      "request-2",
      "user-1",
      "request_action_ref_000002",
    );
  }), /unique/i);

  insertPendingOperation(storage, "operation-1", "draft-1", "idem-1");
  assert.throws(
    () => insertPendingOperation(storage, "operation-2", "draft-1", "idem-2"),
    /unique/i,
  );
  assert.throws(() => storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key) VALUES (?, ?, 1, ?, ?)",
    ).run("operation-3", "draft-1", HASH_B, "idem-1");
  }), /unique/i);
  storage.close();
});

test("critical transaction rolls back fully and draft head supports FK-protected CAS", () => {
  const storage = openPluginDatabase({ stateDir: stateDirectory("transaction") });
  assert.throws(() => storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("user-1", "123456789");
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("user-2", "123456789");
  }), /unique/i);
  const count = withSql(storage, (sql) => sql.prepare("SELECT count(*) AS count FROM users").get()) as {
    count: number;
  };
  assert.equal(count.count, 0);
  assert.throws(() => withSql(storage, (sql) => sql.prepare("PRAGMA foreign_keys = OFF")), /REPOSITORY_SQL_DENIED/);

  insertUser(storage, "user-1", "123456789");
  insertDraft(storage, "draft-1", "user-1");
  const first = storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "INSERT INTO draft_versions(draft_id, version, summary, problem, desired_outcome, provenance_hash) VALUES (?, 2, ?, ?, ?, ?)",
    ).run("draft-1", "Version 2", "Problem", "Outcome", HASH_B);
    return sql.prepare(
      "UPDATE drafts SET head_version = 2, record_version = record_version + 1 WHERE id = ? AND record_version = ?",
    ).run("draft-1", 1);
  });
  const stale = withSql(storage, (sql) => sql.prepare(
    "UPDATE drafts SET head_version = 3, record_version = record_version + 1 WHERE id = ? AND record_version = ?",
  ).run("draft-1", 1));
  assert.equal(first.changes, 1);
  assert.equal(stale.changes, 0);
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("UPDATE drafts SET head_version = 99 WHERE id = ?").run("draft-1");
  }), /foreign key/i);
  storage.close();
});

test("Draft versions are immutable and audit is append-only", () => {
  const storage = openPluginDatabase({ stateDir: stateDirectory("immutable") });
  insertUser(storage, "user-1", "123456789");
  insertDraft(storage, "draft-1", "user-1");
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("UPDATE draft_versions SET summary = ? WHERE draft_id = ? AND version = 1").run(
      "Changed",
      "draft-1",
    );
  }), /DRAFT_VERSION_IMMUTABLE/);
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("DELETE FROM draft_versions WHERE draft_id = ? AND version = 1").run("draft-1");
  }), /DRAFT_VERSION_IMMUTABLE/);
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("DELETE FROM drafts WHERE id = ?").run("draft-1");
  }), /constraint|DRAFT_VERSION_IMMUTABLE/i);

  withSql(storage, (sql) => {
    sql.prepare(
      "INSERT INTO audit_log(event_id, actor_user_id, entity_type, entity_id, operation, outcome, code, details_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("event-1", "user-1", "draft", "draft-1", "create", "succeeded", "DRAFT_CREATED", HASH_B);
  });
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("UPDATE audit_log SET code = ? WHERE event_id = ?").run("CHANGED", "event-1");
  }), /AUDIT_APPEND_ONLY/);
  assert.throws(() => withSql(storage, (sql) => {
    sql.prepare("DELETE FROM audit_log WHERE event_id = ?").run("event-1");
  }), /AUDIT_APPEND_ONLY/);
  storage.close();
});

test("posting metadata proves network attempts and never stores a guessed Jira identity", () => {
  const storage = openPluginDatabase({ stateDir: stateDirectory("posting-contract") });
  insertUser(storage, "user-1", "123456789");
  insertDraft(storage, "draft-1", "user-1");
  insertPendingOperation(storage, "operation-1", "draft-1", "idem-1");
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "UPDATE posting_operations SET state = 'FAILED_FINAL', error_code = 'SAFE_PRE_NETWORK_CANCEL', record_version = record_version + 1 WHERE id = ?",
    ).run("operation-1");
  });

  assert.throws(() => storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key, state) VALUES (?, ?, 1, ?, ?, 'POSTING')",
    ).run("operation-2", "draft-1", HASH_B, "idem-2");
  }), /constraint/i);
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key, state, attempt_count, network_started_at, last_attempt_at) VALUES (?, ?, 1, ?, ?, 'POSTING', 1, ?, ?)",
    ).run("operation-2", "draft-1", HASH_B, "idem-2", "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  });
  assert.throws(() => storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "UPDATE posting_operations SET state = 'UNKNOWN', jira_issue_id = '1', jira_issue_key = 'FPF-1', record_version = record_version + 1 WHERE id = ?",
    ).run("operation-2");
  }), /constraint/i);
  storage.close();
});

test("busy timeout is bounded and a committed concurrent operation claim remains unique", () => {
  const stateDir = stateDirectory("busy");
  const first = openPluginDatabase({ stateDir, busyTimeoutMs: 25 });
  const second = openPluginDatabase({ stateDir, busyTimeoutMs: 25 });
  insertUser(first, "user-1", "123456789");
  insertDraft(first, "draft-1", "user-1");

  first.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(
      "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key) VALUES (?, ?, 1, ?, ?)",
    ).run("operation-1", "draft-1", HASH_A, "idem-1");
    assert.throws(() => second.repositories.criticalTransaction(({ sql: competing }) => {
      competing.prepare(
        "INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key) VALUES (?, ?, 1, ?, ?)",
      ).run("operation-2", "draft-1", HASH_A, "idem-2");
    }), /busy|locked/i);
  });

  assert.throws(() => insertPendingOperation(second, "operation-2", "draft-1", "idem-2"), /unique/i);
  second.close();
  first.close();
});

test("migration runner upgrades v0, is repeat-safe and rejects changed history", () => {
  const path = join(stateDirectory("upgrade"), "upgrade.sqlite3");
  const database = new DatabaseSync(path);
  assert.equal(runMigrations(database, []), 0);
  assert.equal(runMigrations(database, migrations), 5);
  assert.equal(runMigrations(database, migrations), 5);
  database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(HASH_B);
  assert.throws(
    () => runMigrations(database, migrations),
    (error) => error instanceof MigrationError && error.code === "MIGRATION_HISTORY_MISMATCH",
  );
  database.close();
});

test("v2 RBAC upgrade backfills opaque action references and rejects later removal", () => {
  const database = new DatabaseSync(join(stateDirectory("rbac-upgrade"), "rbac-upgrade.sqlite3"));
  runMigrations(database, migrations.slice(0, 2));
  database.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("user-1", "123456789");
  database.prepare("INSERT INTO access_requests(id, user_id) VALUES (?, ?)").run("request-1", "user-1");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("INSERT INTO drafts(id, owner_user_id) VALUES (?, ?)").run("draft-legacy", "user-1");
    database.prepare(`
      INSERT INTO draft_versions(
        draft_id, version, summary, problem, desired_outcome, evidence_json, provenance_hash
      ) VALUES (?, 1, ?, ?, ?, ?, ?)
    `).run("draft-legacy", "Legacy summary", "Legacy context", "Legacy goal", '["Legacy metric"]', HASH_A);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.equal(runMigrations(database, migrations), 5);
  const row = database.prepare("SELECT action_ref FROM access_requests WHERE id = ?").get("request-1") as {
    action_ref: string;
  };
  assert.match(row.action_ref, /^[a-f0-9]{48}$/);
  const backfill = database.prepare(`
    SELECT domain_json, completeness_json, readiness_json, draft_schema_version, formatter_version
    FROM draft_versions WHERE draft_id = 'draft-legacy' AND version = 1
  `).get() as {
    domain_json: string;
    completeness_json: string;
    readiness_json: string;
    draft_schema_version: number;
    formatter_version: number;
  };
  const domain = JSON.parse(backfill.domain_json) as Record<string, { value: unknown; provenance: string }>;
  assert.deepEqual(domain.summary, { value: "Legacy summary", provenance: "USER_STATED" });
  assert.deepEqual(domain.targetAudience, { value: null, provenance: "UNKNOWN" });
  assert.deepEqual(JSON.parse(backfill.completeness_json), { complete: false, reasons: ["LEGACY_INCOMPLETE"] });
  assert.equal((JSON.parse(backfill.readiness_json) as { ready: boolean }).ready, false);
  assert.equal(backfill.draft_schema_version, 1);
  assert.equal(backfill.formatter_version, 1);
  assert.throws(
    () => database.prepare(`
      UPDATE draft_versions SET summary = 'Changed'
      WHERE draft_id = 'draft-legacy' AND version = 1
    `).run(),
    /DRAFT_VERSION_IMMUTABLE/,
  );
  assert.throws(
    () => database.prepare("UPDATE access_requests SET action_ref = NULL WHERE id = ?").run("request-1"),
    /ACCESS_REQUEST_ACTION_REF_REQUIRED/,
  );
  database.close();
});

test("interrupted migration rolls back DDL, metadata and user_version", () => {
  const database = new DatabaseSync(join(stateDirectory("interrupted"), "interrupted.sqlite3"));
  const broken = defineMigration(
    1,
    "broken",
    "CREATE TABLE partial_table(id INTEGER PRIMARY KEY) STRICT; INSERT INTO missing_table VALUES (1);",
  );
  assert.throws(
    () => runMigrations(database, [broken]),
    (error) => error instanceof MigrationError && error.code === "MIGRATION_APPLY_FAILED",
  );
  const partial = database.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'partial_table'",
  ).get() as { count: number };
  const applied = database.prepare("SELECT count(*) AS count FROM schema_migrations").get() as { count: number };
  const userVersion = database.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(partial.count, 0);
  assert.equal(applied.count, 0);
  assert.equal(userVersion.user_version, 0);
  database.close();
});

test("an untracked application table is rejected without adopting or mutating it", () => {
  const database = new DatabaseSync(join(stateDirectory("untracked"), "untracked.sqlite3"));
  database.exec("CREATE TABLE legacy_data(id INTEGER PRIMARY KEY) STRICT");
  assert.throws(
    () => runMigrations(database, migrations),
    (error) => error instanceof MigrationError && error.code === "MIGRATION_PARTIAL_STATE",
  );
  const metadata = database.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { count: number };
  assert.equal(metadata.count, 0);
  database.close();
});

test("future and partially recorded schema versions fail closed", () => {
  const future = new DatabaseSync(join(stateDirectory("future"), "future.sqlite3"));
  runMigrations(future, migrations);
  future.prepare("INSERT INTO schema_migrations(version, name, checksum) VALUES (6, ?, ?)").run("future", HASH_B);
  future.exec("PRAGMA user_version = 6");
  assert.throws(
    () => runMigrations(future, migrations),
    (error) => error instanceof MigrationError && error.code === "MIGRATION_FUTURE_SCHEMA",
  );
  future.close();

  const partial = new DatabaseSync(join(stateDirectory("partial"), "partial.sqlite3"));
  runMigrations(partial, migrations);
  partial.exec("PRAGMA user_version = 0");
  assert.throws(
    () => runMigrations(partial, migrations),
    (error) => error instanceof MigrationError && error.code === "MIGRATION_PARTIAL_STATE",
  );
  partial.close();
});

test("verify-current opens only an existing exact schema and never creates or migrates storage", () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "idea-to-jira-verify-missing-"));
  const missingState = join(missingRoot, "state");
  assert.throws(
    () => openPluginDatabase({ stateDir: missingState, migrationMode: "verify-current" }),
  );
  assert.equal(existsSync(missingState), false);

  const stateDir = stateDirectory("verify-current");
  const gatewayStorage = openPluginDatabase({ stateDir });
  gatewayStorage.close();

  const sixthMigration = defineMigration(6, "execution_must_not_migrate", "CREATE TABLE execution_must_not_migrate(id INTEGER PRIMARY KEY) STRICT;");
  assert.throws(
    () => openPluginDatabase({
      stateDir,
      migrationRegistry: [...migrations, sixthMigration],
      migrationMode: "verify-current",
    }),
    /STORAGE_SCHEMA_NOT_CURRENT/,
  );

  const inspection = new DatabaseSync(join(stateDir, DATABASE_FILENAME), { readOnly: true });
  const userVersion = inspection.prepare("PRAGMA user_version").get() as { user_version: number };
  const marker = inspection.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'execution_must_not_migrate'",
  ).get() as { count: number };
  inspection.close();
  assert.equal(userVersion.user_version, migrations.length);
  assert.equal(marker.count, 0);

  const executionStorage = openPluginDatabase({ stateDir, migrationMode: "verify-current" });
  assert.equal(executionStorage.health.schemaVersion, migrations.length);
  executionStorage.close();
});

test("non-empty schema upgrade requires and verifies a consistent pre-upgrade backup", async () => {
  const stateDir = stateDirectory("upgrade-live");
  const storage = openPluginDatabase({ stateDir });
  insertUser(storage, "user-1", "123456789");
  const backupDir = stateDirectory("upgrade-backup");
  const backupPath = join(backupDir, "pre-upgrade.sqlite3");
  await storage.createConsistentBackup(backupPath);
  storage.close();

  const sixthMigration = defineMigration(6, "upgrade_marker", "CREATE TABLE upgrade_marker(id INTEGER PRIMARY KEY) STRICT;");
  const registry = [...migrations, sixthMigration];
  assert.throws(
    () => openPluginDatabase({ stateDir, migrationRegistry: registry }),
    /STORAGE_UPGRADE_BACKUP_REQUIRED/,
  );
  const upgraded = openPluginDatabase({ stateDir, migrationRegistry: registry, upgradeBackupPath: backupPath });
  assert.equal(upgraded.health.schemaVersion, 6);
  const marker = withSql(upgraded, (sql) => sql.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'upgrade_marker'",
  ).get()) as { count: number };
  assert.equal(marker.count, 1);
  upgraded.close();
});

test("tampered pre-upgrade backup is rejected by the production startup path", async () => {
  const stateDir = stateDirectory("tampered-live");
  const storage = openPluginDatabase({ stateDir });
  const backupPath = join(stateDirectory("tampered-backup"), "pre-upgrade.sqlite3");
  await storage.createConsistentBackup(backupPath);
  storage.close();

  const tampered = new DatabaseSync(backupPath);
  tampered.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(HASH_B);
  tampered.close();
  const registry = [
    ...migrations,
    defineMigration(6, "upgrade_marker", "CREATE TABLE upgrade_marker(id INTEGER PRIMARY KEY) STRICT;"),
  ];
  assert.throws(
    () => openPluginDatabase({ stateDir, migrationRegistry: registry, upgradeBackupPath: backupPath }),
    /STORAGE_UPGRADE_BACKUP_INVALID/,
  );
});

test("WAL restart retains a child-process commit without a graceful close", () => {
  const stateDir = stateDirectory("crash-restart");
  const moduleUrl = new URL("../src/storage/database.js", import.meta.url).href;
  const script = `
    const { openPluginDatabase } = await import(${JSON.stringify(moduleUrl)});
    const storage = openPluginDatabase({ stateDir: ${JSON.stringify(stateDir)} });
    storage.repositories.criticalTransaction(({ sql }) => {
      sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("user-1", "123456789");
    });
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);

  const reopened = openPluginDatabase({ stateDir });
  const row = withSql(reopened, (sql) => sql.prepare(
    "SELECT telegram_sender_id FROM users WHERE id = ?",
  ).get("user-1")) as { telegram_sender_id: string };
  assert.equal(row.telegram_sender_id, "123456789");
  assert.equal(reopened.health.healthy, true);
  reopened.close();
});

test("consistent backup is private and restores through production startup", async () => {
  const storage = openPluginDatabase({ stateDir: stateDirectory("backup-source") });
  insertUser(storage, "user-1", "123456789");
  const backupPath = join(stateDirectory("backup-target"), "snapshot.sqlite3");
  await storage.createConsistentBackup(backupPath);
  assert.equal(mode(backupPath), 0o600);
  assertRuntimeOwner(backupPath);

  insertUser(storage, "user-2", "987654321");
  const restoreState = stateDirectory("restore-target");
  const restoredPath = join(restoreState, DATABASE_FILENAME);
  copyFileSync(backupPath, restoredPath);
  chmodSync(restoredPath, 0o600);
  const restored = openPluginDatabase({ stateDir: restoreState });
  const count = withSql(restored, (sql) => sql.prepare("SELECT count(*) AS count FROM users").get()) as {
    count: number;
  };
  assert.equal(count.count, 1);
  restored.close();
  storage.close();
});

test("corruption, over-broad DB or sidecar permissions fail closed before use", () => {
  const corruptState = stateDirectory("corrupt");
  writeFileSync(join(corruptState, DATABASE_FILENAME), "not-a-sqlite-database", { mode: 0o600 });
  assert.throws(() => openPluginDatabase({ stateDir: corruptState }));

  const permissionState = stateDirectory("permissions");
  const storage = openPluginDatabase({ stateDir: permissionState });
  const databasePath = storage.path;
  storage.close();
  chmodSync(databasePath, 0o644);
  assert.throws(() => openPluginDatabase({ stateDir: permissionState }), /STORAGE_PERMISSION_INVALID/);
  chmodSync(databasePath, 0o600);
  writeFileSync(`${databasePath}-wal`, "unsafe-sidecar", { mode: 0o644 });
  assert.throws(() => openPluginDatabase({ stateDir: permissionState }), /STORAGE_PERMISSION_INVALID/);

  const wideDirectory = join(mkdtempSync(join(tmpdir(), "idea-to-jira-wide-")), "state");
  mkdirSync(wideDirectory, { mode: 0o755 });
  const repaired = openPluginDatabase({ stateDir: wideDirectory });
  assert.equal(mode(wideDirectory), 0o700);
  assertRuntimeOwner(wideDirectory);
  repaired.close();
});
