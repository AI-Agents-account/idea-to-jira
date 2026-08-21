# Audit, observability, redaction и privacy baseline

**Версия контракта:** audit envelope `1`, taxonomy `1`, retention inputs `1`

**Статус:** Stage 03 baseline; Jira write по-прежнему отключён.

## 1. Scope и границы этапа

В scope:

- typed content-free audit envelope и единственный append-only SQLite writer;
- `AuditedCriticalOperation`, который атомарно связывает критичную мутацию и audit insert;
- отдельные local correlation/request/draft/operation/notification IDs;
- closed structured log schema, bounded metric names/labels и alert outbox interface;
- централизованные URL/header/token/Telegram/provider-error redactors с drop-by-default;
- безопасная error taxonomy без сериализации internal cause;
- retention metadata и access-controlled sanitized audit export;
- migration `002_audit_observability_baseline`, сохраняющая legacy history без выдуманного actor/correlation.

Вне scope:

- monitoring backend, dashboards, production SLO и alert destination/routing;
- выполнение retention deletion, backup lifecycle и production incident channel;
- RBAC implementation и окончательный authorizer для audit export;
- raw payload capture ради диагностики;
- Jira read/write, reconciliation и любые внешние записи.

## 2. Audit contract

`AuditEvent` допускает только:

- version/event ID/timestamp;
- actor kind и user ID либо необратимый local reference hash;
- action, target type/ID, outcome и bounded code;
- local correlation/request/draft/operation/notification links;
- versions и SHA-256 details hash;
- correction link и retention metadata.

Full Draft, transcript, Telegram update, Jira/model/STT body, duplicate contents, headers и credentials в типе отсутствуют. `SqliteAuditWriter` предоставляет только `append`; DB triggers запрещают `UPDATE` и `DELETE`. Исправление — новый event с `correctionOfEventId`.

Критичная операция обязана использовать `AuditedCriticalOperation.run(event, mutate)`: мутация и audit insert выполняются в одном `criticalTransaction`. Ошибка audit откатывает мутацию. Это обязательный boundary для будущих grant/revoke/deny, Draft/operation transitions и reconciliation.

## 3. Correlation semantics

- `correlationId` — локальная связь событий одного trace.
- `requestId` — отдельный локальный request.
- `draftId`, `operationId`, `notificationId` — отдельные domain IDs.
- Ни один из них не является Jira key, Jira issue ID, Jira custom field или Jira-supported idempotency key.
- Эти IDs нельзя добавлять в Jira summary/description/labels/payload.

## 4. Redaction и safe errors

`sanitizeClassifiedRecord` использует явную field classification; неизвестные поля отбрасываются. URL теряет credentials/query/fragment и variable path segments. Header sanitizer допускает только ограниченный operational allowlist и полностью отбрасывает authorization/cookie. Telegram sanitizer оставляет только update/message ID и тип события. Provider error sanitizer оставляет provider, bounded code, retryable и status class; exception message/body/cause не сериализуются.

`SafeError` хранит internal `cause` только в памяти. `toJSON()` и `toSafeView()` возвращают code, общий message и retryable. Неизвестная exception становится `INTERNAL_ERROR`.

Healthcheck не печатает URL или raw exception; результат — закрытый JSON event.

## 5. Logs, metrics и alerts

Structured log fields: `timestamp`, `component`, `eventType`, `outcome`, optional local correlation/operation ID и safe error code. Arbitrary detail field отсутствует.

Metric registry version 1 фиксирует lifecycle, latency, block, provider, DB/migration, notification и future `UNKNOWN` reconciliation metrics. Labels ограничены `component`, `outcome`, `errorCode`; user/draft/operation/Jira IDs, routes и свободный текст запрещены.

`AlertOutbox` принимает только versioned safe event. Destination отсутствует в event и должен выбираться server-side на этапах 12/14. Числовой production SLO до pilot baseline не заявляется.

## 6. Privacy и retention inputs

| Record class | Metadata | Нормативный input |
| --- | --- | --- |
| Draft versions, Draft и duplicate checks | `DRAFT_90D` | 90 дней после последнего изменения |
| Users/access/role, posting, notification и audit | `AUDIT_1Y` | 1 год, если production policy не строже |
| Неопределённый production lifecycle | `OPERATOR_POLICY` | решение до go-live |

Migration добавляет metadata, но не выполняет удаление. Retention execution, backup coordination и окончательная policy остаются blocker этапа 14.

`SanitizedAuditExporter` требует injected authorizer, cursor и limit `1..1000`. Export не содержит actor reference hash, raw payload или destination. До Stage 04/14 production endpoint для export отсутствует.

## 7. Failure и rollback

- Audit недоступен для критичной операции → transaction rollback и операция запрещена.
- Storage недоступен → model/tool path fail closed; Jira write остаётся физически недоступен.
- Migration несовместима → startup fail closed; rollback не удаляет audit history, восстановление выполняется из проверенного snapshot/read-only export.
- Alert outbox routing отсутствует → нельзя выдавать baseline за production monitoring.

## 8. Acceptance/exit matrix

| Требование | Evidence | Статус |
| --- | --- | --- |
| Security-sensitive transition атомарно пишет sanitized audit | `audit.test.ts`: commit + forced FK failure rollback | PASS |
| Append-only и correction event | DB triggers + correction test | PASS |
| Logs/metrics различают outcome без user text | closed TS types + observability tests | PASS |
| Correlation не трактуется как Jira identity | branded distinct IDs, docs/test, Jira adapter остаётся disabled | PASS |
| Default-drop redaction и nested exception safety | adversarial redaction tests | PASS |
| Metric cardinality bounded | runtime allowlist и reject tests | PASS |
| Retention inputs versioned | migration metadata + version constants | PASS |
| Sanitized export проверяет доступ | deny/allow/limit tests | PASS baseline; final RBAC authorizer Stage 04/14 |
| Grant/revoke/deny не могут обойти audit | обязательный `AuditedCriticalOperation` contract | READY for Stage 04 |
| Production alert routing и retention deletion | out of scope | BLOCKER Stage 12/14 |
| Jira write при audit/storage degradation | write adapter/config остаются disabled | PASS |

## 9. Traceability

BR-012; FR-104, FR-112; NFR-013, NFR-022—NFR-024, NFR-060—NFR-066, NFR-070—NFR-075; D-007—D-009; Jira contract §§4.2—4.3, 10—13.
