import { initialSchemaMigration } from "./001-initial-schema.js";
import { auditObservabilityBaselineMigration } from "./002-audit-observability-baseline.js";
import type { Migration } from "./types.js";

export const migrations: readonly Migration[] = Object.freeze([
  initialSchemaMigration,
  auditObservabilityBaselineMigration,
]);
export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export { ACCESS_REQUEST_STATES, DRAFT_STATES, POSTING_STATES, ROLE_GRANT_STATES, USER_STATES } from "./001-initial-schema.js";
export { defineMigration, migrationChecksum, type Migration } from "./types.js";
