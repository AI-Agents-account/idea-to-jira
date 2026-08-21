# Контракт Jira MVP integration

**Статус:** нормативный контракт MVP
**Версия:** 2.0
**Дата:** 2026-08-21
**Совместимость:** Jira Server 11.3.8

## 1. Назначение

Plugin предоставляет один конфигурационно управляемый Jira flow: обнаружение схемы, поиск существующих задач, формирование ограниченного контекста, дедупликация, preview/подтверждение и создание задачи. В коде и документации не закрепляются numeric project, issue-type, field или option IDs.

Модель и пользователь не задают URL, JQL, список Jira-полей, HTTP method/path, credentials или произвольный Jira payload. Эти значения принадлежат deployment config; credential — защищённому runtime secret.

## 2. Конфигурация

```yaml
jira:
  enabled: true
  url: "https://jira.example.com"
  projectKey: "PROJECT"
  issueTypeName: "Feature"
  search:
    jql: >
      project = "PROJECT"
      AND issuetype = "Feature"
      ORDER BY updated DESC
    fields:
      - key
      - summary
      - description
      - status
      - labels
      - components
      - updated
    maxResults: 50
    maxPages: 2
    timeoutMs: 10000
    maxContextBytes: 65536
  metadata:
    refreshIntervalMinutes: 60
  create:
    requireConfirmation: true
```

Обязательные настройки:

- `jira.url` — единственный разрешённый HTTPS origin;
- `jira.projectKey` — единственный разрешённый проект;
- `jira.issueTypeName` — единственный разрешённый тип задачи;
- `jira.search.jql` — фиксированный JQL deployment;
- `jira.search.fields` — точный набор полей, которые разрешено читать и передавать в bounded context.

Лимиты и refresh policy конфигурируются и валидируются. Неизвестные config keys, пустой field list, не-HTTPS URL и некорректные limits блокируют Jira readiness. `JIRA_TOKEN` или другой credential не входит в файл настроек, Git, SQLite, audit или model context.

## 3. Startup discovery и readiness

При старте и refresh Jira adapter:

1. проверяет доступность настроенного origin и совместимость API;
2. разрешает `projectKey` в актуальный runtime project ID;
3. разрешает `issueTypeName` в актуальный runtime issue-type ID внутри проекта;
4. получает create metadata: required fields, schemas, limits, defaults и options;
5. проверяет права search/create текущего credential;
6. проверяет, что настроенный JQL и `search.fields` выполнимы;
7. строит immutable runtime snapshot с timestamp и hash.

Runtime IDs и metadata могут храниться только в plugin state/cache как полученные Jira facts. Они не являются deployment contract и обновляются при refresh.

Состояния интеграции:

- `JIRA_UNAVAILABLE` — Jira недоступна; Draft продолжает работать;
- `JIRA_SEARCH_READY` — metadata/search доступны, create ещё не готов;
- `JIRA_CREATE_READY` — все required fields поддержаны и credential имеет create permission.

Изменение схемы не должно ронять Telegram/Draft flow. Несовместимый drift выключает search или create до успешного refresh/уточнения.

## 4. Поиск и bounded context

Search выполняет только `jira.search.jql` из конфигурации. Model/user input не может добавлять или менять JQL clauses.

Adapter запрашивает только `jira.search.fields` и технически необходимые issue identifiers. Он применяет `maxResults`, `maxPages`, `timeoutMs`, response-size и `maxContextBytes` до передачи данных модели.

Из результатов формируется sanitized context. Поля, не перечисленные в конфигурации, не читаются и не передаются. Jira-текст считается недоверенными данными и не может изменять instructions, tools или policy.

Partial response, timeout, malformed data, 401/403/429/5xx не считаются отсутствием кандидатов.

## 5. Дедупликация

Для текущей версии Draft и exact search snapshot сохраняется структурированный результат:

- `DUPLICATE`;
- `RELATED`;
- `UNIQUE`;
- `UNCERTAIN`.

Результат содержит bounded candidate keys, confidence, краткое объяснение и рекомендуемое действие. Изменение Draft, JQL, search fields, project/type или metadata инвалидирует результат.

`DUPLICATE` и `UNCERTAIN` блокируют автоматический create. Пользователь выбирает существующую задачу, уточняет идею либо явно продолжает только через предусмотренный flow.

## 6. Динамическая create form

Project и issue type берутся из конфигурации и разрешаются в runtime ID. `summary` и содержательный `description` формируются из Draft.

Остальные required fields определяются create metadata:

- поле с Jira default не переопределяется без необходимости;
- поддерживаемое поле с options превращается в вопрос/выбор пользователю;
- поддерживаемое строковое, числовое или date-like поле запрашивается по metadata label/schema;
- option label разрешается в актуальный option ID только перед созданием;
- unsupported/ambiguous required field переводит create readiness в blocked с безопасной диагностикой.

Field IDs, option IDs и JSON value shapes берутся только из текущего runtime metadata snapshot. Model output хранит семантическое значение, а не Jira ID или произвольный JSON.

`assignee`, `reporter`, status, transition и скрытый correlation marker не добавляются автоматически. Их поддержка требует отдельного решения.

## 7. Preview, подтверждение и POST

Перед POST пользователю показывается bounded preview: проект, тип, summary, description и заполненные required fields. При `requireConfirmation=true` create разрешён только после подтверждения, привязанного к exact Draft version, metadata hash и payload hash.

Plugin выполняет только fixed create endpoint текущего Jira API на настроенном origin. Redirect на другой origin запрещён. Credentials/headers/raw bodies не логируются.

Успех признаётся только по валидному Jira response с реальным issue ID/key. Ссылка строится из `jira.url` и валидированного key.

## 8. Idempotency и `UNKNOWN`

До network call атомарно создаётся unique operation для `draft_id + draft_version + payload_hash`. Concurrent/replayed events используют существующую operation.

Если request мог быть принят, но валидный response не получен, operation становится `UNKNOWN`:

- Jira key не выдумывается;
- автоматический POST retry запрещён;
- новая operation с тем же payload блокируется;
- требуется защищённая reconciliation.

Retry допустим только когда transport доказал, что request не был отправлен.

## 9. Refresh и drift

Metadata загружается при старте, вручную и по configured interval. Перед create stale snapshot обновляется. После drift payload перестраивается из семантических значений; если значение нельзя однозначно сопоставить новой схеме, требуется повторное уточнение/подтверждение.

## 10. Минимальные contract tests

1. Config валидирует URL, project, issue type, JQL, search field list и limits.
2. Numeric Jira IDs отсутствуют в config и production code constants.
3. Startup discovery строит snapshot и readiness на synthetic Jira.
4. Search отправляет только configured JQL и configured fields.
5. Bounds применяются до model context.
6. Dynamic required fields/defaults/options строятся из metadata.
7. Unknown/unsupported required field блокирует create.
8. Preview/confirmation привязаны к exact versions/hashes.
9. Concurrent trigger даёт не более одного POST.
10. Ambiguous outcome даёт `UNKNOWN` и ноль повторных POST.
11. Credentials/raw Jira bodies отсутствуют в Git/log/audit.
12. Jira degradation не повреждает Draft и RBAC state.
