# Контракт создания Jira Feature: Idea-to-Jira MVP

**Статус:** нормативный контракт MVP
**Версия:** 1.0
**Дата:** 2026-08-20
**Совместимость:** Jira Server 11.3.8
**Целевой контур:** production

## 1. Назначение

Документ задаёт server-side контракт единственной разрешённой операции записи MVP: создание Feature в фиксированном Jira project. Он не публикует Jira origin, credentials, allowed option contents или данные существующих задач.

Любое поле, не разрешённое этим контрактом и активной версией mapper, должно быть отклонено. Модель и пользователь не формируют HTTP request напрямую.

## 2. Подтверждённая Jira evidence

| Параметр | Подтверждённое значение |
|---|---|
| Jira product/version | Jira Server 11.3.8 |
| Project | `FPF`, id `18100` |
| Issue type | `Feature`, id `11500` |
| Required on create | `project`, `issuetype`, `summary`, `customfield_16203`, `customfield_13200`, `customfield_15204`, `customfield_14902` |
| Business-required | содержательный `description` |
| Assignee | omitted; ожидается `unassigned` |
| Reporter | omitted; определяется Jira credential/default behavior |
| Workflow transition | отсутствует; применяется стандартный initial status |
| Custom correlation field | создать/использовать нельзя |

Create metadata и allowed options production Jira являются runtime-источником истины для технической формы и допустимых значений custom fields.

## 3. Предусловия POST

Plugin может выполнить POST только если атомарно доказаны все условия:

1. запрос пришёл из выделенного Telegram account/DM;
2. host-derived sender ID присутствует и совпадает с владельцем Draft;
3. у пользователя активна роль Creator;
4. Draft имеет текущую неизменившуюся версию;
5. обязательные поля заполнены и валидны;
6. description содержателен;
7. Catalog version/checksum валидны;
8. duplicate check актуален для Draft/version/catalog/fingerprint;
9. результат duplicate check — `NOT_DUPLICATE` либо `NO_CANDIDATES`;
10. значения custom/route fields существуют в разрешённых Jira options;
11. server-side payload прошёл whitelist validation;
12. отсутствует существующая `CREATED`, `POSTING` или `UNKNOWN` operation для того же `draft_id + draft_version + payload_hash`;
13. posting operation успешно claim-нута до network call.

Preview, confirmation token и кнопка create не являются предусловиями и в MVP отсутствуют.

## 4. HTTP boundary

### 4.1. Разрешённая операция

- Метод: `POST`.
- Endpoint: фиксированный server-side endpoint создания issue для настроенного production Jira origin (для Jira Server обычно `/rest/api/2/issue`; фактический path проверяется compatibility test).
- Origin, TLS policy, project и issue type задаются конфигурацией deployment, недоступной модели и пользователю.
- Redirect на другой origin запрещён.

### 4.2. Authentication

Credential читается только из SecretRef/защищённого окружения и никогда не включается в Draft, SQLite business data, audit metadata, prompt, Telegram или документацию.

### 4.3. Content type и encoding

Request должен использовать поддерживаемый Jira JSON content type и UTF-8. Технические headers определяются Jira client; raw headers не логируются.

### 4.4. Timeout

Connect/read/overall timeouts обязательны и конфигурируемы. Ошибка классифицируется как «доказанно до отправки» или «результат неоднозначен». Если доказать первое нельзя, применяется `UNKNOWN`.

## 5. Нормативная структура payload

Ниже приведён **схематический, неисполняемый** пример. Placeholder нельзя отправлять в Jira.

```json
{
  "fields": {
    "project": { "id": "18100" },
    "issuetype": { "id": "11500" },
    "summary": "<непустой подтверждённый заголовок>",
    "description": "<содержательное описание по шаблону>",
    "customfield_16203": "<валидное значение Marketing Required>",
    "customfield_13200": "<валидное значение Category>",
    "customfield_15204": "<валидное значение Moscow>",
    "customfield_14902": "<валидное значение Impacted Metrics>"
  }
}
```

Фактическая JSON-форма custom field value (scalar, option object, array и т. п.) определяется production create metadata/schema и покрывается contract tests. Mapper не должен угадывать форму по GET существующих issues.

