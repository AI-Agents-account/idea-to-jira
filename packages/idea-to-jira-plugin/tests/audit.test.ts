import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createAuditEvent, hashAuditActorReference } from "../src/audit/event.js";
import { SanitizedAuditExporter } from "../src/audit/export.js";
import { AuditedCriticalOperation, SqliteAuditWriter } from "../src/audit/writer.js";
import { openPluginDatabase } from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations/index.js";
import { runMigrations } from "../src/storage/migrations/runner.js";

function stateDir(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `audit-${label}-`)), "state");
}

function roleEvent(eventId: string, actorUserId = "admin-1") {
  return createAuditEvent({
    eventId,
    occurredAt: "2026-08-20T12:00:00.000Z",
    actor: { kind: "USER", userId: actorUserId, refHash: "a".repeat(64) },
    action: "ROLE_TRANSITION",
    target: { type: "ROLE_GRANT", id: "grant-1" },
    outcome: "SUCCEEDED",
    code: "ROLE_GRANTED",
    links: { correlationId: "correlation-1", requestId: "request-1" },
    detailsHash: "b".repeat(64),
    retentionClass: "AUDIT_1Y",
  });
}

test("critical state transition and mandatory audit commit atomically", () => {
  const storage = openPluginDatabase({ stateDir: stateDir("atomic") });
  storage.repositories.transaction(({ sql }) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("admin-1", "123456789");
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("user-1", "987654321");
  });
  const audited = new AuditedCriticalOperation(storage.repositories, new SqliteAuditWriter());
  audited.run(roleEvent("event-1"), (sql) => {
    sql.prepare("UPDATE users SET state = 'CREATOR', record_version = record_version + 1 WHERE id = ?").run("user-1");
  });
  const committed = storage.repositories.transaction(({ sql }) => ({
    user: sql.prepare("SELECT state FROM users WHERE id = ?").get("user-1") as { state: string },
    audit: sql.prepare("SELECT operation, outcome FROM audit_log WHERE event_id = ?").get("event-1") as {
      operation: string;
      outcome: string;
    },
  }));
  assert.equal(committed.user.state, "CREATOR");
  assert.equal(committed.audit.operation, "ROLE_TRANSITION");
  assert.equal(committed.audit.outcome, "SUCCEEDED");
  storage.close();
});

test("audit insert failure rolls back a critical transition", () => {
  const storage = openPluginDatabase({ stateDir: stateDir("rollback") });
  storage.repositories.transaction(({ sql }) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("user-1", "123456789");
  });
  const audited = new AuditedCriticalOperation(storage.repositories, new SqliteAuditWriter());
  assert.throws(() => audited.run(roleEvent("event-bad", "missing-actor"), (sql) => {
    sql.prepare("UPDATE users SET state = 'CREATOR' WHERE id = ?").run("user-1");
  }), /foreign key/i);
  const state = storage.repositories.transaction(({ sql }) =>
    sql.prepare("SELECT state FROM users WHERE id = ?").get("user-1") as { state: string });
  assert.equal(state.state, "GUEST");
  storage.close();
});

test("audit is append-only and corrections are new linked events", () => {
  const storage = openPluginDatabase({ stateDir: stateDir("correction") });
  storage.repositories.transaction(({ sql }) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("admin-1", "123456789");
  });
  const writer = new SqliteAuditWriter();
  storage.repositories.criticalTransaction(({ sql }) => writer.append(sql, roleEvent("event-original")));
  const correction = createAuditEvent({
    ...roleEvent("event-correction"),
    outcome: "FAILED",
    code: "ROLE_DECISION_CORRECTED",
    correctionOfEventId: "event-original",
  });
  storage.repositories.criticalTransaction(({ sql }) => writer.append(sql, correction));
  assert.throws(() => storage.repositories.transaction(({ sql }) => {
    sql.prepare("UPDATE audit_log SET code = 'MUTATED' WHERE event_id = ?").run("event-original");
  }), /AUDIT_APPEND_ONLY/);
  assert.throws(() => storage.repositories.transaction(({ sql }) => {
    sql.prepare("DELETE FROM audit_log WHERE event_id = ?").run("event-original");
  }), /AUDIT_APPEND_ONLY/);
  const rows = storage.repositories.transaction(({ sql }) =>
    sql.prepare("SELECT event_id, correction_of_event_id FROM audit_log ORDER BY sequence").all());
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { event_id: "event-original", correction_of_event_id: null },
    { event_id: "event-correction", correction_of_event_id: "event-original" },
  ]);
  storage.close();
});

