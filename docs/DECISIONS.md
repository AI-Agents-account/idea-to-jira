# Решения проекта Idea-to-Jira MVP

**Статус:** журнал актуальных решений
**Версия:** 1.0
**Дата:** 2026-08-20
**Целевой контур:** production

## 1. Правило применения

Этот документ имеет приоритет над исходным ТЗ версии 1.0 от 2026-08-20 и над более ранними формулировками в других документах. При изменении решения необходимо обновить запись, связанные требования и Jira contract одной версией документации.

Статусы:

- **ACCEPTED** — обязательно для MVP;
- **SUPERSEDED** — прежнее решение отменено;
- **OPEN** — нужен отдельный дизайн/вход, использовать догадки нельзя;
- **DEFERRED** — не входит в MVP.

Документ публичный: не содержит секретов, персональных admin IDs, внутренних токенов или приватных Jira contents.

## 2. Сводка принятых решений

| ID | Решение | Статус |
|---|---|---|
| D-001 | В MVP нет отдельного Jira preview | ACCEPTED |
| D-002 | В MVP нет кнопки/confirmation token create | ACCEPTED |
| D-003 | Для Creator create автоматический после готовности и решения по дублю | ACCEPTED |
| D-004 | Guest получает Creator только после admin approval trusted identity | ACCEPTED |
| D-005 | Детали Jira-дублей доступны только Creator | ACCEPTED |
| D-006 | Duplicate search: bounded Jira search + Catalog narrowing | ACCEPTED |
| D-007 | Custom Jira correlation field недоступен | ACCEPTED |
| D-008 | `UNKNOWN` без key — fail closed/manual reconciliation, без auto POST retry | ACCEPTED |
| D-009 | Jira key/number обозначает только уже известную задачу | ACCEPTED |
| D-010 | Целевой контур — production | ACCEPTED |
| D-011 | Catalog — отдельная versioned задача; владелец/актуализатор OpenClaw | ACCEPTED |
| D-012 | Способ сбора/обновления Catalog требует отдельного дизайна | OPEN |
| D-013 | После create PO получает Telegram notification | ACCEPTED |
| D-014 | После notification дальнейшая работа идёт по стандартному Jira process | ACCEPTED |
| D-015 | Выделенный Docker-контейнер с последним стабильным OpenClaw | ACCEPTED |
| D-016 | Telegram route для PO принят | ACCEPTED |
| D-017 | Для voice используется Whisper `medium`; ресурсы доступны | ACCEPTED |
| D-018 | Jira Server 11.3.8, FPF id 18100, Feature id 11500 | ACCEPTED |
| D-019 | Required Jira create fields подтверждены evidence | ACCEPTED |
| D-020 | Description бизнес-обязателен | ACCEPTED |
| D-021 | Assignee/reporter omitted; assignee остаётся unassigned | ACCEPTED |
| D-022 | Plugin не выполняет Jira workflow transition | ACCEPTED |
| D-023 | OpenClaw-only без отдельного application backend | ACCEPTED |
| D-024 | SQLite driver — встроенный `node:sqlite` закреплённого Node 24 | ACCEPTED |
| D-025 | Schema v1 использует FR-enums `EDITING` и `PENDING` | ACCEPTED |

## 3. Подробные записи

### D-001 — Отсутствие preview

**Статус:** ACCEPTED
**Решение:** отдельный полный preview Jira Feature перед созданием в MVP не показывается.

**Следствия:**

- нет preview screen/card/state;
- нет шага «подтвердить preview»;
- пользователь по-прежнему отвечает на содержательные уточнения и может исправлять Draft/voice transcript;
- требования исходного ТЗ о preview считаются SUPERSEDED.

### D-002 — Отсутствие кнопки и confirmation token

**Статус:** ACCEPTED
**Решение:** кнопка «Создать в Jira», callback create и одноразовый confirmation token не используются.

**Следствия:**

- deterministic create pipeline запускается по server-side readiness predicate;
- сущность `confirmations` не обязательна для MVP;
- replay/double click заменяются защитой от повторных readiness events и локальной operation idempotency;
- требования исходного ТЗ о кнопке/consume token считаются SUPERSEDED.

### D-003 — Автоматический create Creator

**Статус:** ACCEPTED
**Решение:** для активного Creator Feature создаётся автоматически, когда текущая версия Draft готова и duplicate decision позволяет создание.

**Готовность включает:**

