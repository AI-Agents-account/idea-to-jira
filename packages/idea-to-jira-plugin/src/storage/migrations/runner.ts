import type { DatabaseSync } from "node:sqlite";

import { migrations as defaultMigrations, type Migration } from "./index.js";

const METADATA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version >= 1),
  name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 128),
  checksum TEXT NOT NULL CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
`;

export type MigrationErrorCode =
  | "MIGRATION_REGISTRY_INVALID"
  | "MIGRATION_FUTURE_SCHEMA"
  | "MIGRATION_HISTORY_MISMATCH"
  | "MIGRATION_PARTIAL_STATE"
  | "MIGRATION_APPLY_FAILED";

export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "MigrationError";
  }
}

export interface MigrationState {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pending: number;
  readonly fresh: boolean;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original migration failure. SQLite may already have rolled back.
  }
}

function validateRegistry(registry: readonly Migration[]): void {
  for (const [index, migration] of registry.entries()) {
    if (migration.version !== index + 1 || !/^[a-f0-9]{64}$/.test(migration.checksum)) {
      throw new MigrationError("MIGRATION_REGISTRY_INVALID");
    }
  }
}

function appliedMigrations(database: DatabaseSync): AppliedMigrationRow[] {
  return database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all() as unknown as AppliedMigrationRow[];
}

function pragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MigrationError("MIGRATION_HISTORY_MISMATCH");
  }
  return value;
}

function hasMigrationMetadata(database: DatabaseSync): boolean {
  const row = database.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { readonly count: number };
  return row.count === 1;
}

function applicationTables(database: DatabaseSync): readonly string[] {
  const rows = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
  ).all() as unknown as Array<{ readonly name: string }>;
  return rows.map((row) => row.name);
}

function verifyHistory(
  database: DatabaseSync,
  registry: readonly Migration[],
  applied: readonly AppliedMigrationRow[],
): void {
  const latestSupported = registry.at(-1)?.version ?? 0;
  const latestApplied = applied.at(-1)?.version ?? 0;
  if (latestApplied > latestSupported) throw new MigrationError("MIGRATION_FUTURE_SCHEMA");

  for (const [index, row] of applied.entries()) {
    if (row.version !== index + 1) throw new MigrationError("MIGRATION_PARTIAL_STATE");
    const expected = registry[index];
    if (!expected || row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new MigrationError("MIGRATION_HISTORY_MISMATCH");
    }
  }

  const userVersion = pragmaInteger(database, "user_version");
  if (userVersion > latestSupported) throw new MigrationError("MIGRATION_FUTURE_SCHEMA");
  if (userVersion !== latestApplied) throw new MigrationError("MIGRATION_PARTIAL_STATE");
  if (latestApplied === 0 && applicationTables(database).length > 0) {
    throw new MigrationError("MIGRATION_PARTIAL_STATE");
  }
}

function applyMigration(database: DatabaseSync, migration: Migration): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migration.sql);
    database.prepare(
      "INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)",
    ).run(migration.version, migration.name, migration.checksum);
    database.exec(`PRAGMA user_version = ${migration.version}`);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw new MigrationError("MIGRATION_APPLY_FAILED", { cause: error });
  }
}

export function inspectMigrationState(
  database: DatabaseSync,
  registry: readonly Migration[] = defaultMigrations,
): MigrationState {
  validateRegistry(registry);
  const targetVersion = registry.at(-1)?.version ?? 0;
  if (!hasMigrationMetadata(database)) {
    const userVersion = pragmaInteger(database, "user_version");
    if (userVersion > targetVersion) throw new MigrationError("MIGRATION_FUTURE_SCHEMA");
    if (userVersion !== 0 || applicationTables(database).length > 0) {
      throw new MigrationError("MIGRATION_PARTIAL_STATE");
    }
    return Object.freeze({ currentVersion: 0, targetVersion, pending: targetVersion, fresh: true });
  }

  const applied = appliedMigrations(database);
  verifyHistory(database, registry, applied);
  const currentVersion = applied.at(-1)?.version ?? 0;
  return Object.freeze({
    currentVersion,
    targetVersion,
    pending: targetVersion - currentVersion,
    fresh: currentVersion === 0 && applicationTables(database).length === 0,
  });
}

export function runMigrations(
  database: DatabaseSync,
  registry: readonly Migration[] = defaultMigrations,
): number {
  inspectMigrationState(database, registry);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(METADATA_SQL);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw new MigrationError("MIGRATION_APPLY_FAILED", { cause: error });
  }

  let applied = appliedMigrations(database);
  verifyHistory(database, registry, applied);

  for (const migration of registry.slice(applied.length)) {
    applyMigration(database, migration);
    applied = appliedMigrations(database);
    verifyHistory(database, registry, applied);
  }

  return applied.at(-1)?.version ?? 0;
}
