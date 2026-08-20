# 13. Jira create adapter и контролируемое включение

## Цель и пользовательская ценность

Подключить единственную разрешённую операцию записи — создание Feature в production Jira — так, чтобы запрос выполнялся только после атомарной проверки всех предусловий, а любой неоднозначный исход оставлял систему fail closed. Creator получает реальный key/link без риска скрытого повторного POST.

## Почему сейчас

HTTP POST нельзя добавлять раньше, чем готовы RBAC, Draft/READY, Catalog, metadata boundary, duplicate decision, audit, operation claim, `UNKNOWN`, reconciliation и уведомления. Этап является отдельным write gate: он не исправляет незавершённые зависимости и не разрешает их обходить feature flag.

## Зависимости и предусловия

Приняты этапы 1–12. Закрыты O-002/O-003/O-004/O-005/O-007. Есть одобренные production metadata/options snapshot и mapper version, минимально привилегированный service credential, validated fixed origin/path, approved reconciliation runbook и trusted PO routes. Отдельно согласовано окно контролируемого write test.

## Scope

- Узкий Jira Server create adapter для фиксированного origin/path/project/type.
- Startup/release gate и двухступенчатый feature flag: compiled capability + operator enablement.
- Строгая request/response schema, timeout/TLS/redirect policy и error classifier.
- Связывание adapter только с уже claim-нутой immutable posting operation.
- Read-after-create по полученному ID/key без повторного create.
- Controlled synthetic/disposable write verification и немедленное выключение при contract drift.

## Вне scope

Произвольный HTTP/JQL, update/transition/comment, assignee/reporter, custom correlation marker, массовый импорт, автоматический retry из `UNKNOWN`, пользовательская кнопка/preview и изменение стандартного Jira workflow.

## Компоненты и файлы

- `packages/idea-to-jira-plugin/src/jira/create-client.ts`, `request-schema.ts`, `response-schema.ts`, `error-classifier.ts`.
- `packages/idea-to-jira-plugin/src/posting/posting-service.ts` и transport boundary этапа 10.
- `packages/idea-to-jira-plugin/src/runtime/write-gate.ts`, startup readiness и health details без secret.
- `packages/idea-to-jira-plugin/src/config.ts`, `openclaw.plugin.json`, `config/openclaw.json5`, `.env.example` — только SecretRef/не секретные knobs.
- Contract/integration fixtures с synthetic values; approved write-test runbook без production payload samples.

## Атомарные инженерные задачи

1. Удалить возможность принимать origin, method, path, project/type, fields, headers или credential из tool/model/user input.
2. Прочитать Jira credential только из runtime SecretRef; валидировать presence, но никогда не сохранять value в SQLite/log/audit.
3. Зафиксировать allowlisted origin и endpoint; запретить cross-origin redirect, arbitrary proxy и неожиданный response content type.
4. На startup сверить Jira Server compatibility, project `18100`/`FPF`, Feature `11500`, metadata/options hash, mapper/contract version, permission scope и route readiness.
5. Оставлять gate `DISABLED` при missing/stale evidence, migration/recovery error, audit failure, absent reconciliation authority или unknown config key.
6. Перед network call повторно проверить trusted actor/owner, активного Creator, exact Draft version, Catalog/metadata/duplicate proof, payload hash и claimed operation.
7. Передавать adapter только immutable canonical payload; повторная сериализация должна давать тот же hash.
8. Реализовать fixed POST с bounded connect/read/overall timeouts и size limits; raw headers/body не логировать.
9. Классифицировать ошибку консервативно по transport phase: если нельзя доказать, что request не отправлен/не принят, записывать `UNKNOWN`.
10. Принять успех только по валидной Jira response schema с реальным ID/key; malformed/partial response переводить в `UNKNOWN` без придумывания key.
11. Собрать link из trusted origin и validated key. Не использовать sequence prediction или model output.
12. Выполнить bounded read-after-create; его сбой создаёт alert/postcondition status, но никогда второй POST.
13. Транзакционно завершить operation `CREATED` и создать notification intents; crash между response и commit восстанавливается через этап 11.
14. Реализовать kill switch, который запрещает новые claims/sends, не повреждая CREATED/UNKNOWN и notification delivery.
15. Провести отдельно одобренный controlled write test; сохранить только санитаризированный evidence reference и фактический call count.
16. Добавить regression test, что plugin model-tool allowlist не содержит create/retry/generic HTTP tool.