- все Jira-required поля;
- бизнес-обязательный description;
- актуальный Catalog/route;
- актуальный bounded duplicate check;
- `NOT_DUPLICATE` при найденных кандидатах либо `NO_CANDIDATES`;
- отсутствие unresolved assumptions/questions;
- активную роль Creator;
- успешный atomic operation claim.

**Следствия:** admin approval роли не является approval конкретной Feature. Если Draft уже полон, после выдачи Creator выполняются закрытые для Guest duplicate steps и затем автоматический create.

### D-004 — Trusted identity через admin decision

**Статус:** ACCEPTED
**Решение:** Telegram sender ID технически устойчив, но сам по себе не доказывает корпоративную личность. Business Admin принимает решение доверять конкретному host-derived sender ID и выдаёт Creator.

**Следствия:**

- username/display name справочны и не используются для RBAC;
- approval атомарен и аудируется;
- только активный Creator может создать Feature;
- SSO не требуется для MVP;
- администратор не утверждает каждую задачу отдельно.

### D-005 — Duplicate details только Creator

**Статус:** ACCEPTED
**Решение:** Guest не получает Jira keys, links, summaries, descriptions, scores или иные детали кандидатов.

**Следствия:** bounded Jira details запрашиваются/выдаются только после проверки Creator. Для Guest допускается лишь нейтральный статус, что создание недоступно до решения admin, без раскрытия Jira.

### D-006 — Bounded Jira search + Catalog narrowing

**Статус:** ACCEPTED
**Решение:** сначала Catalog определяет продукт/маршрут/поисковые признаки, затем выполняется ограниченный Jira search в фиксированном project scope.

**Следствия:**

- arbitrary JQL/URL/project/fields от модели/пользователя запрещены;
- лимитируются pages/candidates/fields/time;
- ошибка search — fail closed, а не «дублей нет»;
- выбранный дубль прекращает новый create;
- `NOT_DUPLICATE` явно требуется только если кандидаты найдены.

### D-007 — Нет custom correlation field

**Статус:** ACCEPTED
**Решение:** создать или использовать отдельное Jira custom correlation field нельзя.

**Следствия:**

- local operation ID/idempotency key/payload hash остаются только внутри plugin;
- их нельзя считать Jira issue identity;
- не добавлять скрытые markers в summary/description/labels;
- reconciliation не может полагаться на уникальный Jira marker.

### D-008 — UNKNOWN: fail closed

**Статус:** ACCEPTED
**Решение:** если POST мог быть принят Jira, но ответ не получен, operation переходит в `UNKNOWN`. Автоматический повторный POST запрещён.

**Обоснование:** без custom correlation field и без полученного Jira key нельзя надёжно доказать отсутствие уже созданной задачи.

**Следствия:**

- тот же Draft/payload блокируется;
- restart/user retry/readiness event не отправляют POST;
- Technical Owner выполняет manual reconciliation;
- найденный issue связывается только при однозначном доказательстве;
- если issue не найден, дальнейшая отправка возможна лишь как отдельное ручное решение по runbook, не как auto retry.

Ранее предусмотренная автоматическая reconciliation с возможным повтором POST считается SUPERSEDED в части автоматического повтора.

### D-009 — Семантика Jira key/number

**Статус:** ACCEPTED
**Решение:** Jira key/number — идентификатор уже известной Jira-задачи.

**Следствия:**

- key хранится после валидного response или подтверждённой manual reconciliation;
- при `UNKNOWN` key пуст;
- нельзя предсказывать sequence, строить ссылку без key или сообщать success.

### D-010 — Production target

**Статус:** ACCEPTED
**Решение:** MVP предназначен для production-контура, а не только test project.

**Следствия:** обязательны least privilege, production-safe smoke, monitoring, backup/restore, secrets management, alerts, runbooks и fail-closed behavior. Тестовые проверки не должны загрязнять production и согласуются отдельно.

### D-011 — Catalog как отдельная versioned задача

**Статус:** ACCEPTED
**Решение:** Knowledge Catalog поставляется отдельно от plugin как versioned артефакт/задача. Владельцем и актуализатором выступает OpenClaw.

**Минимальные свойства:** version, checksum, immutable published snapshot, verification metadata, product/route/options/PO Telegram mapping.

**Следствия:** Draft и duplicate check фиксируют используемую Catalog version. Изменение Catalog до create требует перерасчёта.

### D-012 — Дизайн сбора и обновления Catalog

**Статус:** OPEN
**Решение:** конкретный способ сбора, проверки, публикации, периодической актуализации и rollback Catalog пока не выбран; его нужно спроектировать отдельной задачей.

