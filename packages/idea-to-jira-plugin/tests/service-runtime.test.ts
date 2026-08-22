import assert from "node:assert/strict";
import test from "node:test";

import type { AccessService } from "../src/access/access-service.js";
import type { SqliteAuditWriter } from "../src/audit/index.js";
import {
  beginServiceRuntime,
  createDraftToolExecutionRuntimeBoundary,
  createServiceRuntimeCandidate,
  createServiceRuntimeGeneration,
  failServiceRuntime,
  getServiceRuntime,
  getServiceRuntimeStatus,
  publishServiceRuntime,
  resetServiceRuntimeForTest,
  stopServiceRuntime,
  type RuntimeServices,
} from "../src/runtime/service-runtime.js";
import type { PluginDatabase } from "../src/storage/database.js";
import type { IdeaToJiraDraftService } from "../src/workflow/draft-service.js";
import { effectiveConfig } from "./config-fixture.js";

test("runtime is fail-closed before start, on failure, and after owner stop", () => {
  resetServiceRuntimeForTest();
  assert.equal(getServiceRuntime(), undefined);
  assert.deepEqual(getServiceRuntimeStatus(), {
    schemaVersion: 1,
    generation: 0,
    latestGeneration: 0,
    instanceId: null,
    phase: "NOT_STARTED",
    failureCode: "STORAGE_NOT_READY",
  });

  const generation = createServiceRuntimeGeneration();
  assert.equal(beginServiceRuntime(generation), true);
  assert.match(getServiceRuntimeStatus().instanceId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(getServiceRuntime(), undefined);
  failServiceRuntime(generation, "STORAGE_STARTUP_FAILED");
  assert.equal(getServiceRuntime(), undefined);
  assert.equal(getServiceRuntimeStatus().phase, "FAILED");
  assert.equal(getServiceRuntimeStatus().failureCode, "STORAGE_STARTUP_FAILED");
  assert.equal(stopServiceRuntime(generation), true);
  assert.equal(getServiceRuntime(), undefined);
  assert.equal(getServiceRuntimeStatus().phase, "STOPPED");
});

test("registration alone preserves the active runtime while a started generation replaces it atomically", () => {
  resetServiceRuntimeForTest();
  const firstGeneration = createServiceRuntimeGeneration();
  const secondGeneration = createServiceRuntimeGeneration();
  const first = { marker: "first" } as unknown as RuntimeServices;
  const second = { marker: "second" } as unknown as RuntimeServices;

  assert.equal(getServiceRuntimeStatus().phase, "NOT_STARTED");
  assert.equal(getServiceRuntimeStatus().latestGeneration, secondGeneration);
  assert.equal(beginServiceRuntime(firstGeneration), true);
  assert.equal(publishServiceRuntime(firstGeneration, first), true);
  assert.equal(getServiceRuntime(), first);

  assert.equal(getServiceRuntime(), first);
  assert.equal(getServiceRuntimeStatus().generation, firstGeneration);
  assert.equal(getServiceRuntimeStatus().latestGeneration, secondGeneration);
  assert.equal(getServiceRuntimeStatus().phase, "READY");
  assert.equal(beginServiceRuntime(firstGeneration), false);
  assert.equal(beginServiceRuntime(secondGeneration), true);
  assert.equal(getServiceRuntime(), undefined);
  assert.equal(stopServiceRuntime(firstGeneration), false);
  assert.equal(getServiceRuntimeStatus().generation, secondGeneration);
  assert.equal(publishServiceRuntime(secondGeneration, second), true);
  assert.equal(getServiceRuntime(), second);

  assert.equal(stopServiceRuntime(firstGeneration), false);
  assert.equal(getServiceRuntime(), second);
  assert.equal(stopServiceRuntime(secondGeneration), true);
  assert.equal(getServiceRuntime(), undefined);
});

test("candidate construction closes opened storage and never publishes partial services", () => {
  resetServiceRuntimeForTest();
  let closeCount = 0;
  const storage = {
    repositories: {},
    close() { closeCount += 1; },
  } as unknown as PluginDatabase;
  const privateFailure = new Error("private startup detail");

  assert.throws(() => createServiceRuntimeCandidate(effectiveConfig(), {
    openDatabase: () => storage,
    createAuditWriter: () => ({}) as SqliteAuditWriter,
    createAccessService: () => { throw privateFailure; },
    createDraftService: () => ({}) as IdeaToJiraDraftService,
  }), (error) => error === privateFailure);
  assert.equal(closeCount, 1);
  assert.equal(getServiceRuntime(), undefined);

  const candidate = createServiceRuntimeCandidate(effectiveConfig(), {
    openDatabase: () => storage,
    createAuditWriter: () => ({}) as SqliteAuditWriter,
    createAccessService: () => ({}) as AccessService,
    createDraftService: () => ({}) as IdeaToJiraDraftService,
  });
  assert.equal(candidate.storage, storage);
  assert.ok(candidate.accessService);
  assert.ok(candidate.draftService);
  assert.equal(closeCount, 1);
});

test("Draft tool-discovery boundary excludes Jira, shares rate state, and closes the final lease", () => {
  resetServiceRuntimeForTest();
  let openCount = 0;
  let closeCount = 0;
  let jiraFactoryCalls = 0;
  const factories = {
    openDatabase: () => {
      openCount += 1;
      return {
        repositories: {},
        close() { closeCount += 1; },
      } as unknown as PluginDatabase;
    },
    createAuditWriter: () => ({}) as SqliteAuditWriter,
    createAccessService: () => ({}) as AccessService,
    createDraftService: () => ({}) as IdeaToJiraDraftService,
    createJiraWorkflow: () => {
      jiraFactoryCalls += 1;
      return undefined;
    },
  };
  const boundary = createDraftToolExecutionRuntimeBoundary(effectiveConfig(), factories);

  const first = boundary.acquire();
  const overlapping = boundary.acquire();
  assert.equal(first.runtime, overlapping.runtime);
  assert.equal(openCount, 1);
  assert.equal(first.runtime.jiraWorkflow, undefined);
  assert.equal(jiraFactoryCalls, 0);

  first.release();
  assert.equal(closeCount, 0);
  overlapping.release();
  overlapping.release();
  assert.equal(closeCount, 1);

  const sequential = boundary.acquire();
  assert.notEqual(sequential.runtime, first.runtime);
  assert.equal(sequential.runtime.limiter, first.runtime.limiter);
  sequential.release();
  assert.equal(closeCount, 2);

  const generation = createServiceRuntimeGeneration();
  const gatewayRuntime = { marker: "gateway" } as unknown as RuntimeServices;
  assert.equal(beginServiceRuntime(generation), true);
  assert.equal(publishServiceRuntime(generation, gatewayRuntime), true);
  const borrowed = boundary.acquire();
  assert.equal(borrowed.runtime, gatewayRuntime);
  borrowed.release();
  assert.equal(closeCount, 2, "a borrowed Gateway runtime must never be closed by discovery");
  assert.equal(openCount, 2);
  assert.equal(stopServiceRuntime(generation), true);
});
