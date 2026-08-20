# 15. Integration, E2E, security, recovery и performance quality gates

## Цель и пользовательская ценность

Доказать на собранной системе, что основной путь и опасные отказы соответствуют требованиям: пользовательские данные изолированы, Guest не создаёт и не видит Jira, Creator получает один реальный результат, а crash/timeout/replay не порождают дубликат.

## Почему сейчас

Unit/contract tests отдельных этапов не доказывают их совместимость. Этот этап выполняется после реализации и operational packaging, но до production go-live; найденные дефекты возвращаются в owning stage, а не маскируются waiver без owner/срока.

## Зависимости и предусловия

Этапы 1–14 завершены. Есть hermetic fake Jira/Telegram/STT, disposable integration environment, fault-injection hooks, synthetic fixtures и отдельно управляемый production-safe smoke scope. Traceability baseline в этом каталоге актуален.

## Scope

- Сквозная автоматизированная матрица BR/FR/NFR/D/JC.
- Integration/E2E happy paths text/voice/access/Draft/Catalog/duplicates/create/notifications.
- Security/privacy/authorization/prompt-injection/replay/destination tests.
- Failure/error/crash/restart/restore/UNKNOWN/reconciliation matrix.
- Performance/capacity/soak and dependency/config/image scans.
- Evidence report с exact commands, versions, call counters и unresolved defects.

## Вне scope

Исправления вне отдельного owning PR, нагрузочное воздействие на production без approval, реальные пользовательские данные/credentials в fixtures и формальное «покрытие» требований только ссылкой на manual claim.

## Компоненты и файлы

- `tests/integration/`, `tests/e2e/`, `tests/security/`, `tests/recovery/`, `tests/performance/`.
- Fake Jira/Telegram/Whisper и deterministic clock/fault injector в `tests/harness/`.
- CI workflows/jobs для hermetic checks, scans и artifact retention без private payloads.
- `docs/testing/traceability-matrix.md`, `docs/testing/error-matrix.md` или эквивалентный canonical test report source.
- Existing unit/contract suites рядом с plugin modules.

## Атомарные инженерные задачи

1. Построить machine-reviewable traceability table: requirement → stage → test ID → evidence/artifact; не помечать manual expectation как automated pass.
2. Создать synthetic fixtures для всех ролей, Draft provenance/versions, Catalog/metadata/options, duplicate candidates и Jira responses.
3. E2E text: Guest draft → access request → admin decision → Creator edits → duplicate decision → READY → one create → Creator/PO notifications.
4. E2E voice: accepted audio → Whisper medium → transcript review/correction → new Draft version; raw audio/transcript retention проверяется по policy.
5. Проверить Guest/blocked/suspended/revoked, spoofed sender, cross-peer Draft ID и cross-account destination: детали/search/create недоступны, transport count zero.
6. Проверить stale Draft/Catalog/metadata/duplicate decision, missing required field/option и race around claim: zero POST.
7. Выполнить JC contract tests 1–18 с exact request counter и schema snapshots.
8. Fault matrix: 400/401/403/429/5xx, DNS/TLS/connect/read/overall timeout, redirect, malformed/truncated success, DB busy/full/corruption, disk full, Telegram/STT/Jira outage.
9. Kill process before/after claim, before write, during write, after response before commit, during notification; restart/restore не создаёт второй POST.
10. Для `UNKNOWN` повторить message, READY event, scheduler tick, restart, restore и Catalog/Draft no-op edit: Jira POST counter не увеличивается.
11. Проверить manual reconciliation authorization, ambiguous/no/multiple candidates, replay/concurrency и real-key validation.
12. Security tests: prompt/tool injection, arbitrary JQL/URL/field/header/destination, callback replay, unknown config, path traversal Catalog/backup, log forging и oversized input.
13. Redaction scan логов/audit/test artifacts/backups на secrets, tokens, raw descriptions, Telegram IDs/routes и voice/transcript content.
14. Dependency/SBOM/image/secret/license scans с зафиксированной severity/exception policy.
15. Измерить response latency, duplicate bounds, queue/backpressure, SQLite contention, Whisper CPU/RAM/disk и concurrent pilot capacity; overload деградирует fail closed.
16. Провести soak/restart cycle; проверить leases, outbox, retention и отсутствие unbounded growth/cardinality.
17. Validate Compose/image/config on clean environment; выполнить migration + restore drill как CI/nightly или controlled gate.
18. Сформировать отчёт: exact commit/image digest, environment class, commands, counts, pass/fail/waiver, owner и срок каждого defect.