## 6. Обязательные поля

### JC-001. `project`

- Всегда server-side value `{id: "18100"}` либо эквивалентная подтверждённая Jira Server форма.
- Project key `FPF` используется для проверки и ограниченного поиска, но пользователь не выбирает project.
- Любое иное значение запрещено.

### JC-002. `issuetype`

- Всегда server-side value `{id: "11500"}`.
- Тип — Feature.
- Любое иное значение запрещено.

### JC-003. `summary`

- Непустая строка после нормализации whitespace.
- Основана на содержании Draft и не содержит технических correlation markers.
- Ограничение длины берётся из Jira metadata/config; до проверки превышение блокирует create.
- Заглушки вроде `-`, `TBD`, `Не определено` как единственное содержимое запрещены.

### JC-004. `description`

Description бизнес-обязателен независимо от того, помечает ли Jira его required в metadata.

Шаблон:

```text
Контекст
[подтверждённые наблюдения]

Цель / Проблема / Возможность
[что требуется изменить и зачем]

Целевая аудитория
[кто сталкивается с проблемой]

Что делаем / Предлагаемое решение
[границы решения без выдуманных деталей]

Критерии приёмки
1. [наблюдаемый результат]

Ожидаемые метрики успеха
- [известные и подтверждённые показатели]

Риски / ограничения / зависимости
- [известные сведения]

Дополнительные детали и ссылки
- [если есть]
```

Правила:

- не превращать model assumption в факт;
- не выдумывать baseline/target/срок/бюджет;
- пустые необязательные разделы можно опустить или явно описать нейтрально только по согласованному formatter rule;
- description не содержит secret, local operation ID, payload hash или скрытый correlation marker;
- полное содержимое description не логируется.

### JC-005. `customfield_16203` — Marketing Required

- Обязателен на create.
- Значение должно быть получено из контекста/ответа пользователя и сопоставлено с allowed option production Jira.
- При неоднозначности бот задаёт вопрос.
- Default допустим только после отдельного зафиксированного решения и contract test; в текущей версии default не задан.

### JC-006. `customfield_13200` — Category

- Обязателен на create.
- Значение выбирается только из production allowed options.
- Catalog/модель могут предложить, но server-side mapper проверяет option.
- Неизвестное значение блокирует create.

### JC-007. `customfield_15204` — Moscow

- Обязателен на create.
- Семантика и JSON value shape берутся из production metadata/field documentation.
- До получения валидного значения create запрещён.
- Модель не интерпретирует название поля самостоятельно.

### JC-008. `customfield_14902` — Impacted Metrics

- Обязателен на create.
- Содержит только известные/подтверждённые метрики или допустимое production option value в форме, заданной metadata.
- Выдуманные метрики, baseline и target запрещены.
- Пустое/невалидное значение блокирует create.

## 7. Необязательные разрешённые поля

Необязательное поле включается только если одновременно:

- оно присутствует в versioned mapper allowlist;
- Jira create metadata разрешает его сервисному credential;
- value валидирован по options/schema;
- значение подтверждено пользователем либо однозначно выведено из верифицированного Catalog по согласованному rule;
- contract test существует.

Кандидаты MVP:

| Поле | ID | Правило |
|---|---|---|
| Stream | `customfield_13801` | только из активного Catalog и Jira options |
| Domain | `customfield_16404` | только из активного Catalog и Jira options |
| Team Fintech | `customfield_17501` | только из активного Catalog и Jira options |
| Cluster Fintech | `customfield_17502` | только из активного Catalog и Jira options |
| Domain Fintech | `customfield_17503` | только из активного Catalog и Jira options |
| Dev Teams | `customfield_15201` | только из активного Catalog и Jira options |
| Short Business Description | `customfield_14903` | содержательное краткое резюме без выдумывания |
| Priority | `priority` | только подтверждённое allowed value |
| Labels | `labels` | только явные согласованные значения; не угадывать |
| Product OKR | `customfield_16502` | только подтверждённый выбор |
| Unit Economics Required | `customfield_16105` | только после валидированного rule/ответа |
| Manual Tests Required | `customfield_11823` | только после metadata и решения |
| Classification | `customfield_15200` | только после metadata и решения |

