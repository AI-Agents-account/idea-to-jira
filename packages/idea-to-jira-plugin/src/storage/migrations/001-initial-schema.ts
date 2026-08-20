import { defineMigration } from "./types.js";

export const USER_STATES = Object.freeze(["GUEST", "PENDING", "CREATOR", "SUSPENDED", "BLOCKED"] as const);
export const ACCESS_REQUEST_STATES = Object.freeze(["PENDING", "APPROVED", "DENIED", "BLOCKED", "CANCELLED"] as const);
export const ROLE_GRANT_STATES = Object.freeze(["ACTIVE", "SUSPENDED", "REVOKED"] as const);
export const DRAFT_STATES = Object.freeze([
  "EDITING",
  "READY",
  "POSTING",
  "CREATED",
  "DUPLICATE_LINKED",
  "CANCELLED",
  "FAILED_FINAL",
  "UNKNOWN",
] as const);
export const POSTING_STATES = Object.freeze([
  "PENDING",
  "POSTING",
  "CREATED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "UNKNOWN",
  "MANUAL_RESOLUTION_REQUIRED",
] as const);

const sql = String.raw`
PRAGMA application_id = 1230260785;

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  telegram_sender_id TEXT NOT NULL UNIQUE
    CHECK(length(telegram_sender_id) BETWEEN 1 AND 20)
    CHECK(substr(telegram_sender_id, 1, 1) BETWEEN '1' AND '9')
    CHECK(telegram_sender_id NOT GLOB '*[^0-9]*'),
  state TEXT NOT NULL DEFAULT 'GUEST'
    CHECK(state IN ('GUEST', 'PENDING', 'CREATOR', 'SUSPENDED', 'BLOCKED')),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(state IN ('PENDING', 'APPROVED', 'DENIED', 'BLOCKED', 'CANCELLED')),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version >= 1),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  decision_code TEXT CHECK(decision_code IS NULL OR length(decision_code) BETWEEN 1 AND 64),
  CHECK(
    (state = 'PENDING' AND decided_at IS NULL AND decided_by_user_id IS NULL AND decision_code IS NULL)
    OR
    (state <> 'PENDING' AND decided_at IS NOT NULL AND decision_code IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX one_active_access_request_per_user
  ON access_requests(user_id) WHERE state = 'PENDING';

CREATE TABLE role_grants (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role = 'CREATOR'),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  decision_code TEXT NOT NULL CHECK(length(decision_code) BETWEEN 1 AND 64),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version >= 1),
  CHECK((state = 'ACTIVE' AND ended_at IS NULL) OR (state <> 'ACTIVE' AND ended_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_role_grant_per_user_role
  ON role_grants(user_id, role) WHERE state = 'ACTIVE';

CREATE TABLE drafts (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'EDITING'
    CHECK(state IN ('EDITING', 'READY', 'POSTING', 'CREATED', 'DUPLICATE_LINKED', 'CANCELLED', 'FAILED_FINAL', 'UNKNOWN')),
  head_version INTEGER NOT NULL DEFAULT 1 CHECK(head_version >= 1),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(id, head_version),
  FOREIGN KEY(id, head_version) REFERENCES draft_versions(draft_id, version)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE draft_versions (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version >= 1),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 255),
  problem TEXT NOT NULL CHECK(length(problem) BETWEEN 1 AND 10000),
  desired_outcome TEXT NOT NULL CHECK(length(desired_outcome) BETWEEN 1 AND 10000),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  labels_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(labels_json) AND json_type(labels_json) = 'array'),
  provenance_hash TEXT NOT NULL
    CHECK(length(provenance_hash) = 64 AND provenance_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(draft_id, version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER draft_versions_are_immutable_update
BEFORE UPDATE ON draft_versions
BEGIN
  SELECT RAISE(ABORT, 'DRAFT_VERSION_IMMUTABLE');
END;
CREATE TRIGGER draft_versions_are_immutable_delete
BEFORE DELETE ON draft_versions
BEGIN
  SELECT RAISE(ABORT, 'DRAFT_VERSION_IMMUTABLE');
END;

CREATE TABLE catalog_versions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  version INTEGER NOT NULL UNIQUE CHECK(version >= 1),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  checksum TEXT NOT NULL UNIQUE
    CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'STAGED' CHECK(state IN ('STAGED', 'ACTIVE', 'RETIRED', 'REJECTED')),
  published_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX one_active_catalog_version
  ON catalog_versions(state) WHERE state = 'ACTIVE';

CREATE TABLE catalog_routes (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  catalog_version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE RESTRICT,
  route_key TEXT NOT NULL CHECK(length(route_key) BETWEEN 1 AND 128),
  product_owner_sender_id TEXT NOT NULL
    CHECK(length(product_owner_sender_id) BETWEEN 1 AND 20)
    CHECK(substr(product_owner_sender_id, 1, 1) BETWEEN '1' AND '9')
    CHECK(product_owner_sender_id NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(catalog_version_id, route_key)
) STRICT;

CREATE TABLE catalog_route_options (
  catalog_route_id TEXT NOT NULL REFERENCES catalog_routes(id) ON DELETE CASCADE,
  jira_field_id TEXT NOT NULL CHECK(length(jira_field_id) BETWEEN 1 AND 128),
  jira_option_id TEXT NOT NULL CHECK(length(jira_option_id) BETWEEN 1 AND 128),
  PRIMARY KEY(catalog_route_id, jira_field_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE duplicate_checks (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version >= 1),
  catalog_version_id TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL
    CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(state IN ('PENDING', 'NO_CANDIDATES', 'CANDIDATES', 'DECIDED', 'FAILED', 'EXPIRED')),
  decision TEXT CHECK(decision IS NULL OR decision IN ('DUPLICATE_SELECTED', 'NOT_DUPLICATE', 'NO_CANDIDATES')),
  candidates_digest TEXT
    CHECK(candidates_digest IS NULL OR (length(candidates_digest) = 64 AND candidates_digest NOT GLOB '*[^0-9a-f]*')),
  selected_jira_key TEXT CHECK(selected_jira_key IS NULL OR length(selected_jira_key) BETWEEN 3 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  FOREIGN KEY(draft_id, draft_version) REFERENCES draft_versions(draft_id, version) ON DELETE RESTRICT,
  UNIQUE(draft_id, draft_version, fingerprint),
  CHECK((decision = 'DUPLICATE_SELECTED' AND selected_jira_key IS NOT NULL) OR decision <> 'DUPLICATE_SELECTED' OR decision IS NULL)
) STRICT;

CREATE TABLE posting_operations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version >= 1),
  payload_hash TEXT NOT NULL
    CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(state IN ('PENDING', 'POSTING', 'CREATED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'UNKNOWN', 'MANUAL_RESOLUTION_REQUIRED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  network_started_at TEXT,
  last_attempt_at TEXT,
  jira_issue_id TEXT CHECK(jira_issue_id IS NULL OR length(jira_issue_id) BETWEEN 1 AND 64),
  jira_issue_key TEXT CHECK(jira_issue_key IS NULL OR length(jira_issue_key) BETWEEN 3 AND 64),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(draft_id, draft_version) REFERENCES draft_versions(draft_id, version) ON DELETE RESTRICT,
  UNIQUE(draft_id, draft_version, payload_hash),
  CHECK(
    (state = 'PENDING' AND attempt_count = 0 AND network_started_at IS NULL AND last_attempt_at IS NULL)
    OR
    (state = 'FAILED_FINAL' AND (
      (attempt_count = 0 AND network_started_at IS NULL AND last_attempt_at IS NULL)
      OR
      (attempt_count >= 1 AND network_started_at IS NOT NULL AND last_attempt_at IS NOT NULL)
    ))
    OR
    (state IN ('POSTING', 'CREATED', 'FAILED_RETRYABLE', 'UNKNOWN', 'MANUAL_RESOLUTION_REQUIRED')
      AND attempt_count >= 1 AND network_started_at IS NOT NULL AND last_attempt_at IS NOT NULL)
  ),
  CHECK(
    (state = 'CREATED' AND jira_issue_id IS NOT NULL AND jira_issue_key IS NOT NULL)
    OR
    (state <> 'CREATED' AND jira_issue_id IS NULL AND jira_issue_key IS NULL)
  )
) STRICT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  posting_operation_id TEXT NOT NULL REFERENCES posting_operations(id) ON DELETE RESTRICT,
  notification_type TEXT NOT NULL CHECK(length(notification_type) BETWEEN 1 AND 64),
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('CREATOR', 'PRODUCT_OWNER', 'BUSINESS_ADMIN', 'TECHNICAL_OWNER')),
  recipient_key TEXT NOT NULL CHECK(length(recipient_key) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK(length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(state IN ('PENDING', 'SENDING', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_FINAL')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE audit_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 64),
  entity_id TEXT CHECK(entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 64),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
  details_hash TEXT CHECK(details_hash IS NULL OR (length(details_hash) = 64 AND details_hash NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE TRIGGER audit_log_is_append_only_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;
CREATE TRIGGER audit_log_is_append_only_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;
`;

export const initialSchemaMigration = defineMigration(1, "initial_schema", sql);
