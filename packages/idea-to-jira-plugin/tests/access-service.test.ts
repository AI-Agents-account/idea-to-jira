import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccessService, renderAdminAccessCard } from "../src/access/access-service.js";
import { SqliteAuditWriter } from "../src/audit/writer.js";
import { SafeError } from "../src/errors/safe-error.js";
import type { TrustedRequesterContext } from "../src/runtime/requester-context.js";
import { ensurePrivateStateDirectory } from "../src/runtime/state.js";
import { openPluginDatabase, type PluginDatabase } from "../src/storage/database.js";
import type { SqlExecutor } from "../src/storage/transaction.js";
import { effectiveConfig } from "./config-fixture.js";

function requester(senderId: string): TrustedRequesterContext {
  return Object.freeze({
    agentId: "idea-mvp",
    channelId: "telegram",
    accountId: "default",
    senderId,
    chatId: senderId,
  });
}

const ADMIN = requester("123456789");
const USER = requester("222222222");
const OTHER = requester("333333333");

function stateDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `idea-to-jira-access-${label}-`));
  const stateDir = join(root, "state");
  ensurePrivateStateDirectory(stateDir);
  return stateDir;
}

function fixture(label: string): { storage: PluginDatabase; service: AccessService } {
  const storage = openPluginDatabase({ stateDir: stateDirectory(label) });
  return {
    storage,
    service: new AccessService({ unitOfWork: storage.repositories, config: effectiveConfig() }),
  };
}

function safeCode(error: unknown, code: string): boolean {
  return error instanceof SafeError && error.code === code;
}

function auditCount(storage: PluginDatabase, operation: string): number {
  return storage.repositories.transaction(({ sql }) => {
    const row = sql.prepare("SELECT count(*) AS count FROM audit_log WHERE operation = ?").get(operation) as {
      count: number;
    };
    return row.count;
  });
}

function createDraft(storage: PluginDatabase, ownerUserId: string, draftId: string): void {
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare("INSERT INTO drafts(id, owner_user_id) VALUES (?, ?)").run(draftId, ownerUserId);
    sql.prepare(`
      INSERT INTO draft_versions(
        draft_id, version, summary, problem, desired_outcome, provenance_hash
      ) VALUES (?, 1, 'Summary', 'Problem', 'Outcome', ?)
    `).run(draftId, "a".repeat(64));
  });
}

test("new sender becomes Guest and access request is idempotent and content-free", () => {
  const { storage, service } = fixture("request");
  const guest = service.ensureUser(USER, {
    username: " unsafe\nname ",
    displayName: " Example\u0000 User ",
  });
  assert.equal(guest.userState, "GUEST");
  assert.equal(guest.userVersion, 1);

  const first = service.requestAccess(USER, {
    username: "ignored-new-value",
    displayName: "ignored-new-value",
  });
  assert.equal(first.created, true);
  assert.equal(first.status.userState, "PENDING");
  assert.equal(first.status.request?.state, "PENDING");
  assert.match(first.adminCard?.actionRef ?? "", /^[A-Za-z0-9_-]{20,64}$/);
  const card = renderAdminAccessCard(first.adminCard!);
  assert.match(card, /Sender ID: 222222222/);
  assert.match(card, /Username snapshot: unsafe name/);
  assert.match(card, /Display name snapshot: Example User/);
  assert.doesNotMatch(card, /summary|problem|Jira candidate/i);

  const second = service.requestAccess(USER);
  assert.equal(second.created, false);
  assert.equal(second.status.request?.requestRef, first.status.request?.requestRef);
  assert.equal(second.status.request?.version, 1);
  assert.equal(auditCount(storage, "ACCESS_DECISION"), 1);
  storage.close();
});

test("only a host-derived allowlisted admin can approve and replay is stale", () => {
  const { storage, service } = fixture("approve");
  const pending = service.requestAccess(USER);
  const actionRef = pending.status.request!.actionRef;

  assert.throws(
    () => service.decideAccess(OTHER, { actionRef, expectedVersion: 1, decision: "APPROVE" }),
    (error) => safeCode(error, "ACCESS_DENIED"),
  );
  const approved = service.decideAccess(ADMIN, {
    actionRef,
    expectedVersion: 1,
    decision: "APPROVE",
    reason: " checked\nby admin ",
  });
  assert.equal(approved.requestState, "APPROVED");
  assert.equal(approved.userState, "CREATOR");
  assert.equal(approved.role?.state, "ACTIVE");
  assert.equal(approved.role?.version, 1);

  const auditBeforeReplay = storage.repositories.transaction(({ sql }) =>
    (sql.prepare("SELECT count(*) AS count FROM audit_log").get() as { count: number }).count);
  assert.throws(
    () => service.decideAccess(ADMIN, { actionRef, expectedVersion: 1, decision: "DENY" }),
    (error) => safeCode(error, "ACCESS_REQUEST_STALE"),
  );
  const auditAfterReplay = storage.repositories.transaction(({ sql }) =>
    (sql.prepare("SELECT count(*) AS count FROM audit_log").get() as { count: number }).count);
  assert.equal(auditAfterReplay, auditBeforeReplay);
  assert.equal(service.getStatus(USER).userState, "CREATOR");
  assert.equal(auditCount(storage, "ROLE_TRANSITION"), 1);
  storage.close();
});