`routing.writeToJira=false` должен исключать route fields из payload, не меняя обязательные поля и duplicate logic.

Наличие поля в таблице не разрешает его автоматически: активный mapper version является окончательным allowlist.

## 8. Поля и параметры, которые должны отсутствовать

### JC-020. `assignee`

Поле полностью omitted. Нельзя передавать `null`, Telegram identity, PO или service account. Ожидаемый результат — `unassigned` согласно стандартному Jira behavior.

### JC-021. `reporter`

Поле полностью omitted. Reporter определяется Jira credential/default create behavior. Telegram author не подменяется Jira reporter.

### JC-022. Workflow

Payload/последующие вызовы не содержат status или transition. Plugin не выполняет transition после create.

### JC-023. Correlation marker

Запрещены:

- custom correlation field;
- скрытый operation ID/payload hash в description/summary/labels;
- предположение, что локальный idempotency key поддерживается Jira.

### JC-024. Model/user controlled transport

Запрещено принимать от модели/пользователя:

- base URL/origin;
- HTTP method/path;
- project/issue type;
- field ID;
- JQL;
- credentials/headers;
- assignee/reporter ID;
- transition ID;
- callback/notification destination.

### JC-025. Неизвестные поля

Все неизвестные или неразрешённые keys должны приводить к отказу mapper, а не молча передаваться Jira.

## 9. Metadata/options preflight

До enable create в production plugin должен получить/проверить create metadata для project id `18100` и issue type id `11500` с фактическим credential.

Проверяется:

1. Jira Server version/API compatibility;
2. присутствие всех required fields;
3. JSON schema/value shape;
4. allowed options и их стабильные IDs;
5. ограничения summary/description;
6. доступность необязательных route fields;
7. отсутствие требования assignee/reporter;
8. право create для credential;
9. стандартный initial status без transition.

Snapshot metadata/options должен иметь timestamp/hash/version и храниться без приватных issue contents. Если production metadata изменились относительно протестированного snapshot, create выключается до повторной проверки mapper.

GET существующих issues не является доказательством create schema.

## 10. Payload generation и hash

### JC-030. Canonical payload

До hash plugin должен:

- построить payload только из server-side mapping;
- удалить omitted fields;
- нормализовать строки по документированным правилам;
- стабильно упорядочить object keys и, где семантика допускает, arrays;
- сериализовать canonical JSON.

### JC-031. Payload hash

Hash canonical payload хранится локально вместе с Draft/version/operation. Он используется для локальной дедупликации и аудита, но:

- не отправляется как Jira custom field;
- не является Jira issue identity;
- не позволяет автоматически решить `UNKNOWN`.

### JC-032. Operation claim

До network call создаётся unique operation по `draft_id + draft_version + payload_hash`. Повторный trigger возвращает существующую operation и не отправляет POST.

## 11. Успешный ответ

### JC-040. Минимальный success response

Успех признаётся только если HTTP/API response соответствует ожидаемой Jira create schema и содержит валидный реальный issue ID/key. Конкретные поля response валидируются client schema.

### JC-041. Jira identity

После успеха сохраняются:

- Jira issue ID, если возвращён;
- Jira issue key;
- ссылка, собранная из доверенного server-side origin и валидного key;
- response timestamp;
- operation state `CREATED`.

Jira key/number обозначает уже известную задачу. Key нельзя предсказывать или строить из project sequence локально.

### JC-042. Postcondition check

При возможности client выполняет bounded read-after-create по полученному ID/key для проверки project/type и критичных полей. Ошибка такой проверки не запускает второй create; состояние и alert обрабатываются отдельно.

### JC-043. Notifications

Только после `CREATED`:

- Creator получает key/link;
- PO получает Telegram notification по доверенному Catalog route;
- стандартный Jira workflow продолжается без plugin transition.

Notification delivery имеет отдельное состояние и не влияет на идемпотентность POST.

## 12. Ошибки

