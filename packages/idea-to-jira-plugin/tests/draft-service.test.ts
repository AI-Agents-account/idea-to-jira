import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  contentCompleteness,
  createDraftContent,
  type DraftDependencies,
  type PatchDraftInput,
} from "../src/domain/draft.js";
import { evaluateReadiness } from "../src/domain/readiness.js";
import { SafeError } from "../src/errors/index.js";
import type { TrustedRequesterContext } from "../src/runtime/requester-context.js";
import { openPluginDatabase, type PluginDatabase } from "../src/storage/database.js";
import { SqliteDraftRepository } from "../src/storage/draft-repository.js";
import { ensurePrivateStateDirectory } from "../src/runtime/state.js";
import { formatDescription } from "../src/workflow/description-formatter.js";
import {
  DraftVersionConflict,
  IdeaToJiraDraftService,
} from "../src/workflow/draft-service.js";
import { selectDraftQuestions } from "../src/workflow/question-policy.js";

const owner: TrustedRequesterContext = {
  agentId: "idea-mvp",
  channelId: "telegram",
  accountId: "idea-mvp",
  senderId: "123456789",
  chatId: "123456789",
};
const other: TrustedRequesterContext = { ...owner, senderId: "987654321", chatId: "987654321" };

function stateDirectory(label: string): string {
  const stateDir = join(mkdtempSync(join(tmpdir(), `idea-draft-${label}-`)), "state");
  ensurePrivateStateDirectory(stateDir);
  return stateDir;
}

function insertUser(storage: PluginDatabase, id: string, senderId: string): void {
  storage.repositories.transaction(({ sql }) => {
    sql.prepare("INSERT INTO users(id, telegram_sender_id) VALUES (?, ?)").run(id, senderId);
  });
}

function fixture(label: string, maxActiveDrafts = 3) {
  const storage = openPluginDatabase({ stateDir: stateDirectory(label) });
  insertUser(storage, "owner-user", owner.senderId);
  insertUser(storage, "other-user", other.senderId);
  let sequence = 0;
  const service = new IdeaToJiraDraftService({
    unitOfWork: storage.repositories,
    maxActiveDrafts,
    newId: () => `draft-${++sequence}`,
    now: () => `2026-08-21T09:2${sequence}:00.000Z`,
  });
  return { storage, service };
}

const intake = {
  summary: "Сократить время онбординга",
  context: "Новые пользователи не находят импорт.",
  goalProblemOpportunity: "Сделать первый импорт понятным.",
} as const;

function patch(draftId: string, expectedVersion: number, field: string, value: unknown, source = "USER_STATED"): PatchDraftInput {
  return {
    draftId,
    expectedVersion,
    updates: { [field]: { value, source } },
  } as PatchDraftInput;
}

test("creates, reads and audits a complete version-1 domain Draft without false READY", () => {
  const { storage, service } = fixture("create");
  const result = service.createDraft(owner, {
    ...intake,
    targetAudience: "Новые клиенты",
    proposedSolution: "Показать заметное действие импорта.",
    acceptanceCriteria: ["Пользователь находит импорт без подсказки"],
    marketingRequired: "marketing-no",
    categoryId: "category-growth",
    moscowId: "moscow-no",
    impactedMetricIds: ["activation-rate"],
  });

  assert.equal(result.draft.id, "draft-1");
  assert.equal(result.draft.state, "EDITING");
  assert.equal(result.draft.version, 1);
  assert.equal(result.draft.schemaVersion, 1);
  assert.equal(result.draft.formatterVersion, 1);
  assert.equal(result.draft.content.summary.provenance, "USER_STATED");
  assert.equal(result.draft.content.routeCandidates.provenance, "UNKNOWN");
  assert.equal(result.draft.completeness.complete, false);
  assert.equal(result.draft.readiness.ready, false);
  assert.ok(result.draft.readiness.reasons.some((reason) => reason.code === "ROLE_NOT_ACTIVE"));
  assert.doesNotMatch(result.draft.description, /TBD|operation|correlation/i);
  assert.equal(service.readDraft(owner, result.draft.id).draft.version, 1);

  const audit = storage.repositories.transaction(({ sql }) => sql.prepare(
    "SELECT code, draft_id, draft_version FROM audit_log WHERE entity_id = ?",
  ).get(result.draft.id) as { code: string; draft_id: string; draft_version: number });
  assert.deepEqual({ ...audit }, { code: "DRAFT_CREATED", draft_id: "draft-1", draft_version: 1 });
  storage.close();
});

