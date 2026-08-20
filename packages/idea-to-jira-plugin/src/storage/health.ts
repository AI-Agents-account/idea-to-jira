import type { DatabaseSync } from "node:sqlite";

export const IDEA_TO_JIRA_APPLICATION_ID = 1_230_260_785;

export interface StorageHealth {
  readonly healthy: true;
  readonly schemaVersion: number;
  readonly quickCheck: "ok";
  readonly foreignKeyViolations: 0;
}

function pragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("STORAGE_CONSISTENCY_FAILED");
  return value;
}

export function checkStorageHealth(database: DatabaseSync, expectedSchemaVersion: number): StorageHealth {
  if (pragmaInteger(database, "application_id") !== IDEA_TO_JIRA_APPLICATION_ID) {
    throw new Error("STORAGE_APPLICATION_ID_INVALID");
  }
  const schemaVersion = pragmaInteger(database, "user_version");
  if (schemaVersion !== expectedSchemaVersion) throw new Error("STORAGE_SCHEMA_VERSION_INVALID");

  const quickRows = database.prepare("PRAGMA quick_check").all() as unknown as Array<Record<string, unknown>>;
  if (quickRows.length !== 1 || Object.values(quickRows[0] ?? {})[0] !== "ok") {
    throw new Error("STORAGE_CONSISTENCY_FAILED");
  }

  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length !== 0) throw new Error("STORAGE_FOREIGN_KEY_CHECK_FAILED");

  return Object.freeze({
    healthy: true,
    schemaVersion,
    quickCheck: "ok",
    foreignKeyViolations: 0,
  });
}