## Границы данных, состояний и интеграций

Jira client получает только `ValidatedPostingRequest` с pinned contract/mapper/metadata versions. Credential и origin принадлежат deployment boundary. Ответ становится Jira identity только после schema validation; request/response bodies не входят в audit. Notification outbox начинается после durable `CREATED`, а не после HTTP status без commit.

## Безопасность и надёжность

Deny by default, least privilege и egress allowlist обязательны. Gate не может быть включён моделью, Telegram callback или содержимым Draft. Retry разрешён только для доказанно pre-send failure в bounded policy; `UNKNOWN`, recovered unsafe `POSTING` и malformed success никогда не выбираются scheduler. Kill switch и credential rotation проверяются без раскрытия secret.

## Миграция, rollback и recovery

Сначала deploy с compiled adapter и `enabled=false`; затем read-only preflight; затем контролируемое включение. Rollback выключает новые writes до смены binary. Если старая версия не понимает schema/operation version, startup останавливает create. Credential rotation не переписывает исторические записи. Любая операция в небезопасной фазе после crash проходит stage-11 recovery без POST.

## Тесты

### Unit/contract

- Exact project/type и все обязательные поля JC-001—008.
- JSON shape/options, unknown-field reject, omitted assignee/reporter/status/correlation marker.
- Canonical payload/hash; response key/id/link validation.
- Error matrix 400/401/403/429/5xx/timeout/malformed success.

### Integration/security/recovery

- Mock Jira Server проверяет exact method/path/origin/headers и один POST при concurrent triggers.
- Stale metadata/Catalog/role/Draft/duplicate proof/audit failure → ноль POST.
- Redirect/origin/header/payload injection → reject до сети.
- Kill/crash в каждой transport phase; may-have-sent → `UNKNOWN`, restart → ноль POST.
- Notification retry/read-after-create failure → ноль дополнительных POST.
- Контролируемый production-safe smoke выполняется только по отдельному approval и с disposable/synthetic issue policy.

## Проверяемые критерии приёмки

1. Write gate нельзя включить при невыполненном prerequisite или stale contract evidence.
2. Единственный network write — fixed create POST с mapper allowlist.
3. Concurrent/replayed trigger создаёт не более одного вызова transport.
4. Любая неоднозначность даёт `UNKNOWN` и блокирует автоматический повтор.
5. Реальный key/link сохраняется только из валидированного ответа или manual reconciliation.
6. Секреты и raw Jira payload отсутствуют в Git, SQLite business records, логах и audit.

## Exit criteria

- Все 18 contract tests из `JIRA_CREATE_CONTRACT.md` автоматизированы и проходят на fake/test boundary.
- Controlled enable/disable и kill-switch проверены; default остаётся disabled в repository config.
- Production metadata/permission evidence и write-test approval зафиксированы вне Git с безопасной ссылкой.
- Ни одного открытого blocker этапов 1–12; этап 14 может упаковать эксплуатационный release.

## Трассируемость

BR-004/006/010/012; FR-005, FR-036, FR-060—086, FR-103/104, FR-110—112; NFR-010—019, NFR-030—038, NFR-053, NFR-070—075, NFR-080/082/083, NFR-090—095/097; D-001—010, D-018—023; JC §3–13 и contract tests 1–18; O-002—O-005/O-007.

## Риски, неизвестные и решения

- **Evidence needed:** точная production REST path/auth scheme, metadata/value shapes, permission и TLS/egress behavior.
- **Risk:** HTTP stack не доказывает pre-send для части network ошибок; default — `UNKNOWN`.
- **Decision needed:** controlled production write-test cleanup/retention policy без workflow transition со стороны plugin.
- **Blocker:** отсутствие любого обязательного evidence сохраняет write gate disabled, но не мешает read-only работе системы.
