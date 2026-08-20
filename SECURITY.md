# Security Policy

## Supported scope

This repository is an MVP scaffold. Do not expose it to production traffic until every security acceptance criterion in `docs/NON_FUNCTIONAL_REQUIREMENTS.md` has passing evidence.

## Secret handling

Never commit Telegram bot tokens, Jira tokens, OpenClaw Gateway tokens, model API keys, OAuth state, cookies, credentials, transcripts or production database files. `.env` and `data/**` are ignored. Production should use an external secret manager or OpenClaw `SecretRef` values.

If a secret appears in a chat, issue, log or commit, treat it as compromised: revoke it, replace it and inspect repository history before deployment.

## Authorization boundary

Creator status and Business Admin decisions must be evaluated server-side from verified Telegram sender ids. Prompt text, model output, callback payloads and user-supplied role claims are untrusted. Duplicate links and Jira creation are Creator-only operations.

## Jira boundary

The plugin must use a field allowlist and live/fixture metadata validation. Never forward arbitrary model-generated JSON to Jira. A Jira create with an unknown outcome must be reconciled before retrying.

## Reporting

Report vulnerabilities privately to the repository owner. Do not include credentials, personal data or exploitable production details in a public issue.
