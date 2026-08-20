import type { DatabaseSync } from "node:sqlite";

import { runInTransaction, type SqlExecutor } from "./transaction.js";

export interface RepositoryContext {
  readonly sql: SqlExecutor;
}

export interface StorageUnitOfWork {
  transaction<T>(work: (context: RepositoryContext) => T): T;
  criticalTransaction<T>(work: (context: RepositoryContext) => T): T;
}

function synchronousLevel(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA synchronous").get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number") throw new Error("STORAGE_DURABILITY_INVALID");
  return value;
}

export function createStorageUnitOfWork(database: DatabaseSync): StorageUnitOfWork {
  const execute = <T>(work: (context: RepositoryContext) => T): T =>
    runInTransaction(database, (sql) => work(Object.freeze({ sql })), "immediate");

  return Object.freeze({
    transaction: execute,
    criticalTransaction<T>(work: (context: RepositoryContext) => T): T {
      // SQLITE synchronous=2 is FULL. Critical role/posting callers fail closed if policy drifts.
      if (synchronousLevel(database) !== 2) throw new Error("STORAGE_DURABILITY_INVALID");
      return execute(work);
    },
  });
}