| Класс | Состояние | Поведение |
|---|---|---|
| Local validation/metadata | POST не выполнялся | Draft остаётся `EDITING`; запросить/исправить данные |
| Jira validation 4xx | `FAILED_FINAL` | санитаризированная ошибка; исправление создаёт новую Draft version |
| Jira 401/403 | `FAILED_FINAL`/operational block | запрет user retry; alert Technical Owner |
| Jira 429/5xx с доказанно не принятой попыткой | `FAILED_RETRYABLE` | bounded retry с backoff/Retry-After |
| Timeout/connection loss после возможной отправки | `UNKNOWN` | fail closed, manual reconciliation, без auto POST retry |
| Malformed/неполный success response | `UNKNOWN` | key не выдумывать, manual reconciliation |
| SQLite/claim failure | POST запрещён | bounded local retry, не обходить transaction |

Raw Jira body не отправляется пользователю и не логируется целиком.

## 13. UNKNOWN и ручная reconciliation

### JC-050. Инвариант

Если неизвестно, была ли создана задача, и нет достоверного Jira key/id, система **не выполняет автоматический повторный POST**.

### JC-051. Почему локальный key недостаточен

Custom correlation field создать нельзя. Локальные operation ID, timestamps и payload hash не гарантируют, что найденная Jira-задача относится к этой попытке, и не делают Jira POST идемпотентным.

### JC-052. Блокировка

`UNKNOWN` блокирует:

- повторный trigger текущего Draft/version/payload;
- автоматическое создание новой operation с тем же содержимым;
- сообщение об успешном create;
- генерацию предполагаемого Jira key/link.

### JC-053. Manual procedure

Защищённая ручная процедура должна:

1. прочитать operation и санитаризированные request metadata;
2. выполнить ограниченный поиск по времени, project/type и доступным бизнес-признакам;
3. проверить кандидата с учётом риска совпадения;
4. только при однозначном доказательстве записать реальный key/id и `CREATED`;
5. при отсутствии доказательства сохранить блокировку и оформить явное manual resolution;
6. аудировать actor, evidence reference, решение и время;
7. не выполнять автоматический POST.

Если после ручного анализа разрешена новая отправка, это отдельное административное решение и новая контролируемая операция; оно не является retry из `UNKNOWN` и должно иметь отдельный runbook/approval trail.

## 14. Контракт duplicate search

Duplicate search не является write, но обязателен перед create:

- Catalog сужает product/route/search terms;
- Jira request использует фиксированный server-side query template;
- project ограничен FPF;
- количество страниц, candidates, fields и timeout ограничено;
- подробности возвращаются только Creator;
- `DUPLICATE_SELECTED` запрещает POST;
- `NOT_DUPLICATE` или `NO_CANDIDATES` разрешает оценить READY;
- search error не трактуется как `NO_CANDIDATES`.

Произвольный JQL от модели/пользователя запрещён.

## 15. Contract tests

До production enable обязательны тесты:

1. exact project/type mapping;
2. все восемь обязательных элементов: project, issuetype, summary, description и четыре custom fields;
3. JSON shape каждого custom field по metadata;
4. allowed/invalid options;
5. omitted assignee/reporter;
6. отсутствие correlation marker;
7. unknown field reject;
8. payload canonicalization/hash stability;
9. concurrent trigger → один POST;
10. stale Draft/Catalog/duplicate check → ноль POST;
11. Guest/revoked role → ноль POST;
12. 400/401/403/429/5xx behavior;
13. timeout после возможной отправки → `UNKNOWN`, ноль последующих auto POST;
14. malformed success response → key не выдумывается;
15. valid response → реальный key/link и PO notification;
16. notification retry → ноль дополнительных Jira POST;
17. restart `POSTING` recovery → no blind retry;
18. create metadata change → create disabled до revalidation.

## 16. Открытые технические входы

До реализации mapper должны быть зафиксированы без публикации приватных option contents:

- точная REST path/auth scheme для production deployment;
- JSON schema/value shape и allowed option IDs для четырёх required custom fields;
- ограничения длины/формата summary и description;
- набор активных optional route fields;
- стандартный initial status и фактический unassigned result;
- service account/credential и его permission scope;
- bounded search limits и безопасные поля ответа.