**До закрытия решения нельзя:**

- заявлять автоматическую Miro/API sync;
- считать model-generated Catalog доверенным без проверки;
- публиковать изменяемую версию без checksum;
- выдумывать owner workflow, cadence или source priorities.

**Дизайн должен определить:**

- authoritative sources;
- правила извлечения/нормализации;
- reviewer/verification gate;
- versioning/checksum/publication;
- update cadence/trigger;
- Jira option validation;
- PO Telegram route lifecycle;
- rollback/deprecation;
- audit и alerts.

### D-013 — PO notification после create

**Статус:** ACCEPTED
**Решение:** после подтверждённого `CREATED` PO получает Telegram notification.

**Следствия:**

- route берётся из доверенной configuration/Catalog mapping;
- notification содержит key/link и минимум контекста;
- notification failure не отменяет созданную Jira-задачу;
- delivery retry отделён от Jira create и не может повторить POST;
- отсутствие/ошибка PO route создаёт operational alert.

### D-014 — Стандартный процесс после create

**Статус:** ACCEPTED
**Решение:** после уведомления PO работает в Jira по стандартному workflow.

**Следствия:** bot не принимает решение за PO, не переводит статус, не выполняет Telegram approval Feature и не изменяет созданную задачу.

### D-015 — Отдельный Docker-контейнер и stable OpenClaw

**Статус:** ACCEPTED
**Решение:** используется отдельный Docker-контейнер OpenClaw на последнем стабильном релизе на момент deployment.

**Следствия:**

- image version/digest фиксируется;
- отдельные workspace/session/plugin data/secrets;
- update проходит preflight/backup/smoke/rollback;
- основной ассистент и его память недоступны публичному агенту.

### D-016 — Telegram route для PO

**Статус:** ACCEPTED
**Решение:** Telegram является принятым каналом notification PO.

**Следствия:** PO route server-side и не задаётся пользователем/моделью. Mapping и lifecycle входят в Catalog design; callback destination подменить нельзя.

### D-017 — Whisper medium

**Статус:** ACCEPTED
**Решение:** Telegram voice messages транскрибируются локальным Whisper `medium`. Ресурсы для модели будут доступны.

**Следствия:**

- deployment preflight проверяет model/runtime/capacity;
- пользователь может исправить transcript;
- STT error не изменяет Jira и не запускает create;
- fallback на меньшую модель без отдельного решения не допускается как скрытое изменение качества.

### D-018 — Jira платформа и фиксированный scope

**Статус:** ACCEPTED
**Решение:** целевая Jira — Server 11.3.8; project FPF id `18100`; issue type Feature id `11500`.

**Следствия:** origin не публикуется в публичных docs; server-side config фиксирует его. Пользователь/модель не выбирают project/type.

### D-019 — Required Jira create fields

**Статус:** ACCEPTED
**Решение:** обязательны:

- `project`;
- `issuetype`;
- `summary`;
- `customfield_16203` Marketing Required;
- `customfield_13200` Category;
- `customfield_15204` Moscow;
- `customfield_14902` Impacted Metrics.

**Следствия:** technical JSON value shapes и allowed options проверяются по production create metadata. Неизвестное required value блокирует READY.

### D-020 — Description бизнес-обязателен

**Статус:** ACCEPTED
**Решение:** `description` обязателен по бизнес-правилу, даже если Jira metadata не маркирует его required.

**Следствия:** пустой/placeholder description блокирует create; formatter использует структурированный Draft и не выдумывает факты.

### D-021 — Assignee и reporter omitted

**Статус:** ACCEPTED
**Решение:** create payload не содержит `assignee` и `reporter`. Assignee должен остаться `unassigned`, reporter определяется credential/default Jira behavior.

**Следствия:** нельзя передавать `null`, PO, Telegram author или service account как явное значение этих полей. Фактическое поведение проверяется contract/E2E test.

### D-022 — Нет workflow transition

**Статус:** ACCEPTED
**Решение:** plugin выполняет только create и оставляет стандартный initial status Jira.

**Следствия:** status/transition не передаются и post-create transition не выполняется.

### D-023 — OpenClaw-only

**Статус:** ACCEPTED
**Решение:** отдельный application backend не создаётся; security-sensitive behavior реализуется custom mixed plugin.

**Следствия:** skill/prompt отвечает за диалоговую методику, но RBAC, DB, Jira client, operation claim, hooks и notifications реализуются кодом plugin.