test("CAS preserves the winner, exposes only current version, and no-op does not increment", () => {
  const { storage, service } = fixture("cas");
  const created = service.createDraft(owner, intake).draft;
  const winner = service.patchDraft(owner, patch(created.id, 1, "targetAudience", "Новые клиенты"));
  assert.equal(winner.draft.version, 2);

  assert.throws(
    () => service.patchDraft(owner, patch(created.id, 1, "proposedSolution", "Другое решение")),
    (error) => error instanceof DraftVersionConflict && error.currentVersion === 2,
  );
  const unchanged = service.patchDraft(owner, patch(created.id, 2, "targetAudience", "Новые клиенты"));
  assert.equal(unchanged.draft.version, 2);
  assert.equal(service.readDraft(owner, created.id).draft.content.targetAudience.value, "Новые клиенты");
  storage.close();
});

test("owner predicate prevents cross-sender read, patch and cancel without leaking a version", () => {
  const { storage, service } = fixture("owner");
  const draft = service.createDraft(owner, intake).draft;
  for (const action of [
    () => service.readDraft(other, draft.id),
    () => service.patchDraft(other, patch(draft.id, 1, "targetAudience", "Чужое значение")),
    () => service.cancelDraft(other, { draftId: draft.id, expectedVersion: 1 }),
  ]) {
    assert.throws(action, (error) => error instanceof SafeError && error.code === "DRAFT_NOT_FOUND");
  }
  storage.close();
});

test("Guest, PENDING, CREATOR and SUSPENDED owners retain own-Draft lifecycle access", () => {
  for (const state of ["GUEST", "PENDING", "CREATOR", "SUSPENDED"] as const) {
    const { storage, service } = fixture(`owner-state-${state.toLowerCase()}`);
    storage.repositories.criticalTransaction(({ sql }) => {
      sql.prepare("UPDATE users SET state = ? WHERE id = 'owner-user'").run(state);
    });
    const created = service.createDraft(owner, intake).draft;
    assert.equal(service.readDraft(owner, created.id).draft.version, 1);
    const patched = service.patchDraft(owner, patch(created.id, 1, "targetAudience", "Новые клиенты")).draft;
    assert.equal(patched.version, 2);
    assert.equal(service.cancelDraft(owner, { draftId: created.id, expectedVersion: 2 }).draft.state, "CANCELLED");
    storage.close();
  }
});

test("BLOCKED owner cannot create, read, patch or cancel through service or repository boundaries", () => {
  const { storage, service } = fixture("blocked-owner");
  const created = service.createDraft(owner, intake).draft;
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare("UPDATE users SET state = 'BLOCKED' WHERE id = 'owner-user'").run();
  });

  assert.throws(
    () => service.createDraft(owner, intake),
    (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
  );
  for (const action of [
    () => service.readDraft(owner, created.id),
    () => service.patchDraft(owner, patch(created.id, 1, "targetAudience", "Blocked update")),
    () => service.cancelDraft(owner, { draftId: created.id, expectedVersion: 1 }),
  ]) {
    assert.throws(action, (error) => error instanceof SafeError && error.code === "DRAFT_NOT_FOUND");
  }

  const repository = new SqliteDraftRepository();
  storage.repositories.criticalTransaction(({ sql }) => {
    assert.equal(repository.findOwnerUserId(sql, owner.senderId), undefined);
    assert.equal(repository.countActiveOwned(sql, owner.senderId), 0);
    assert.equal(repository.findOwnedHead(sql, created.id, owner.senderId), undefined);
    assert.equal(repository.insertDraft(sql, "blocked-draft", "owner-user", created.createdAt), false);
    assert.equal(repository.insertVersion(sql, {
      draftId: created.id,
      version: 2,
      summary: intake.summary,
      problem: intake.context,
      desiredOutcome: intake.goalProblemOpportunity,
      evidenceJson: "[]",
      provenanceHash: "a".repeat(64),
      content: created.content,
      description: created.description,
      completeness: created.completeness,
      readiness: created.readiness,
      dependencies: created.dependencies,
      createdAt: created.updatedAt,
    }), false);
    assert.equal(repository.advanceHead(
      sql,
      created.id,
      owner.senderId,
      1,
      2,
      "EDITING",
      created.updatedAt,
    ), false);
  });
  const counts = storage.repositories.transaction(({ sql }) => ({
    blockedDrafts: (sql.prepare("SELECT count(*) AS count FROM drafts WHERE id = 'blocked-draft'").get() as { count: number }).count,
    versionTwo: (sql.prepare(`
      SELECT count(*) AS count FROM draft_versions WHERE draft_id = ? AND version = 2
    `).get(created.id) as { count: number }).count,
  }));
  assert.deepEqual(counts, { blockedDrafts: 0, versionTwo: 0 });
  storage.close();
});