test("sanitized export is access-controlled, bounded, and excludes actor hashes", () => {
  const storage = openPluginDatabase({ stateDir: stateDir("export") });
  storage.repositories.transaction(({ sql }) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run("admin-1", "123456789");
  });
  storage.repositories.criticalTransaction(({ sql }) => new SqliteAuditWriter().append(sql, roleEvent("event-export")));
  const denied = new SanitizedAuditExporter(storage.repositories, { canExport: () => false });
  assert.throws(() => denied.export({ requesterUserId: "user-1", limit: 10 }), /AUDIT_EXPORT_DENIED/);
  const allowed = new SanitizedAuditExporter(storage.repositories, { canExport: (id) => id === "admin-1" });
  const exported = allowed.export({ requesterUserId: "admin-1", limit: 10 });
  assert.equal(exported.length, 1);
  assert.equal(exported[0]?.action, "ROLE_TRANSITION");
  assert.equal(JSON.stringify(exported).includes("a".repeat(64)), false);
  assert.throws(() => allowed.export({ requesterUserId: "admin-1", limit: 1_001 }), /AUDIT_EXPORT_LIMIT_INVALID/);
  storage.close();
});

test("v1 audit history upgrades without inventing actor or correlation metadata", () => {
  const database = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "audit-upgrade-")), "audit.sqlite3"));
  runMigrations(database, migrations.slice(0, 1));
  database.prepare(
    "INSERT INTO audit_log(event_id, entity_type, operation, outcome, code) VALUES (?, ?, ?, ?, ?)",
  ).run("legacy-event", "draft", "create", "succeeded", "DRAFT_CREATED");
  runMigrations(database, migrations);
  const row = database.prepare(
    "SELECT actor_kind, actor_ref_hash, correlation_id, retention_class, retention_policy_version FROM audit_log WHERE event_id = ?",
  ).get("legacy-event");
  assert.deepEqual({ ...(row as Record<string, unknown>) }, {
    actor_kind: "LEGACY",
    actor_ref_hash: null,
    correlation_id: null,
    retention_class: "AUDIT_1Y",
    retention_policy_version: 1,
  });
  database.close();
});

test("audit envelope rejects unbounded runtime taxonomy and empty identifiers", () => {
  const baseline = {
    eventId: "event-safe",
    occurredAt: "2026-08-20T12:00:00.000Z",
    actor: { kind: "SYSTEM" as const },
    action: "SECURITY_DECISION" as const,
    target: { type: "SECURITY_BOUNDARY" as const },
    outcome: "REJECTED" as const,
    code: "ACCOUNT_DENIED",
    links: {},
    retentionClass: "AUDIT_1Y" as const,
  };
  assert.throws(() => createAuditEvent({ ...baseline, action: "RAW_USER_ACTION" } as never), /AUDIT_ACTION_INVALID/);
  assert.throws(() => createAuditEvent({ ...baseline, outcome: "maybe" } as never), /AUDIT_OUTCOME_INVALID/);
  assert.throws(() => createAuditEvent({ ...baseline, target: { type: "RAW_BODY" } } as never), /AUDIT_TARGET_TYPE_INVALID/);
  assert.throws(() => createAuditEvent({ ...baseline, target: { type: "SECURITY_BOUNDARY", id: "" } }), /AUDIT_TARGET_ID_INVALID/);
});

test("actor references are stable hashes and never raw sender IDs", () => {
  const sender = "123456789";
  const hash = hashAuditActorReference("idea-mvp", sender);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes(sender), false);
  assert.equal(hashAuditActorReference("idea-mvp", sender), hash);
});