test("deny, pending block and explicit unblock follow the state table", () => {
  const deniedFixture = fixture("deny");
  const deniedRequest = deniedFixture.service.requestAccess(USER);
  const denied = deniedFixture.service.decideAccess(ADMIN, {
    actionRef: deniedRequest.status.request!.actionRef,
    expectedVersion: 1,
    decision: "DENY",
  });
  assert.equal(denied.userState, "GUEST");
  assert.equal(denied.requestState, "DENIED");
  const retry = deniedFixture.service.requestAccess(USER);
  assert.equal(retry.created, true);
  assert.notEqual(retry.status.request?.requestRef, deniedRequest.status.request?.requestRef);
  deniedFixture.storage.close();

  const blockedFixture = fixture("pending-block");
  const blockedRequest = blockedFixture.service.requestAccess(USER);
  const blocked = blockedFixture.service.decideAccess(ADMIN, {
    actionRef: blockedRequest.status.request!.actionRef,
    expectedVersion: 1,
    decision: "BLOCK",
  });
  assert.equal(blocked.userState, "BLOCKED");
  assert.throws(
    () => blockedFixture.service.requestAccess(USER),
    (error) => safeCode(error, "ACCESS_DENIED"),
  );
  const unblocked = blockedFixture.service.unblockUser(ADMIN, {
    userRef: blocked.userRef,
    expectedVersion: blocked.userVersion,
  });
  assert.equal(unblocked.userState, "GUEST");
  blockedFixture.storage.close();
});

test("suspend, restore, revoke and block are CAS-protected and revoke Creator-only access", () => {
  const { storage, service } = fixture("roles");
  const pending = service.requestAccess(USER);
  const approved = service.decideAccess(ADMIN, {
    actionRef: pending.status.request!.actionRef,
    expectedVersion: 1,
    decision: "APPROVE",
  });
  const grantRef = approved.role!.grantRef;
  createDraft(storage, approved.userRef, "draft-own");
  assert.deepEqual(service.authorizeOwnDraft(USER, "draft-own"), { allowed: true });
  assert.deepEqual(service.authorizeCreatorOperation(USER, "draft-own"), { allowed: true });
  service.ensureUser(OTHER);
  assert.deepEqual(service.authorizeOwnDraft(OTHER, "draft-own"), {
    allowed: false,
    code: "OWNER_REQUIRED",
  });
  assert.deepEqual(service.authorizeCreatorOperation(OTHER, "draft-own"), {
    allowed: false,
    code: "OWNER_REQUIRED",
  });

  const suspended = service.transitionRole(ADMIN, {
    grantRef,
    expectedVersion: 1,
    transition: "SUSPEND",
  });
  assert.equal(suspended.grantState, "SUSPENDED");
  assert.equal(suspended.userState, "SUSPENDED");
  assert.deepEqual(service.authorizeCreatorOperation(USER, "draft-own"), {
    allowed: false,
    code: "CREATOR_REQUIRED",
  });
  assert.throws(
    () => service.transitionRole(ADMIN, { grantRef, expectedVersion: 1, transition: "REVOKE" }),
    (error) => safeCode(error, "ROLE_STALE"),
  );

  const restored = service.transitionRole(ADMIN, {
    grantRef,
    expectedVersion: suspended.grantVersion,
    transition: "RESTORE",
  });
  assert.equal(restored.grantState, "ACTIVE");
  assert.equal(restored.userState, "CREATOR");
  const revoked = service.transitionRole(ADMIN, {
    grantRef,
    expectedVersion: restored.grantVersion,
    transition: "REVOKE",
  });
  assert.equal(revoked.grantState, "REVOKED");
  assert.equal(revoked.userState, "GUEST");
  assert.deepEqual(service.authorizeCreatorOperation(USER, "draft-own"), {
    allowed: false,
    code: "CREATOR_REQUIRED",
  });
  storage.close();
});