test("model proposal cannot overwrite a confirmed fact and requires explicit confirmation", () => {
  const { storage, service } = fixture("proposal");
  const draft = service.createDraft(owner, intake).draft;
  const proposed = service.patchDraft(owner, patch(
    draft.id,
    1,
    "targetAudience",
    "Новые клиенты",
    "MODEL_PROPOSED",
  ));
  assert.equal(proposed.draft.content.targetAudience.provenance, "MODEL_PROPOSED");
  assert.ok(proposed.draft.completeness.reasons.includes("UNCONFIRMED_targetAudience"));
  assert.equal(proposed.questions[0]?.kind, "CONFIRM_PROPOSAL");

  const confirmed = service.patchDraft(owner, {
    draftId: draft.id,
    expectedVersion: 2,
    confirmFields: ["targetAudience"],
  });
  assert.equal(confirmed.draft.content.targetAudience.provenance, "USER_CONFIRMED");
  assert.notEqual(confirmed.questions[0]?.field, "targetAudience");
  assert.throws(
    () => service.patchDraft(owner, patch(draft.id, 3, "targetAudience", "Модель передумала", "MODEL_PROPOSED")),
    (error) => error instanceof SafeError && error.code === "DRAFT_INVALID",
  );
  storage.close();
});

test("validation rejects placeholders, secret-like content, arbitrary fields and unsafe links", () => {
  const { storage, service } = fixture("validation");
  for (const summary of ["TBD", "password=do-not-store", "-----BEGIN PRIVATE KEY-----"]) {
    assert.throws(
      () => service.createDraft(owner, { ...intake, summary }),
      (error) => error instanceof Error && !error.message.includes("do-not-store"),
    );
  }
  const draft = service.createDraft(owner, intake).draft;
  assert.throws(
    () => service.patchDraft(owner, {
      draftId: draft.id,
      expectedVersion: 1,
      updates: { jiraFields: { value: { project: "OTHER" }, source: "USER_STATED" } },
    } as unknown as PatchDraftInput),
    (error) => error instanceof SafeError && error.code === "DRAFT_INVALID",
  );
  assert.throws(
    () => service.patchDraft(owner, patch(draft.id, 1, "links", ["http://example.test"])),
    (error) => error instanceof SafeError && error.code === "DRAFT_INVALID",
  );
  storage.close();
});

