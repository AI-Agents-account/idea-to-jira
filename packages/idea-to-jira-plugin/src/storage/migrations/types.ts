import { createHash } from "node:crypto";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function migrationChecksum(version: number, name: string, sql: string): string {
  return createHash("sha256").update(`${version}\n${name}\n${sql}`).digest("hex");
}

export function defineMigration(version: number, name: string, sql: string): Migration {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("MIGRATION_VERSION_INVALID");
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("MIGRATION_NAME_INVALID");
  return Object.freeze({ version, name, sql, checksum: migrationChecksum(version, name, sql) });
}
