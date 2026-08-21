# Декомпозиция реализации Idea-to-Jira MVP

**Актуализировано:** 2026-08-21
**Baseline:** Stage-01—05 и controlled Stage-05A foundation реализованы; Jira integration ещё не реализована.

Каждый brief задаёт проверяемый инженерный этап. Фактические возможности подтверждаются кодом и тестами, а не наличием brief.

## Принятый Jira MVP plan

Jira integration больше не привязана к numeric project, issue-type, field или option IDs. Deployment config задаёт:

- Jira URL;
- project key;
- issue-type name;
- fixed JQL;
- точный список Jira issue fields для search/context;
- search/context limits;
- metadata refresh policy;
- необходимость confirmation перед create.

При старте контейнера plugin получает актуальные project/type IDs, create metadata, required fields, defaults/options и permissions. Runtime metadata не становится hardcoded contract.

Целевой vertical flow:

```text
Draft
→ Jira startup discovery
→ configured JQL + configured fields
→ bounded candidate context
→ DUPLICATE / RELATED / UNIQUE / UNCERTAIN
→ dynamic required fields
→ preview + confirmation
→ atomic create operation
→ one Jira POST
→ real key/link либо UNKNOWN
```

Knowledge Catalog, voice и PO notifications не блокируют первую полную Jira MVP integration. Они интегрируются после рабочего text Jira flow и до production go-live. Stage-05A принимается в финальном E2E всего flow, а не отдельным ранним gate.

## Актуальный порядок

| № | Этап | Состояние / результат |
|---:|---|---|
| 01 | [Runtime/config/security](01-runtime-config-security-foundation.md) | Реализован |
| 02 | [SQLite/migrations](02-persistence-schema-migrations.md) | Реализован |
| 03 | [Audit/observability](03-audit-observability-redaction.md) | Реализован |
| 04 | [RBAC/access](04-rbac-access-requests.md) | Реализован |
| 05 | [Draft/versioning/readiness](05-draft-versioning-readiness.md) | Реализован |
| 05A | [Controlled text pilot](05a-live-text-pilot.md) | Foundation реализован; acceptance перенесён в финальный E2E |
| 08 | [Полная Jira MVP integration](08-jira-metadata-whitelist-mapper.md) | **Следующий этап:** config, discovery, search, context, dedup, dynamic form, preview, create/idempotency |
| 06 | [Knowledge Catalog](06-knowledge-catalog.md) | После рабочего Jira text flow; не hardcodes Jira IDs |
| 07 | [Voice/Whisper](07-voice-whisper.md) | После Jira text flow, до полного E2E |
| 12 | [Notifications](12-notifications.md) | После подтверждённого Jira create |
| 14 | [Operations](14-backup-restore-deploy-operations.md) | До production deployment |
| 15 | [Integrated quality gates](15-integrated-quality-gates.md) | Полный Telegram/Draft/Jira/voice/restart/security E2E |
| 16 | [Go-live](16-production-readiness-go-live.md) | Production readiness и controlled smoke |

Briefs 09, 10, 11 и 13 сохраняют детальные контракты duplicate/idempotency/recovery/create, но реализуются как части Stage-08 vertical integration. При конфликте с новым Stage-08 и `docs/JIRA_CREATE_CONTRACT.md` применяется новый configuration-driven контракт.

## Инварианты

1. URL/project/type/JQL/search fields задаются только deployment config, не model/user input.
2. Credential — только runtime secret.
3. Numeric Jira IDs отсутствуют в production config/code constants и разрешаются из Jira metadata.
4. Search читает только configured fields и применяет bounds до model context.
5. Jira content недоверенно и не меняет policy/tools.
6. Unsupported required create field блокирует create, но не Draft.
7. Preview/confirmation привязаны к exact Draft/metadata/payload versions.
8. Concurrent/replayed events дают не более одного POST.
9. Ambiguous outcome — `UNKNOWN`, без автоматического POST retry.
10. Jira key/link существуют только после валидного response/reconciliation.
11. Credentials, raw Jira bodies и private issue fixtures не попадают в Git/log/audit.

## Общие quality gates

Для Stage-08 обязательны:

- `npm ci`;
- `npm run validate:json`;
- `npm run check`;
- `npm run build`;
- `git diff --check`;
- config/Compose validation;
- fake Jira integration/error matrix;
- migration/restart/security tests;
- secret scan;
- подтверждение отсутствия hardcoded Jira IDs и model-controlled transport.

Live read probe выполняется только с защищённым credential. Live Jira POST требует отдельного explicit approval после fake/integration tests; merge кода сам по себе не разрешает production write.
