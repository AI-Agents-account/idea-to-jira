import { defineMigration } from "./types.js";

const sql = String.raw`
ALTER TABLE audit_log ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1 CHECK(event_version = 1);
ALTER TABLE audit_log ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'LEGACY'
  CHECK(actor_kind IN ('USER', 'SYSTEM', 'LEGACY'));
ALTER TABLE audit_log ADD COLUMN actor_ref_hash TEXT
  CHECK(actor_ref_hash IS NULL OR (length(actor_ref_hash) = 64 AND actor_ref_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE audit_log ADD COLUMN correlation_id TEXT
  CHECK(correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128);
ALTER TABLE audit_log ADD COLUMN request_id TEXT
  CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND 128);
ALTER TABLE audit_log ADD COLUMN draft_id TEXT
  CHECK(draft_id IS NULL OR length(draft_id) BETWEEN 1 AND 128);
ALTER TABLE audit_log ADD COLUMN draft_version INTEGER CHECK(draft_version IS NULL OR draft_version >= 1);
ALTER TABLE audit_log ADD COLUMN operation_id TEXT
  CHECK(operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 128);
ALTER TABLE audit_log ADD COLUMN notification_id TEXT
  CHECK(notification_id IS NULL OR length(notification_id) BETWEEN 1 AND 128);
ALTER TABLE audit_log ADD COLUMN correction_of_event_id TEXT REFERENCES audit_log(event_id) ON DELETE RESTRICT;
ALTER TABLE audit_log ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'AUDIT_1Y'
  CHECK(retention_class IN ('DRAFT_90D', 'AUDIT_1Y', 'OPERATOR_POLICY'));
ALTER TABLE audit_log ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1
  CHECK(retention_policy_version = 1);

ALTER TABLE users ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'AUDIT_1Y' CHECK(retention_class = 'AUDIT_1Y');
ALTER TABLE access_requests ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'AUDIT_1Y' CHECK(retention_class = 'AUDIT_1Y');
ALTER TABLE role_grants ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'AUDIT_1Y' CHECK(retention_class = 'AUDIT_1Y');
ALTER TABLE drafts ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'DRAFT_90D' CHECK(retention_class = 'DRAFT_90D');
ALTER TABLE draft_versions ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'DRAFT_90D' CHECK(retention_class = 'DRAFT_90D');
ALTER TABLE duplicate_checks ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'DRAFT_90D' CHECK(retention_class = 'DRAFT_90D');
ALTER TABLE posting_operations ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'AUDIT_1Y' CHECK(retention_class = 'AUDIT_1Y');
ALTER TABLE notifications ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'AUDIT_1Y' CHECK(retention_class = 'AUDIT_1Y');
`;

export const auditObservabilityBaselineMigration = defineMigration(2, "audit_observability_baseline", sql);