## Границы данных, состояний и интеграций

Hermetic CI использует fake transports и synthetic data. Любой test с реальной интеграцией отделён, требует approval и disposable/production-safe scope. Test harness не должен добавлять backdoor в production build; fault controls compile/config gated. Артефакты санитаризируются до сохранения.

## Безопасность и надёжность

Нельзя считать happy-path тест достаточным для write system. Критические gates — zero unauthorized POST, one-POST under concurrency, no auto retry from `UNKNOWN`, trusted destination и no secret/private artifact — не waive без явного запрета go-live. Test credentials хранятся только в CI secret store.

## Миграция, rollback и recovery

Каждая поддерживаемая migration проверяется на production-like size и с restore. Test rollback не использует destructive down migration как единственный путь. Failure artifacts должны позволять воспроизведение без user data. После теста внешние disposable objects обрабатываются по заранее утверждённой policy, не автоматическим plugin workflow transition.

## Тесты

Этот этап сам является test program. Минимальные suites:

- unit/property/state-machine/mapper/config/redaction;
- component contract: SQLite, Catalog, metadata, Jira/Telegram/Whisper adapters;
- integration/E2E для FAC-01—12 и BAC-01—10;
- authorization/security/prompt/replay/egress/secret scan;
- error/crash/restart/restore/reconciliation matrix;
- performance/capacity/soak/retention;
- production-safe smoke script, выполняемый на этапе 16 после approval.

## Проверяемые критерии приёмки

1. Все BAC/FAC и обязательные JC tests имеют автоматический или явно обоснованный manual evidence.
2. Unauthorized/stale/concurrent paths дают zero POST; accepted current path — ровно один POST.
3. Timeout/malformed response after may-send → `UNKNOWN`; все повторные события/restart/restore дают zero additional POST.
4. Cross-peer, destination, prompt и config injection tests проходят fail closed.
5. Logs/audit/backups/artifacts проходят redaction/secret/private-data scan.
6. Capacity и latency либо соответствуют утверждённым pilot thresholds, либо go-live blocked.

## Exit criteria

- `npm ci`, JSON/config validation, type-check, unit/contract/integration/E2E/security/recovery/performance suites и image/dependency scans green на release commit.
- Traceability matrix не имеет пропущенных MUST; критические defects/waivers отсутствуют.
- Exact call-count/crash/restore evidence приложен к release record.
- Production-safe smoke подготовлен, но не выполнялся без отдельного разрешения.

## Трассируемость

BR-001—012, BAC-01—10; FR-001—112, FAC-01—12; NFR-001—097 и эксплуатационные критерии раздела 11; D-001—023; JC-001—053 и contract tests 1–18; O-001—O-007.

## Риски, неизвестные и решения

- **Risk:** тестовые doubles скрывают transport semantics; нужен ограниченный integration evidence с фактическим Jira Server 11.3.8.
- **Risk:** performance thresholds без pilot volume/SLO; закрыть O-004/O-006 до verdict.
- **Decision needed:** допустимые severity, flaky-test policy и срок хранения санитаризированных artifacts.
- **Blocker:** любой дефект, допускающий unauthorized/duplicate POST, false CREATED или secret leak, блокирует этап 16.
