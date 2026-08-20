import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Transaction-scoped access for static application DML; PRAGMA, DDL and transaction control are denied. */
export interface SqlExecutor {
  prepare(sql: string): StatementSync;
}

const APPLICATION_DML = /^(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

function restrictedExecutor(database: DatabaseSync): SqlExecutor {
  return Object.freeze({
    prepare(sql: string): StatementSync {
      if (!APPLICATION_DML.test(sql.trimStart())) throw new Error("REPOSITORY_SQL_DENIED");
      return database.prepare(sql);
    },
  });
}

export type TransactionMode = "deferred" | "immediate";

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original failure when SQLite already rolled back the transaction.
  }
}

export function runInTransaction<T>(
  database: DatabaseSync,
  work: (sql: SqlExecutor) => T,
  mode: TransactionMode = "immediate",
): T {
  database.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = work(restrictedExecutor(database));
    if (result instanceof Promise) throw new Error("TRANSACTION_CALLBACK_MUST_BE_SYNCHRONOUS");
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollback(database);
    throw error;
  }
}
