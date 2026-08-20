# Декомпозиция реализации production-ready MVP

**Статус:** implementation baseline после анализа требований и scaffold на commit `83ac30114028c9165960dd1189a9550e8aeda903`

**Дата анализа:** 2026-08-20

**Язык implementation briefs:** русский

Этот каталог превращает нормативные требования в последовательность вертикальных этапов. Каждый файл — самостоятельный brief для отдельной инженерной сессии: с границами, конкретными компонентами, атомарными задачами, тестами и проверяемым выходом. Это план реализации, а не свидетельство готовности функций. Указанные новые файлы и каталоги — целевые пути внутри `packages/idea-to-jira-plugin/` и `docs/`; их наличие в brief не означает, что они уже реализованы.

## 1. Вердикт готовности и доказательная база

Репозиторий является корректно обозначенным **production-oriented scaffold**, но не MVP. Сейчас доказаны только:

- загрузочная структура mixed plugin и один typed tool `idea_to_jira_validate_draft`;
- нормализация трёх обязательных строк и дедупликация `evidence`/`labels` в памяти;
- базовый parser двух полей plugin config;
- намеренно запрещающий запись `DisabledJiraIssueClient`;
- два unit-теста draft formatter;
- сборка TypeScript, JSON validation, CI-каркас, Dockerfile/Compose и HTTP healthcheck Gateway;
- peer-scoped DM-конфигурация с allowlist единственного существующего tool;
- неполная fail-closed заготовка Catalog.

Не доказаны RBAC, сохранение состояния, полноценный Draft, Whisper, Catalog import, Jira metadata/read/write, duplicate search, идемпотентность, `UNKNOWN`, reconciliation, уведомления, audit, retention, backup/restore и production readiness. До завершения этапа 13 Jira POST остаётся физически и конфигурационно выключенным.

Нормативная база анализируется как единый набор: [README](../../README.md), [архитектура](../../ARCHITECTURE.md), [бизнес-требования](../BUSINESS_REQUIREMENTS.md), [функциональные требования](../FUNCTIONAL_REQUIREMENTS.md), [нефункциональные требования](../NON_FUNCTIONAL_REQUIREMENTS.md), [контракт Jira create](../JIRA_CREATE_CONTRACT.md), [решения](../DECISIONS.md), исходники, тесты, plugin manifest, OpenClaw config, Dockerfile, Compose и scripts.

## 2. Легенда карты требований

- **Специфицировано** — достаточно для реализации, хотя код может отсутствовать.
- **Предположение** — обратимый default, который разрешено применить и явно зафиксировать.
- **Нужно решение** — выбор materially меняет контракт, данные или эксплуатацию.
- **Нужно доказательство** — требуется runtime/API/production evidence; чтение Jira не подменяет write contract.
- **Противоречие** — нормативные или фактические представления расходятся; до реализации enum/schema нужно унифицировать.
- **Блокер** — без закрытия нельзя безопасно включить production create/go-live.
- **Уточнение** — не блокирует ранние этапы при fail-closed default.

## 3. Карта требований и пробелов

