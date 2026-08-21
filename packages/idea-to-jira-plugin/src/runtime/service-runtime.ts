import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { AccessService } from "../access/access-service.js";
import { SqliteAuditWriter } from "../audit/index.js";
import type { EffectiveConfig } from "../config.js";
import type { SafeErrorCode } from "../errors/index.js";
import { JiraHttpClient } from "../jira/http-client.js";
import { JiraMetadataClient } from "../jira/metadata-client.js";
import { JiraWorkflowPersistence } from "../jira/persistence.js";
import { JiraPostingService } from "../jira/posting-service.js";
import { JiraSearchClient } from "../jira/search-client.js";
import { JiraWorkflowService } from "../jira/workflow-service.js";
import { TokenBucketRateLimiter } from "./policy.js";
import {
  openPluginDatabase,
  UPGRADE_BACKUP_FILENAME,
  type PluginDatabase,
} from "../storage/database.js";
import { IdeaToJiraDraftService } from "../workflow/draft-service.js";

export const SERVICE_RUNTIME_SCHEMA_VERSION = 1 as const;

export type ServiceRuntimePhase = "NOT_STARTED" | "STARTING" | "READY" | "FAILED" | "STOPPED";

export interface RuntimeServices {
  readonly config: EffectiveConfig;
  readonly storage: PluginDatabase;
  readonly auditWriter: SqliteAuditWriter;
  readonly accessService: AccessService;
  readonly draftService: IdeaToJiraDraftService;
  readonly limiter: TokenBucketRateLimiter;
  readonly jiraWorkflow?: JiraWorkflowService;
}

export interface RuntimeServiceFactories {
  readonly openDatabase: typeof openPluginDatabase;
  readonly createAuditWriter: () => SqliteAuditWriter;
  readonly createAccessService: (storage: PluginDatabase, config: EffectiveConfig) => AccessService;
  readonly createDraftService: (storage: PluginDatabase, config: EffectiveConfig) => IdeaToJiraDraftService;
  readonly createJiraWorkflow?: (storage: PluginDatabase, config: EffectiveConfig) => JiraWorkflowService | undefined;
}

interface RuntimeRecord {
  readonly generation: number;
  readonly instanceId: string;
  phase: ServiceRuntimePhase;
  failureCode: SafeErrorCode;
  services?: RuntimeServices;
}

interface RuntimeSlot {
  nextGeneration: number;
  current?: RuntimeRecord;
}

type RuntimeGlobal = typeof globalThis & {
  __ideaToJiraServiceRuntimeV1?: RuntimeSlot;
};

export interface ServiceRuntimeStatus {
  readonly schemaVersion: typeof SERVICE_RUNTIME_SCHEMA_VERSION;
  /** Generation of the current lifecycle record, or the latest registration when none has started. */
  readonly generation: number;
  /** Latest registered generation; it may be newer than the running service during agent-runtime pre-warm. */
  readonly latestGeneration: number;
  readonly instanceId: string | null;
  readonly phase: ServiceRuntimePhase;
  readonly failureCode: SafeErrorCode;
}

const defaultFactories: RuntimeServiceFactories = Object.freeze({
  openDatabase: openPluginDatabase,
  createAuditWriter: () => new SqliteAuditWriter(),
  createAccessService: (storage: PluginDatabase, config: EffectiveConfig) => new AccessService({
    unitOfWork: storage.repositories,
    config,
  }),
  createDraftService: (storage: PluginDatabase, config: EffectiveConfig) => new IdeaToJiraDraftService({
    unitOfWork: storage.repositories,
    maxActiveDrafts: config.limits.activeDrafts,
  }),
  createJiraWorkflow: (storage: PluginDatabase, config: EffectiveConfig) => {
    let token = process.env.JIRA_TOKEN?.trim();
    if (!token && process.env.JIRA_TOKEN_FILE?.trim()) {
      try {
        const tokenPath = process.env.JIRA_TOKEN_FILE.trim();
        const tokenStat = statSync(tokenPath);
        token = tokenStat.isFile() && (tokenStat.mode & 0o077) === 0 ? readFileSync(tokenPath, "utf8").trim() : undefined;
      } catch { token = undefined; }
    }
    if (!token || token.length > 8_192 || /[\u0000-\u0020\u007f]/.test(token)) token = undefined;
    if (!config.jira.enabled || !config.jira.credentialAvailable || !token) return undefined;
    const http = new JiraHttpClient({
      origin: config.jira.url,
      token,
      timeoutMs: config.jira.search.timeoutMs,
      maxResponseBytes: Math.max(2_097_152, config.jira.search.maxContextBytes * 4),
    });
    const metadata = new JiraMetadataClient({ config: config.jira, http });
    const search = new JiraSearchClient(config.jira, http);
    const posting = new JiraPostingService(storage.repositories, config.jira, http);
    const persistence = new JiraWorkflowPersistence(storage.repositories);
    return new JiraWorkflowService(config.jira, metadata, search, posting, persistence);
  },
});

