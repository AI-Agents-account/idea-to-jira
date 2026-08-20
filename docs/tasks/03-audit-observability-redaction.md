# Этап 03. Audit, observability, redaction и privacy baseline

[К карте этапов](README.md)

## Цель и ценность

Создать безопасную доказательную основу до появления RBAC и Jira операций. Ценность — расследуемость без утечки секретов и пользовательского/Jira содержания.

## Порядок и зависимости

- Этапы 01—02: validated context/config и append-only storage.

## Scope

- typed audit event envelope и append-only writer;
- structured logs, correlation semantics, metrics/alert interfaces;
- централизованная redaction/data classification и safe error taxonomy;
- privacy/retention metadata и санитаризированный export contract.

## Out of scope

- полный мониторинговый backend/поставщик;
- сохранение raw payloads ради диагностики;
- выполнение retention удаления и production alert routing — этапы 12/14.

## Конкретные компоненты и файлы

- целевые `src/audit/*`, `src/observability/*`, `src/security/redaction.ts`, `src/errors/*`;
- audit schema/migration и tests/fixtures;
- `scripts/healthcheck.mjs`, config и runbook paths на следующих этапах.

Указанные новые пути — целевая декомпозиция. Перед созданием файла исполнитель обязан сверить фактические OpenClaw SDK/API и сохранить узкую ответственность; путь не является разрешением выдумать неподтверждённый интерфейс.

## Атомарные задачи

1. Классифицировать поля на allowed IDs/versions/hashes/outcomes и forbidden secrets/raw content; создать typed audit envelope.
2. Реализовать append-only insert API без update/delete для application path; correction — новое событие.
3. Определить correlation ID как локальную трассировку, явно не Jira identity; разделить request/draft/operation/notification IDs.
4. Создать redaction API для URL, headers, token-like values, Telegram update, Jira/model/STT errors; default — drop unknown field.
5. Ввести safe error codes для пользователя/оператора и отдельные внутренние cause без raw body serialization.
6. Добавить метрики interfaces/названия для lifecycle, latency, blocks, DB, migration и будущего `UNKNOWN`; не публиковать неподтверждённые SLO.
7. Определить alert event/outbox boundary; destination выбирается server-side и появится отдельно.
8. Задать retention class на records и санитаризированный audit export с проверкой доступа.

## Data, state и integrations

- Audit: actor ID, action, target IDs, versions, hashes, outcome/error code, timestamp; без full Draft/transcript/Jira candidate.
- Logs считаются менее долговечным operational stream и не заменяют audit transaction.

## Security и reliability

- Никогда не логировать env, auth headers/cookies, raw Telegram update, voice bytes, full prompt/model/Jira body/description.
- Redaction тестируется adversarial fixtures; неизвестные exception objects не stringify целиком.
- Vulnerability detail идёт только private incident channel, не в публичную документацию/issue.

## Migration, rollback и recovery

- Добавить audit schema транзакционной migration; existing records не backfill выдуманными actor/outcome.
- Rollback не удаляет audit history; при несовместимости — restore snapshot либо read-only export.
- Если audit для критичной операции недоступен, сама операция fail closed до согласованной atomic policy.

## Тесты

- Unit: allow/drop/redact matrix, nested errors, URLs, headers, token patterns, Unicode.
- Audit: append-only behavior, atomic write с role/state transition, correction event.
- Leak tests: fixtures/log capture не содержат secrets, raw descriptions, transcripts; metric labels bounded.

## Acceptance и exit criteria

- Каждая security-sensitive операция может атомарно записать санитаризированный audit.
- Логи/метрики различают outcomes, но не несут пользовательский текст.
- Correlation ID нигде не трактуется Jira key/idempotency API.
- Новые сервисы имеют обязательный audit/redaction integration contract.

## Traceability

BR-012; FR-104, FR-112; NFR-013, NFR-022—NFR-024, NFR-060—NFR-066, NFR-070—NFR-075; D-007—D-009; Jira contract §§4.2—4.3, 10—13.

## Риски, unknowns и decisions

- Atomicity domain state + audit требует общей DB transaction; запрет best-effort audit для критичных решений.
- Cardinality metrics может раскрыть IDs или исчерпать backend; IDs только в trace/audit, не labels.
- Retention policy backups требует operator decision на этапе 14.