| Область | Нормативное состояние | Scaffold evidence | Классификация пробела | Блокер / следующий результат |
|---|---|---|---|---|
| Акторы и permissions | Guest/Creator/Business Admin/PO/Technical Owner/Catalog Owner; host-derived sender ID; server-side checks | RBAC и requester-context handlers отсутствуют; account открыт для DM, allowlist содержит только draft validator | Специфицировано; нужна реализация | **Блокер POST:** этапы 1, 3, 4 |
| Access states | `GUEST/PENDING/CREATOR/SUSPENDED/BLOCKED`, атомарные решения и anti-replay | Таблиц, handlers и тестов нет | Специфицировано | Этап 4 |
| Draft states/versioning | Версионный Draft, CAS, provenance, invalidation, READY | В памяти собирается сокращённый объект со строковым `status: ready`; persistence нет | Специфицировано; текущая модель недостаточна | Этапы 2, 5 |
| Номенклатура Draft | FR использует `EDITING`, архитектурная диаграмма — `DRAFTING`/`TRANSCRIPT_REVIEW`; posting FR начинается с `PENDING`, архитектура — `CLAIMED` | Schema v1 и D-025 закрепляют `EDITING`/`PENDING`; transient состояния вынесены из persistent enum | **Закрыто** | Этап 2: migration contract tests отклоняют `DRAFTING`/`CLAIMED` |
| Telegram/channel boundary | Только выделенный account и DM, peer isolation, destination lock | Config задаёт binding, `groupPolicy: disabled`, peer DM scope; server-side pre-tool/hook checks не доказаны | Частично специфицировано; нужна E2E evidence | Этапы 1, 15 |
| Knowledge Catalog | Immutable version/checksum/schema, verified routes/options/PO destinations, atomic activation/rollback | Markdown-заготовка и `readFile`; нет schema/checksum/import/storage | Специфицировано; lifecycle OPEN | **Блокер production Catalog:** D-012/O-001, этап 6 |
| Voice/STT | Локальный Whisper `medium`, review/correction, bounded retention | Не реализовано; image/runtime/resources не подтверждены | Специфицировано + нужно доказательство ресурсов | Этап 7; capacity evidence в 15/16 |
| Jira read metadata | Server-side compatibility/create metadata/options snapshot с hash/version | Нет HTTP client и snapshot; env не читается plugin config | Нужно доказательство | **Блокер POST:** O-002/O-003, этап 8 |
| Jira write contract | Единственный fixed POST, whitelist mapping, 8 обязательных элементов, omitted assignee/reporter, no transition/correlation marker | Adapter всегда throw; фактические value shapes/options неизвестны | Контракт специфицирован; runtime evidence needed | **Блокер POST:** этапы 8, 10, 11, 13 |
| Duplicate search | Catalog narrowing + bounded fixed-scope Jira read; детали только Creator; четыре решения | Не реализовано | Специфицировано; лимиты требуют evidence | **Блокер POST:** O-004, этап 9 |
| READY/create trigger | Автоматически, без preview/button; повторная роль и atomic claim | Нет predicate, operation repository или trigger | Специфицировано | **Блокер POST:** этапы 5, 9–13 |
| Идемпотентность/`UNKNOWN` | Unique local key, ambiguous result → `UNKNOWN`, no auto retry/new operation | Только fail-closed stub, state machine отсутствует | Специфицировано | **Блокер POST:** этапы 10–11 |
| Reconciliation/restart | Детерминированная защищённая ручная процедура, evidence trail; unsafe `POSTING` → `UNKNOWN` | Нет operations/runtime hooks/runbook | Специфицировано; evidence threshold OPEN | **Блокер POST:** O-007, этап 11 |
| Notifications | Creator/PO/admin, trusted destinations, delivery idempotency independent from POST | Нет notification service; PO routes отсутствуют | Специфицировано; lifecycle needs decision/evidence | **Блокер enable:** O-005, этап 12 |
| Audit/logging/redaction | Append-only audit, structured logs/metrics/alerts, no raw private payloads/secrets | Только healthcheck console output | Специфицировано | **Блокер POST:** этап 3; зрелость в 14–16 |
| Security/privacy | Least privilege, SecretRef/env, redaction, egress, storage modes, retention, incident handling | Некоторые container hardening и Git excludes есть; runtime policy/tests отсутствуют | Частично реализовано; evidence needed | Этапы 1–3, 14–16 |
| Persistence/migrations | SQLite WAL/FK/FULL critical tx, migration/consistency/recovery | SQLite dependency/schema/path отсутствуют | Специфицировано | Этап 2 |
| Deployment/operations | Isolated pinned image+digest, startup validation, backup/restore, rollback, runbooks | Tag pin и Compose hardening есть; latest stable/digest/release record/readiness/backup не доказаны | Частично; нужно доказательство и решения | **Go-live blocker:** O-006, этапы 14–16 |
| Acceptance/tests | Unit/security/integration/error matrix/E2E/performance/UNKNOWN invariant | 2 unit tests и CI базовой сборки | Специфицировано; почти полностью отсутствует | Этап 15 |

## 4. Подтверждённые contradictions и важные refinements

### Блокирующие решения/evidence