test("JC-004 formatter is exact, deterministic and omits empty optional sections", () => {
  const content = createDraftContent({
    ...intake,
    targetAudience: "Новые клиенты",
    proposedSolution: "Добавить заметный импорт.",
    acceptanceCriteria: ["Импорт найден", "Импорт запущен"],
    successMetrics: ["Доля первого импорта"],
    risksConstraintsDependencies: ["Зависит от навигации"],
    additionalDetails: ["Проверено на прототипе"],
    links: ["https://example.test/evidence"],
  });
  assert.equal(formatDescription(content), [
    "Контекст\nНовые пользователи не находят импорт.",
    "Цель / Проблема / Возможность\nСделать первый импорт понятным.",
    "Целевая аудитория\nНовые клиенты",
    "Что делаем / Предлагаемое решение\nДобавить заметный импорт.",
    "Критерии приёмки\n1. Импорт найден\n2. Импорт запущен",
    "Ожидаемые метрики успеха\n- Доля первого импорта",
    "Риски / ограничения / зависимости\n- Зависит от навигации",
    "Дополнительные детали и ссылки\n- Проверено на прототипе\n- https://example.test/evidence",
  ].join("\n\n"));
  assert.equal(formatDescription(content), formatDescription(content));
  assert.doesNotMatch(formatDescription(content), /TBD|UNKNOWN|operation|<!--/i);
});

test("readiness is deterministic, requires every current proof, and performs no transport", () => {
  const content = createDraftContent({
    ...intake,
    targetAudience: "Новые клиенты",
    proposedSolution: "Добавить заметный импорт.",
    acceptanceCriteria: ["Импорт найден"],
    marketingRequired: "marketing-no",
    categoryId: "category-growth",
    moscowId: "moscow-no",
    impactedMetricIds: ["activation-rate"],
  });
  const completeness = contentCompleteness({
    ...content,
    selectedRouteId: { value: "route-growth", provenance: "USER_CONFIRMED" },
  });
  const catalogReference = { version: 7, checksum: "a".repeat(64) };
  const dependencies: DraftDependencies = {
    catalog: catalogReference,
    transcript: { state: "CONFIRMED", draftVersion: 4 },
    duplicate: {
      checkId: "duplicate-check-1",
      draftVersion: 4,
      catalogVersion: 7,
      fingerprint: "f".repeat(64),
      state: "NO_CANDIDATES",
      decision: "NO_CANDIDATES",
    },
    posting: null,
    payloadHashRef: null,
    invalidatedByVersion: null,
    blockingPriorOperations: [],
  };
  const proofs = {
    role: { state: "ACTIVE" as const, version: 2 },
    transcript: { state: "CONFIRMED" as const, draftVersion: 4 },
    catalog: { state: "CURRENT" as const, reference: catalogReference },
    metadata: { state: "VALID" as const, draftVersion: 4 },
    duplicate: { state: "NO_CANDIDATES" as const, draftVersion: 4, catalogVersion: 7 },
    operation: { state: "NONE" as const },
  };
  assert.deepEqual(evaluateReadiness(4, completeness, formatDescription(content), dependencies, proofs), {
    ready: true,
    reasons: [],
  });
  const stale = evaluateReadiness(4, completeness, formatDescription(content), dependencies, {
    ...proofs,
    duplicate: { ...proofs.duplicate, draftVersion: 3 },
  });
  assert.equal(stale.ready, false);
  assert.ok(stale.reasons.some((reason) => reason.code === "DUPLICATE_STALE"));
  const inactive = evaluateReadiness(4, completeness, formatDescription(content), dependencies, {
    ...proofs,
    role: { state: "INACTIVE" as const },
  });
  assert.equal(inactive.ready, false);
  const staleTranscript = evaluateReadiness(4, completeness, formatDescription(content), {
    ...dependencies,
    transcript: { state: "CONFIRMED", draftVersion: 3, transcriptRef: "transcript:1" },
  }, {
    ...proofs,
    transcript: { state: "CONFIRMED" as const, draftVersion: 3 },
  });
  assert.ok(staleTranscript.reasons.some((reason) => reason.code === "TRANSCRIPT_UNRESOLVED"));
});

