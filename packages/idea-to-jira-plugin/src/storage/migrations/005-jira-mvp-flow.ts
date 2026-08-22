import { defineMigration } from "./types.js";

const sql = String.raw`
CREATE TABLE jira_duplicate_decisions (
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version >= 1),
  config_hash TEXT NOT NULL CHECK(length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash) = 64 AND metadata_hash NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('DUPLICATE', 'RELATED', 'UNIQUE', 'UNCERTAIN')),
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json) AND json_type(decision_json) = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(draft_id, draft_version, config_hash, metadata_hash),
  FOREIGN KEY(draft_id, draft_version) REFERENCES draft_versions(draft_id, version) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE jira_field_answers (
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version >= 1),
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash) = 64 AND metadata_hash NOT GLOB '*[^0-9a-f]*'),
  field_id TEXT NOT NULL CHECK(length(field_id) BETWEEN 1 AND 128),
  semantic_value_json TEXT NOT NULL CHECK(json_valid(semantic_value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(draft_id, draft_version, metadata_hash, field_id),
  FOREIGN KEY(draft_id, draft_version) REFERENCES draft_versions(draft_id, version) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE jira_confirmations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  actor_hash TEXT NOT NULL CHECK(length(actor_hash) = 64 AND actor_hash NOT GLOB '*[^0-9a-f]*'),
  chat_hash TEXT NOT NULL CHECK(length(chat_hash) = 64 AND chat_hash NOT GLOB '*[^0-9a-f]*'),
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version >= 1),
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash) = 64 AND metadata_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  confirmed_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY(draft_id, draft_version) REFERENCES draft_versions(draft_id, version) ON DELETE RESTRICT,
  CHECK(consumed_at IS NULL OR consumed_at >= confirmed_at)
) STRICT;
CREATE INDEX jira_confirmations_binding_idx ON jira_confirmations(draft_id, draft_version, metadata_hash, payload_hash);
`;

export const jiraMvpFlowMigration = defineMigration(5, "jira_mvp_flow", sql);