1. **Канонические enum schema v1 — закрыто D-025.** Persistent значения следуют FR-101—FR-103: `EDITING` и `PENDING`; `TRANSCRIPT_REVIEW` проектируется отдельным transcript/substate, а atomic claim — уникальной `PENDING` operation до перехода в `POSTING`.
2. **D-012 / O-001:** authoritative sources, reviewer, publication, cadence и rollback Catalog.
3. **O-002:** production create metadata, exact JSON shapes/allowed option IDs и ограничения строк. GET существующих issues не является evidence write contract.
4. **O-003:** service account, auth scheme, minimal search/create scope и rotation proof.
5. **O-004:** bounded Jira search template и limits после load test.
6. **O-005:** проверка и lifecycle PO Telegram route, fallback и privacy.
7. **O-006:** RPO/RTO, availability SLO, maintenance window, backup cadence, incident owner.
8. **O-007:** полномочия и evidence threshold manual reconciliation; любое разрешение новой отправки остаётся отдельным ручным решением.
9. **Production runtime evidence:** последний стабильный OpenClaw на дату deploy, digest, совместимость plugin SDK, выбранный canonical model route, Whisper `medium` capacity, network policy и production-safe smoke approval.

### Неблокирующие уточнения с fail-closed default

- Конкретная SQLite-библиотека и migration runner выбираются на этапе 2; default должен быть минимальным, поддерживаемым Node 24 и не ослаблять durability.
- Optional Jira route fields остаются выключенными, пока поле не включено в versioned mapper и contract test.
- При неизвестном/просроченном Catalog Draft редактируется, но READY/create выключены.
- Любая неразличимая транспортная ошибка после начала отправки классифицируется как `UNKNOWN`, а не retryable.
- Неподтверждённые SLO не публикуются как достигнутые; сначала измеряются.

## 5. Порядок этапов и зависимости

```text
01 Foundation
 └─> 02 Persistence
      ├─> 03 Audit/security baseline
      │    └─> 04 RBAC
      │         └─> 05 Draft
      │              ├─> 06 Catalog
      │              └─> 07 Voice
      └──────────────> 08 Jira metadata/mapper (read-only)
06 + 08 + 04 + 05 ──> 09 Duplicate search
03 + 04 + 05 + 08 + 09 ──> 10 Posting/idempotency (transport disabled)
10 ──> 11 Reconciliation/restart recovery
06 + 03 + 11 ──> 12 Notifications
08 + 09 + 10 + 11 + 12 ──> 13 Jira create enablement
13 + 02 + 03 ──> 14 Backup/deploy/operations
all ──> 15 Integrated verification ──> 16 Go-live
```

| № | Этап | Проверяемый результат |
|---:|---|---|
| 01 | [Runtime, config и security foundation](01-runtime-config-security-foundation.md) | Агент запускается с валидированной конфигурацией и deny-by-default boundary; Jira write отсутствует |
| 02 | [SQLite, schema и migrations](02-persistence-schema-migrations.md) | Воспроизводимая schema v1, транзакции и crash-safe migration/consistency proof |
| 03 | [Audit, observability, redaction и privacy baseline](03-audit-observability-redaction.md) | Каждое последующее действие получает безопасный append-only audit и correlation semantics |
| 04 | [RBAC и заявки доступа](04-rbac-access-requests.md) | Trusted admin decision создаёт/отзывает Creator атомарно; Guest fail closed |
| 05 | [Draft, provenance, versioning и READY foundation](05-draft-versioning-readiness.md) | Полный Draft хранится с CAS и invalidation; READY ещё не вызывает POST |
| 06 | [Knowledge Catalog lifecycle](06-knowledge-catalog.md) | Проверенная version/checksum/schema импортируется и атомарно активируется/откатывается |
| 07 | [Voice и Whisper medium](07-voice-whisper.md) | Voice → reviewable transcript → versioned Draft без хранения raw audio сверх policy |
| 08 | [Jira metadata и whitelist mapper](08-jira-metadata-whitelist-mapper.md) | Read-only snapshot и deterministic payload contract; network POST невозможен |
| 09 | [Duplicate search и решение Creator](09-duplicate-search-decisions.md) | Bounded fixed-scope search, privacy boundary и version-bound decision |
| 10 | [Posting state machine и idempotency](10-posting-idempotency-unknown.md) | Atomic claim и `UNKNOWN` invariants доказаны на fake transport; production POST выключен |
| 11 | [Reconciliation и restart recovery](11-reconciliation-restart-recovery.md) | Unsafe recovery никогда не повторяет POST; ручные решения защищены и аудируются |
| 12 | [Уведомления Creator/PO/Admin](12-notifications.md) | Идемпотентная доставка отделена от Jira operation и использует trusted routes |
| 13 | [Jira create adapter и controlled enablement](13-jira-create-enablement.md) | Единственный fixed POST включается только при полном startup/release gate |
| 14 | [Backup, restore, deploy и operations](14-backup-restore-deploy-operations.md) | Воспроизводимые encrypted backup/restore/rollback и production runbooks |
| 15 | [Integration, E2E, security, recovery и performance](15-integrated-quality-gates.md) | Полная automated evidence matrix, включая one-POST и `UNKNOWN` no-retry |
| 16 | [Production readiness и go-live](16-production-readiness-go-live.md) | Подписанный release record, production-safe smoke, мониторинг и rollback decision |