test("significant patch invalidates pending results while evidence-only patch preserves them", () => {
  const { storage, service } = fixture("invalidation");
  const draft = service.createDraft(owner, intake).draft;
  const hash = "a".repeat(64);
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(`
      INSERT INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key)
      VALUES ('pending-op', ?, 1, ?, 'pending-idem')
    `).run(draft.id, hash);
  });

  const evidenceOnly = service.patchDraft(owner, {
    draftId: draft.id,
    expectedVersion: 1,
    updates: { summary: { value: intake.summary, source: "USER_STATED", evidenceRef: "message:1" } },
  });
  assert.equal(evidenceOnly.draft.version, 2);
  const pending = storage.repositories.transaction(({ sql }) => sql.prepare(
    "SELECT state FROM posting_operations WHERE id = 'pending-op'",
  ).get() as { state: string });
  assert.equal(pending.state, "PENDING");

  const significant = service.patchDraft(owner, patch(draft.id, 2, "targetAudience", "Новые клиенты"));
  assert.equal(significant.draft.dependencies.invalidatedByVersion, 2);
  const invalidated = storage.repositories.transaction(({ sql }) => sql.prepare(
    "SELECT state, error_code FROM posting_operations WHERE id = 'pending-op'",
  ).get() as { state: string; error_code: string });
  assert.deepEqual({ ...invalidated }, { state: "FAILED_FINAL", error_code: "DRAFT_VERSION_INVALIDATED" });
  storage.close();
});

test("UNKNOWN operation is preserved and blocks content reuse across a new version", () => {
  const { storage, service } = fixture("unknown-operation");
  const draft = service.createDraft(owner, intake).draft;
  storage.repositories.criticalTransaction(({ sql }) => {
    sql.prepare(`
      INSERT INTO posting_operations(
        id, draft_id, draft_version, payload_hash, idempotency_key, state,
        attempt_count, network_started_at, last_attempt_at
      ) VALUES ('unknown-op', ?, 1, ?, 'unknown-idem', 'UNKNOWN', 1, ?, ?)
    `).run(draft.id, "b".repeat(64), "2026-08-21T09:00:00.000Z", "2026-08-21T09:00:00.000Z");
  });
  const updated = service.patchDraft(owner, patch(draft.id, 1, "targetAudience", "Новые клиенты"));
  assert.equal(updated.draft.dependencies.blockingPriorOperations[0]?.state, "UNKNOWN");
  const stored = storage.repositories.transaction(({ sql }) => sql.prepare(
    "SELECT state FROM posting_operations WHERE id = 'unknown-op'",
  ).get() as { state: string });
  assert.equal(stored.state, "UNKNOWN");
  storage.close();
});

test("active Draft limit and cancel preserve immutable history and survive restart", () => {
  const stateDir = stateDirectory("restart");
  const first = openPluginDatabase({ stateDir });
  insertUser(first, "owner-user", owner.senderId);
  let sequence = 0;
  const service = new IdeaToJiraDraftService({
    unitOfWork: first.repositories,
    maxActiveDrafts: 1,
    newId: () => `restart-draft-${++sequence}`,
  });
  const created = service.createDraft(owner, intake).draft;
  assert.throws(
    () => service.createDraft(owner, intake),
    (error) => error instanceof SafeError && error.code === "DRAFT_LIMIT_REACHED",
  );
  const cancelled = service.cancelDraft(owner, { draftId: created.id, expectedVersion: 1 }).draft;
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.version, 2);
  const replacement = service.createDraft(owner, intake).draft;
  assert.equal(replacement.version, 1);
  first.close();

  const reopened = openPluginDatabase({ stateDir });
  const recovered = new IdeaToJiraDraftService({ unitOfWork: reopened.repositories });
  assert.equal(recovered.readDraft(owner, created.id).draft.state, "CANCELLED");
  const versions = reopened.repositories.transaction(({ sql }) => sql.prepare(
    "SELECT count(*) AS count FROM draft_versions WHERE draft_id = ?",
  ).get(created.id) as { count: number });
  assert.equal(versions.count, 2);
  reopened.close();
});

test("question policy is bounded and never repeats confirmed fields", () => {
  const content = createDraftContent({ ...intake, targetAudience: "Новые клиенты" });
  const questions = selectDraftQuestions(content, 3);
  assert.equal(questions.length, 3);
  assert.ok(questions.every((question) => question.field !== "targetAudience"));
  assert.throws(() => selectDraftQuestions(content, 4), /DRAFT_INVALID/);
});
