import { defineMigration } from "./types.js";

const sql = String.raw`
ALTER TABLE users ADD COLUMN username_snapshot TEXT
  CHECK(username_snapshot IS NULL OR length(username_snapshot) BETWEEN 1 AND 64);
ALTER TABLE users ADD COLUMN display_name_snapshot TEXT
  CHECK(display_name_snapshot IS NULL OR length(display_name_snapshot) BETWEEN 1 AND 256);

ALTER TABLE access_requests ADD COLUMN action_ref TEXT
  CHECK(action_ref IS NULL OR (
    length(action_ref) BETWEEN 20 AND 64 AND
    action_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ));
ALTER TABLE access_requests ADD COLUMN decision_reason TEXT
  CHECK(decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 256);
ALTER TABLE role_grants ADD COLUMN transition_reason TEXT
  CHECK(transition_reason IS NULL OR length(transition_reason) BETWEEN 1 AND 256);

UPDATE access_requests
SET action_ref = lower(hex(randomblob(24)))
WHERE action_ref IS NULL;

CREATE UNIQUE INDEX access_requests_action_ref_idx
  ON access_requests(action_ref)
  WHERE action_ref IS NOT NULL;

CREATE TRIGGER access_requests_require_action_ref_insert
BEFORE INSERT ON access_requests
WHEN NEW.action_ref IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ACCESS_REQUEST_ACTION_REF_REQUIRED');
END;

CREATE TRIGGER access_requests_require_action_ref_update
BEFORE UPDATE OF action_ref ON access_requests
WHEN NEW.action_ref IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ACCESS_REQUEST_ACTION_REF_REQUIRED');
END;

DROP INDEX one_active_role_grant_per_user_role;
CREATE UNIQUE INDEX role_grants_one_live_idx
  ON role_grants(user_id, role)
  WHERE state IN ('ACTIVE', 'SUSPENDED');
`;

export const rbacAccessRequestsMigration = defineMigration(3, "rbac_access_requests", sql);