Параллелизация допустима только там, где не размывается dependency gate. Например, этапы 6–8 можно разрабатывать параллельно после schema/Draft contracts, но этап 9 принимается только на их совместимых версиях.

## 6. Глобальные инварианты для всех этапов

1. Jira create остаётся отключён до приёмки этапов 1–12 и явного controlled enablement этапа 13.
2. Модель никогда не получает direct Jira create, generic HTTP, filesystem, exec, browser, arbitrary message или config/Gateway tool.
3. Identity, actor, chat и destination берутся только из trusted host/server-side context.
4. Guest не видит детали Jira и не достигает duplicate detail/create transport.
5. Любое значимое изменение Draft увеличивает version и инвалидирует READY/search/payload context.
6. Jira payload строится только mapper allowlist; unknown field/value отклоняется.
7. `UNKNOWN` и unsafe recovered `POSTING` никогда не вызывают automatic retry POST.
8. Jira key/link появляются только из валидного response или доказанной manual reconciliation.
9. Notification retry не связан с Jira create retry.
10. Credentials, OAuth/auth-profile state, SQLite, backups, raw voice, transcripts и пользовательские данные не попадают в Git.
11. Логи/audit не содержат raw updates, headers, credentials, полные Jira bodies/descriptions или voice payloads.
12. Каждый этап мигрирует/откатывается или явно доказывает, почему data migration не требуется.

## 7. Общие quality gates и Definition of Done

Для каждого этапа обязательны:

- implementation и tests в одном PR либо в последовательности, где feature остаётся недоступной fail closed;
- type-check, unit tests и repository-native validation;
- regression tests для всех затронутых permissions/state transitions;
- проверка config/schema/migration compatibility и restart behavior;
- отсутствие secrets/private production samples в diff, fixtures, logs и artifacts;
- обновление [архитектуры](../../ARCHITECTURE.md), [README](../../README.md), contract/runbooks при изменении наблюдаемого контракта;
- traceability: каждый acceptance test ссылается на BR/FR/NFR/D/JC;
- доказательство, что failure path оставляет консистентное состояние;
- ручная инспекция tool allowlist, destinations, redaction и write gates.

Глобальный release gate: `npm ci`, `npm run validate:json`, `npm run check`, `npm run build`, Compose rendering, migration/restore tests, security/error matrix, image/dependency/secret scans, production-safe smoke и signed release checklist. Реальные внешние записи выполняются только в отдельно согласованном контролируемом тесте.

## 8. Правило использования briefs

Новая инженерная сессия начинает с соответствующего файла, проверяет актуальный branch/SHA и зависимости, затем реализует только scope этапа. Если открытый blocker не закрыт, сессия оставляет код fail closed и документирует evidence needed; она не подменяет решение догадкой. Exit criteria этапа должны быть проверены до перехода к зависимому brief.
