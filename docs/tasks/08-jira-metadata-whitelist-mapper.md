# 08. Полная Jira MVP integration

## Цель

Реализовать configuration-driven vertical flow без hardcoded Jira IDs:

```text
startup discovery
→ configured JQL search
→ bounded issue context
→ structured deduplication
→ dynamic required fields
→ preview/confirmation
→ idempotent Jira create
→ Jira key/link
```

Stage-05A отдельно не принимается: Telegram/Draft/Jira E2E выполняется после завершения полного flow.

## Зависимости

Реализованные Stages 01–05 и controlled text-pilot foundation. Jira credential предоставляется только как runtime secret. При его отсутствии весь contract реализуется на fake Jira, а live evidence остаётся deployment blocker.

## Configuration contract

Добавить валидируемые настройки:

- `jira.enabled`;
- `jira.url`;
- `jira.projectKey`;
- `jira.issueTypeName`;
- `jira.search.jql`;
- `jira.search.fields`;
- `jira.search.maxResults/maxPages/timeoutMs/maxContextBytes`;
- `jira.metadata.refreshIntervalMinutes`;
- `jira.create.requireConfirmation`.

`jira.search.fields` — единственный разрешённый набор полей существующих задач. Model/user input не может изменить URL, project/type, JQL или fields. Credential не входит в config file.

## Scope

### 1. Jira connector и startup discovery

- fixed configured HTTPS origin;
- token-authenticated REST client;
- bounded timeouts/response sizes, redirect off;
- resolve project key и issue-type name в runtime IDs;
- retrieve create metadata, required fields, schemas, defaults/options и permissions;
- immutable runtime metadata snapshot с hash/timestamp;
- readiness `JIRA_UNAVAILABLE/JIRA_SEARCH_READY/JIRA_CREATE_READY`;
- startup, manual и interval refresh;
- Jira failure не повреждает Draft/RBAC и не роняет основной flow.

### 2. Configured JQL search

- выполнять exact configured JQL;
- запрашивать только configured `search.fields` и необходимые identifiers;
- применять bounds до model context;
- pagination, rate limit и read circuit breaker;
- partial/error result не равен «кандидатов нет»;
- Jira text считать недоверенным content.

### 3. Context и дедупликация

- sanitized bounded candidate context;
- structured result `DUPLICATE/RELATED/UNIQUE/UNCERTAIN`;
- candidate keys, confidence, reason и recommended action;
- привязка к exact Draft version, JQL/search-fields config version и metadata hash;
- изменение входов инвалидирует решение;
- Guest не получает Jira details;
- `DUPLICATE/UNCERTAIN` не запускают create без пользовательского решения.

### 4. Dynamic create form

- project/type runtime IDs только из startup metadata;
- summary/description из текущего Draft;
- required Jira fields обнаруживаются динамически;
- Jira default не переопределяется;
- supported option/text/number/date fields превращаются в typed questions;
- semantic answers разрешаются в field/option IDs только server-side;
- unknown/unsupported/ambiguous required field блокирует create;
- arbitrary model JSON запрещён.

### 5. Preview и confirmation

- bounded preview проекта, типа, summary, description и заполненных required fields;
- confirmation привязано к actor/chat/Draft version/metadata hash/payload hash;
- изменение данных делает confirmation stale;
- default `requireConfirmation=true`.

### 6. Create, idempotency и UNKNOWN

- server-side canonical payload;
- atomic unique operation для `draft_id + draft_version + payload_hash`;
- один fixed Jira create POST;
- concurrent/replayed triggers дают не более одного network call;
- успех только по валидному Jira ID/key;
- ambiguous/malformed response → `UNKNOWN`, без автоматического POST retry;
- protected manual reconciliation;
- Jira link только из configured URL + validated key.

## Вне scope

- несколько Jira origins/projects/issue types в одном deployment;
- user/model-generated JQL или fields;
- generic Jira HTTP tool;
- Jira update/comment/transition;
- автоматическое управление assignee/reporter;
- embeddings/vector DB;
- voice, PO notifications и production go-live operations;
- hardcoded project/issue/field/option IDs.

## Компоненты

- config schema/parser/startup validation;
- `src/jira/http-client.ts`;
- `src/jira/metadata-client.ts` и snapshot service;
- `src/jira/search-client.ts` и bounded-context builder;
- `src/duplicates/*`;
- dynamic-field form/answer repository;
- preview/confirmation service;
- payload mapper/canonical JSON;
- posting operation/idempotency/error classifier;
- fake Jira integration fixtures;
- migrations/repositories, если нужны новые durable states.

## Tests

1. Config принимает Jira URL, project key, issue-type name, JQL и field list; rejects unsafe/empty/unknown values.
2. В production code/config нет numeric Jira project/type/custom-field constants.
3. Startup discovery разрешает runtime IDs и строит readiness.
4. Search request содержит exact configured JQL/fields и limits.
5. Extra fields не читаются и не попадают в context.
6. Bounded context устойчив к oversized/malicious Jira content.
7. Dedup transitions/version invalidation работают детерминированно.
8. Required fields/defaults/options строятся из metadata.
9. Unsupported required field блокирует create и не делает POST.
10. Preview/confirmation anti-replay и CAS.
11. Concurrent/repeated event → one operation/one POST.
12. Timeout may-have-sent/malformed success → UNKNOWN/no retry/no invented key.
13. 401/403/429/5xx/timeout/redirect/malformed/oversize matrix.
14. Credential/raw Jira bodies отсутствуют в Git/log/audit/SQLite business data.
15. Regression suite Stages 01–05 остаётся зелёной.

## Acceptance criteria

- Deployment меняет Jira URL/project/type/JQL/search fields без изменения кода.
- После restart integration заново получает актуальные Jira IDs/metadata.
- Идея сравнивается только с bounded configured Jira context.
- Пользователь получает понятное решение по дубликатам.
- Любое required поле заполняется generic metadata-driven flow либо безопасно блокирует create.
- Подтверждённая уникальная идея создаёт ровно одну Jira issue и возвращает реальный key/link.
- Jira degradation оставляет Draft доступным.
- Никаких hardcoded Jira IDs или model-controlled transport/payload.

## Delivery

Рекомендуется одна feature-ветка с последовательными reviewable commits либо PR stack:

1. config + connector + discovery;
2. search + bounded context + dedup;
3. dynamic fields + preview/confirmation;
4. create + idempotency/UNKNOWN + integrated tests.

До отдельного explicit approval live Jira POST проверяется только fake transport. Read-only live probe допускается при наличии защищённого credential и без сохранения private issue contents.
