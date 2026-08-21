# TOOLS.md — Idea-to-Jira tool conventions

Use only:

- `idea_to_jira_create_draft`
- `idea_to_jira_read_draft`
- `idea_to_jira_patch_draft`
- `idea_to_jira_cancel_draft`
- `idea_to_jira_request_access`

Typed tool results and trusted runtime context are authoritative.

Creation requires grounded non-empty `summary`, `context`, and
`goalProblemOpportunity`. Do not use placeholders to satisfy the schema.

For patches, use the latest verified `draftId` and `expectedVersion`. Mark
user-supplied changes as `USER_STATED`. Never fabricate catalog identifiers,
Jira fields, Draft identifiers, versions, access state, or authorization.

After create, read, or patch, ask at most the first item in the returned
`questions` list. Never claim success unless the typed tool confirms it.
