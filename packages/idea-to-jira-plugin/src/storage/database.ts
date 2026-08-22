import { chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { ensurePrivateStateDirectory } from "../runtime/state.js";
import { checkStorageHealth, type StorageHealth } from "./health.js";
import { LATEST_SCHEMA_VERSION, migrations, type Migration } from "./migrations/index.js";
import { inspectMigrationState, runMigrations } from "./migrations/runner.js";
import {
  assertExistingSqliteFileSet,
  assertPrivateDirectory,
  assertPrivateFile,
  enforceSqliteFileModes,
  prepareNewPrivateFile,
  preparePrivateDatabaseFile,
} from "./permissions.js";
import { createStorageUnitOfWork, type StorageUnitOfWork } from "./repository.js";

export const DATABASE_FILENAME = "idea-to-jira.sqlite3";
export const UPGRADE_BACKUP_FILENAME = "pre-upgrade.sqlite3";
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface OpenPluginDatabaseOptions {
  readonly stateDir: string;
  readonly databaseFilename?: string;
  readonly busyTimeoutMs?: number;
  readonly migrationRegistry?: readonly Migration[];
  /** Existing verified online snapshot required before upgrading a non-empty database. */
  readonly upgradeBackupPath?: string;
  /** Tool execution may open only an existing database at the exact current schema. */
  readonly migrationMode?: "migrate" | "verify-current";
}

interface DefensiveDatabaseSync extends DatabaseSync {
  enableDefensive(active: boolean): void;
}

export interface PluginDatabase {
  readonly path: string;
  readonly health: StorageHealth;
  readonly repositories: StorageUnitOfWork;
  createConsistentBackup(destination: string): Promise<void>;
  close(): void;
}

function pragmaValue(database: DatabaseSync, statement: string): unknown {
  const row = database.prepare(statement).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

function configureConnection(database: DatabaseSync, busyTimeoutMs: number): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA trusted_schema = OFF");
  const journalMode = pragmaValue(database, "PRAGMA journal_mode = WAL");

  if (
    journalMode !== "wal" ||
    pragmaValue(database, "PRAGMA foreign_keys") !== 1 ||
    pragmaValue(database, "PRAGMA busy_timeout") !== busyTimeoutMs ||
    pragmaValue(database, "PRAGMA synchronous") !== 2 ||
    pragmaValue(database, "PRAGMA trusted_schema") !== 0
  ) {
    throw new Error("STORAGE_CONNECTION_POLICY_INVALID");
  }
}

function validateOptions(options: OpenPluginDatabaseOptions): {
  readonly path: string;
  readonly busyTimeoutMs: number;
  readonly registry: readonly Migration[];
  readonly upgradeBackupPath: string | undefined;
  readonly migrationMode: "migrate" | "verify-current";
} {
  const filename = options.databaseFilename ?? DATABASE_FILENAME;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(filename) || filename.includes("..")) {
    throw new Error("STORAGE_PATH_INVALID");
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new Error("STORAGE_BUSY_TIMEOUT_INVALID");
  }
  if (options.upgradeBackupPath !== undefined && !isAbsolute(options.upgradeBackupPath)) {
    throw new Error("STORAGE_UPGRADE_BACKUP_INVALID");
  }
  return {
    path: join(options.stateDir, filename),
    busyTimeoutMs,
    registry: options.migrationRegistry ?? migrations,
    upgradeBackupPath: options.upgradeBackupPath,
    migrationMode: options.migrationMode ?? "migrate",
  };
}

function verifyUpgradeBackup(
  backupPath: string,
  livePath: string,
  expectedVersion: number,
  registry: readonly Migration[],
): void {
  if (resolve(backupPath) === resolve(livePath)) throw new Error("STORAGE_UPGRADE_BACKUP_INVALID");
  assertPrivateFile(backupPath);
  const snapshot = new DatabaseSync(backupPath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    snapshot.exec("PRAGMA foreign_keys = ON");
    const state = inspectMigrationState(snapshot, registry);
    if (state.currentVersion !== expectedVersion) throw new Error("STORAGE_UPGRADE_BACKUP_INVALID");
    checkStorageHealth(snapshot, expectedVersion);
  } catch (error) {
    throw new Error("STORAGE_UPGRADE_BACKUP_INVALID", { cause: error });
  } finally {
    snapshot.close();
  }
}

export function openPluginDatabase(options: OpenPluginDatabaseOptions): PluginDatabase {
  const validated = validateOptions(options);
  if (validated.migrationMode === "migrate") {
    ensurePrivateStateDirectory(options.stateDir);
    assertPrivateDirectory(options.stateDir);
    assertExistingSqliteFileSet(validated.path);
    preparePrivateDatabaseFile(validated.path);
  } else {
    assertPrivateDirectory(options.stateDir);
    assertExistingSqliteFileSet(validated.path);
    assertPrivateFile(validated.path);
  }

  const database = new DatabaseSync(validated.path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: validated.busyTimeoutMs,
  });

  try {
    configureConnection(database, validated.busyTimeoutMs);
    const migrationState = inspectMigrationState(database, validated.registry);
    let schemaVersion: number;
    if (validated.migrationMode === "verify-current") {
      if (migrationState.fresh || migrationState.pending !== 0 || migrationState.currentVersion !== migrationState.targetVersion) {
        throw new Error("STORAGE_SCHEMA_NOT_CURRENT");
      }
      schemaVersion = migrationState.currentVersion;
    } else {
      if (!migrationState.fresh && migrationState.pending > 0) {
        if (!validated.upgradeBackupPath) throw new Error("STORAGE_UPGRADE_BACKUP_REQUIRED");
        verifyUpgradeBackup(
          validated.upgradeBackupPath,
          validated.path,
          migrationState.currentVersion,
          validated.registry,
        );
      }
      schemaVersion = runMigrations(database, validated.registry);
    }
    // Node 24.19 exposes this API; the pinned 24.3 type package predates its declaration.
    (database as DefensiveDatabaseSync).enableDefensive(true);
    enforceSqliteFileModes(validated.path);
    const health = checkStorageHealth(database, schemaVersion);
    const repositories = createStorageUnitOfWork(database);
    let closed = false;

    return Object.freeze({
      path: validated.path,
      health,
      repositories,
      async createConsistentBackup(destination: string): Promise<void> {
        if (closed) throw new Error("STORAGE_CLOSED");
        const backupDirectory = dirname(destination);
        ensurePrivateStateDirectory(backupDirectory);
        assertPrivateDirectory(backupDirectory);
        prepareNewPrivateFile(destination);
        await backup(database, destination);
        chmodSync(destination, 0o600);
        assertPrivateFile(destination);
        verifyUpgradeBackup(destination, validated.path, schemaVersion, validated.registry);
      },
      close(): void {
        if (closed) return;
        enforceSqliteFileModes(validated.path);
        database.close();
        closed = true;
      },
    });
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the original fail-closed startup error.
    }
    throw error;
  }
}

export function latestStorageSchemaVersion(): number {
  return LATEST_SCHEMA_VERSION;
}