### D-024 — SQLite driver для Node 24

**Статус:** ACCEPTED
**Решение:** plugin использует встроенный модуль `node:sqlite` из закреплённого Node `24.19.0` и синхронный `DatabaseSync` только внутри коротких локальных транзакций.

**Основание:** фактический runtime предоставляет `DatabaseSync`, prepared statements, bounded `timeout`, backup API и defensive mode. В сравнении с `better-sqlite3`/`sqlite3` встроенный модуль не добавляет npm supply-chain dependency, native addon, postinstall или отдельную ABI/build matrix. Текущий runtime и CI закреплены на Node 24; переход на другую major-версию требует повторной проверки API и durability tests.

**Следствия:**

- SQL выполняется только через migration registry или параметризованные prepared statements;
- длительные network/model/STT операции не выполняются внутри SQLite transaction;
- package/lock не получают новый SQLite dependency;
- container и CI обязаны исполнять ту же Node 24 storage suite.

### D-025 — Канонические persistent enums schema v1

**Статус:** ACCEPTED
**Решение:** schema v1 закрепляет нормативные состояния FR-101—FR-103: Draft начинается с `EDITING`, posting operation — с `PENDING`. Значения `DRAFTING` и `CLAIMED` не являются альтернативными persistent states.

**Следствия:**

- voice review хранится в отдельном transcript/substate профильного этапа, а не меняет Draft enum;
- успешный unique insert операции в `PENDING` является atomic claim; факт начала сети отражается переходом в `POSTING` и `network_started_at`;
- migration contract tests отклоняют `DRAFTING` и `CLAIMED`;
- изменение этих enum после публикации schema v1 требует новой migration и versioned contract review.

## 4. Явно отменённые положения исходного ТЗ

Следующие положения имеют статус **SUPERSEDED**:

1. обязательный полный preview перед Jira create;
2. кнопка «Создать в Jira»;
3. одноразовый confirmation token и callback как trigger POST;
4. доступ Guest к preview/деталям Jira duplicate candidates;
5. автоматический повтор POST после `UNKNOWN` по correlation marker;
6. предположение о наличии custom correlation/idempotency Jira field;
7. Business Admin как обязательный основной получатель каждого success notification вместо PO.

Не отменены: атомарная локальная idempotency, audit, server-side role check, fixed Jira scope, fail closed, duplicate check, DM isolation и стандартный Jira workflow.

## 5. Открытые входы до production go-live

### O-001 — Catalog lifecycle

Закрыть D-012 отдельным согласованным дизайном.

### O-002 — Jira field schemas/options

Получить и зафиксировать production create metadata/value shapes/allowed option IDs для четырёх required custom fields и выбранных route fields.

### O-003 — Jira credential

Подтвердить production service account/credential, минимальные права и rotation runbook без публикации секрета.

### O-004 — Bounded search limits

По нагрузочному тесту зафиксировать максимальные pages/candidates/fields/timeouts и безопасный server-side query template.

### O-005 — PO route lifecycle

В Catalog design определить проверку Telegram destination, изменение PO, fallback/alert и защиту персональных данных. Сам канал Telegram уже принят и не является открытым решением.

### O-006 — Production operations

Согласовать числовые RPO/RTO, availability SLO, maintenance window, backup cadence и incident ownership.

### O-007 — Manual reconciliation runbook

Утвердить полномочия, evidence threshold, audit trail и процедуру отдельного manual decision, если `UNKNOWN` issue не найден. Автоматический POST retry при этом остаётся запрещённым.

## 6. Deferred за пределы MVP

- корпоративный SSO;
- автоматическое продуктовое решение вместо PO;
- Jira workflow transitions/assignee management;
- редактирование существующих Jira issues;
- Miro online sync;
- собственная ML-модель/embedding backend;
- групповые чаты и вложения кроме voice;
- произвольный JQL/HTTP;
- custom Jira correlation field;
- preview/button create;
- отдельный application backend.

## 7. Проверка согласованности документов

При изменении решения следует проверить минимум:

- `BUSINESS_REQUIREMENTS.md` — цели, роли, scope, критерии;
- `FUNCTIONAL_REQUIREMENTS.md` — state machine и сценарии;
- `NON_FUNCTIONAL_REQUIREMENTS.md` — security/reliability/operations;
- `JIRA_CREATE_CONTRACT.md` — preconditions, payload, errors;
- тесты и runbooks, на которые влияет решение.
