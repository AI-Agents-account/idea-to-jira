import { defineMigration } from "./types.js";

const sql = String.raw`
ALTER TABLE draft_versions ADD COLUMN draft_schema_version INTEGER NOT NULL DEFAULT 1
  CHECK(draft_schema_version = 1);
ALTER TABLE draft_versions ADD COLUMN formatter_version INTEGER NOT NULL DEFAULT 1
  CHECK(formatter_version = 1);
ALTER TABLE draft_versions ADD COLUMN domain_json TEXT NOT NULL DEFAULT '{}'
  CHECK(json_valid(domain_json) AND json_type(domain_json) = 'object');
ALTER TABLE draft_versions ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE draft_versions ADD COLUMN completeness_json TEXT NOT NULL DEFAULT '{"complete":false,"reasons":["LEGACY_INCOMPLETE"]}'
  CHECK(json_valid(completeness_json) AND json_type(completeness_json) = 'object');
ALTER TABLE draft_versions ADD COLUMN readiness_json TEXT NOT NULL DEFAULT '{"ready":false,"reasons":[{"code":"LEGACY_UNVERIFIED","disposition":"BLOCKED"}]}'
  CHECK(json_valid(readiness_json) AND json_type(readiness_json) = 'object');
ALTER TABLE draft_versions ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '{"catalog":null,"transcript":{"state":"NOT_REQUIRED"},"duplicate":null,"posting":null,"payloadHashRef":null,"invalidatedByVersion":null,"blockingPriorOperations":[]}'
  CHECK(json_valid(dependencies_json) AND json_type(dependencies_json) = 'object');

DROP TRIGGER draft_versions_are_immutable_update;

UPDATE draft_versions
SET domain_json = json_object(
  'summary', json_object('value', summary, 'provenance', 'USER_STATED'),
  'context', json_object('value', problem, 'provenance', 'USER_STATED'),
  'goalProblemOpportunity', json_object('value', desired_outcome, 'provenance', 'USER_STATED'),
  'targetAudience', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'proposedSolution', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'acceptanceCriteria', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'successMetrics', json_object('value', json(evidence_json), 'provenance', 'USER_STATED'),
  'risksConstraintsDependencies', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'additionalDetails', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'links', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'marketingRequired', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'categoryId', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'moscowId', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'impactedMetricIds', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'routeCandidates', json_object('value', NULL, 'provenance', 'UNKNOWN'),
  'selectedRouteId', json_object('value', NULL, 'provenance', 'UNKNOWN')
),
description = 'Контекст' || char(10) || problem || char(10) || char(10) ||
  'Цель / Проблема / Возможность' || char(10) || desired_outcome;

CREATE TRIGGER draft_versions_are_immutable_update
BEFORE UPDATE ON draft_versions
BEGIN
  SELECT RAISE(ABORT, 'DRAFT_VERSION_IMMUTABLE');
END;

CREATE INDEX drafts_owner_active_idx ON drafts(owner_user_id, state, updated_at)
  WHERE state IN ('EDITING', 'READY');
`;

export const draftVersioningReadinessMigration = defineMigration(4, "draft_versioning_readiness", sql);