test("approve-vs-deny and duplicate approve preserve the first committed outcome", () => {
  for (const [label, firstDecision, secondDecision] of [
    ["approve-race", "APPROVE", "APPROVE"],
    ["mixed-race", "DENY", "APPROVE"],
  ] as const) {
    const stateDir = stateDirectory(label);
    const firstStorage = openPluginDatabase({ stateDir, busyTimeoutMs: 50 });
    const secondStorage = openPluginDatabase({ stateDir, busyTimeoutMs: 50 });
    const first = new AccessService({ unitOfWork: firstStorage.repositories, config: effectiveConfig() });
    const second = new AccessService({ unitOfWork: secondStorage.repositories, config: effectiveConfig() });
    const pending = first.requestAccess(USER);
    const actionRef = pending.status.request!.actionRef;
    const winner = first.decideAccess(ADMIN, {
      actionRef,
      expectedVersion: 1,
      decision: firstDecision,
    });
    assert.throws(
      () => second.decideAccess(ADMIN, { actionRef, expectedVersion: 1, decision: secondDecision }),
      (error) => safeCode(error, "ACCESS_REQUEST_STALE"),
    );
    assert.equal(second.getStatus(USER).userState, winner.userState);
    secondStorage.close();
    firstStorage.close();
  }
});

test("role revoke race commits once and role block denies even own Draft access", () => {
  const stateDir = stateDirectory("role-race");
  const firstStorage = openPluginDatabase({ stateDir, busyTimeoutMs: 50 });
  const secondStorage = openPluginDatabase({ stateDir, busyTimeoutMs: 50 });
  const first = new AccessService({ unitOfWork: firstStorage.repositories, config: effectiveConfig() });
  const second = new AccessService({ unitOfWork: secondStorage.repositories, config: effectiveConfig() });
  const pending = first.requestAccess(USER);
  const approved = first.decideAccess(ADMIN, {
    actionRef: pending.status.request!.actionRef,
    expectedVersion: 1,
    decision: "APPROVE",
  });
  const grantRef = approved.role!.grantRef;
  const revoked = first.transitionRole(ADMIN, {
    grantRef,
    expectedVersion: 1,
    transition: "REVOKE",
  });
  assert.equal(revoked.userState, "GUEST");
  assert.throws(
    () => second.transitionRole(ADMIN, { grantRef, expectedVersion: 1, transition: "BLOCK" }),
    (error) => safeCode(error, "ROLE_STALE"),
  );
  secondStorage.close();
  firstStorage.close();

  const blockedFixture = fixture("role-block");
  const blockedPending = blockedFixture.service.requestAccess(USER);
  const blockedApproved = blockedFixture.service.decideAccess(ADMIN, {
    actionRef: blockedPending.status.request!.actionRef,
    expectedVersion: 1,
    decision: "APPROVE",
  });
  createDraft(blockedFixture.storage, blockedApproved.userRef, "blocked-own-draft");
  const blocked = blockedFixture.service.transitionRole(ADMIN, {
    grantRef: blockedApproved.role!.grantRef,
    expectedVersion: 1,
    transition: "BLOCK",
  });
  assert.equal(blocked.userState, "BLOCKED");
  assert.deepEqual(blockedFixture.service.authorizeOwnDraft(USER, "blocked-own-draft"), {
    allowed: false,
    code: "SUBJECT_BLOCKED",
  });
  assert.deepEqual(blockedFixture.service.authorizeCreatorOperation(USER, "blocked-own-draft"), {
    allowed: false,
    code: "SUBJECT_BLOCKED",
  });
  blockedFixture.storage.close();
});

test("audit failure rolls back the access decision and role grant atomically", () => {
  const { storage, service } = fixture("audit-rollback");
  const pending = service.requestAccess(USER);
  class FailingAuditWriter extends SqliteAuditWriter {
    override append(_sql: SqlExecutor): void {
      throw new Error("AUDIT_APPEND_FAILED");
    }
  }
  const failing = new AccessService({
    unitOfWork: storage.repositories,
    config: effectiveConfig(),
    auditWriter: new FailingAuditWriter(),
  });
  assert.throws(() => failing.decideAccess(ADMIN, {
    actionRef: pending.status.request!.actionRef,
    expectedVersion: 1,
    decision: "APPROVE",
  }), /AUDIT_APPEND_FAILED/);
  const status = service.getStatus(USER);
  assert.equal(status.userState, "PENDING");
  assert.equal(status.request?.state, "PENDING");
  assert.equal(status.role, undefined);
  storage.close();
});