function slot(): RuntimeSlot {
  const target = globalThis as RuntimeGlobal;
  target.__ideaToJiraServiceRuntimeV1 ??= { nextGeneration: 0 };
  return target.__ideaToJiraServiceRuntimeV1;
}

/** Builds all stateful services locally and closes partially opened storage on failure. */
export function createServiceRuntimeCandidate(
  config: EffectiveConfig,
  factories: RuntimeServiceFactories = defaultFactories,
): RuntimeServices {
  let storage: PluginDatabase | undefined;
  try {
    storage = factories.openDatabase({
      stateDir: config.stateDir,
      upgradeBackupPath: join(config.stateDir, UPGRADE_BACKUP_FILENAME),
    });
    const auditWriter = factories.createAuditWriter();
    const accessService = factories.createAccessService(storage, config);
    const draftService = factories.createDraftService(storage, config);
    const limiter = new TokenBucketRateLimiter(config.limits);
    const jiraWorkflow = factories.createJiraWorkflow?.(storage, config);
    jiraWorkflow?.recoverAfterRestart();
    return Object.freeze({ config, storage, auditWriter, accessService, draftService, limiter, ...(jiraWorkflow ? { jiraWorkflow } : {}) });
  } catch (error) {
    try {
      storage?.close();
    } catch {
      // Preserve the bounded primary startup failure.
    }
    throw error;
  }
}

/** Allocates a process-local, non-sensitive lifecycle generation. */
export function createServiceRuntimeGeneration(): number {
  const target = slot();
  target.nextGeneration += 1;
  return target.nextGeneration;
}

/**
 * Claims an allocated generation before constructing stateful services.
 * OpenClaw may register a newer agent-runtime copy before the Gateway starts
 * the older service copy, so an unstarted registration must not win ownership.
 * A generation that actually started still prevents every older generation
 * from replacing it.
 */
export function beginServiceRuntime(generation: number): boolean {
  const target = slot();
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > target.nextGeneration) {
    return false;
  }
  if (target.current && target.current.generation >= generation) return false;
  target.current = {
    generation,
    instanceId: randomUUID(),
    phase: "STARTING",
    failureCode: "STORAGE_NOT_READY",
  };
  return true;
}

/** Atomically publishes a complete service set. Partial service sets are impossible. */
export function publishServiceRuntime(
  generation: number,
  services: RuntimeServices,
): boolean {
  const current = slot().current;
  if (!current || current.generation !== generation || current.phase !== "STARTING") return false;
  current.services = services;
  current.phase = "READY";
  current.failureCode = "STORAGE_NOT_READY";
  return true;
}

/** Records only a bounded failure code and never displaces a newer generation. */
export function failServiceRuntime(generation: number, code: SafeErrorCode): void {
  const current = slot().current;
  if (!current || current.generation !== generation) return;
  delete current.services;
  current.phase = "FAILED";
  current.failureCode = code;
}

/** Clears the active services only when the stopping service still owns the slot. */
export function stopServiceRuntime(generation: number): boolean {
  const current = slot().current;
  if (!current || current.generation !== generation) return false;
  delete current.services;
  current.phase = "STOPPED";
  current.failureCode = "STORAGE_NOT_READY";
  return true;
}

/**
 * Resolves the service that actually reached READY. Registration alone is not
 * a lifecycle transition: OpenClaw may register an agent-runtime copy without
 * starting its services during pre-warm. A newer generation hides the active
 * service only when beginServiceRuntime() starts that generation.
 */
export function getServiceRuntime(): RuntimeServices | undefined {
  const current = slot().current;
  return current?.phase === "READY" ? current.services : undefined;
}

export function getServiceRuntimeStatus(): ServiceRuntimeStatus {
  const target = slot();
  const current = target.current;
  if (!current) {
    return Object.freeze({
      schemaVersion: SERVICE_RUNTIME_SCHEMA_VERSION,
      generation: target.nextGeneration,
      latestGeneration: target.nextGeneration,
      instanceId: null,
      phase: "NOT_STARTED",
      failureCode: "STORAGE_NOT_READY",
    });
  }
  return Object.freeze({
    schemaVersion: SERVICE_RUNTIME_SCHEMA_VERSION,
    generation: current.generation,
    latestGeneration: target.nextGeneration,
    instanceId: current.instanceId,
    phase: current.phase,
    failureCode: current.failureCode,
  });
}

/** Test-only reset; production lifecycle code must use owner-safe stop. */
export function resetServiceRuntimeForTest(): void {
  const target = slot();
  target.nextGeneration = 0;
  delete target.current;
}
