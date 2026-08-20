# Функциональные требования: Idea-to-Jira MVP

**Статус:** актуальная базовая версия для MVP
**Версия:** 1.0
**Дата:** 2026-08-20
**Целевой контур:** production

## 1. Назначение и нормативность

Документ описывает наблюдаемое поведение Telegram-бота, OpenClaw plugin и интеграций. При конфликте действует `DECISIONS.md`.

Ключевое правило MVP: **нет Jira preview, confirmation token и кнопки create**. Для Creator создание запускается автоматически после готовности текущей версии Draft и завершения решения по дублям.

Термины Guest, Creator, Business Admin, PO, Technical Owner, Draft, Catalog и posting operation определены в `BUSINESS_REQUIREMENTS.md`.

## 2. Канал и сессии

### FR-001. Выделенный Telegram account

Система должна обслуживать только выделенный Telegram bot account проекта Idea-to-Jira.

### FR-002. Только личные сообщения

Пользовательский сценарий MVP должен работать только в DM. Сообщения из групп, каналов и неподдерживаемых account/channel combinations должны отклоняться до запуска бизнес-логики.

### FR-003. Peer-scoped изоляция

Каждый host-derived Telegram sender ID должен иметь изолированные сессию, Draft и состояние. Получение или изменение данных другого sender ID запрещено.

### FR-004. Trusted requester context

Plugin должен получать sender ID и chat ID из контекста Telegram/OpenClaw host. Значения из текста, model output, callback payload или tool arguments не могут заменять host-derived identity.

### FR-005. Destination lock

Ответы пользователю должны отправляться только в исходный DM. PO/admin notifications могут отправляться только на server-side маршруты из доверенной конфигурации или активной версии Catalog.

## 3. Входные форматы

### FR-010. Текст

Система должна принимать текстовые сообщения с конфигурируемым ограничением длины.

### FR-011. Voice message

Система должна принимать Telegram voice messages и перед обработкой Draft транскрибировать их локальным Whisper `medium`.

### FR-012. Коррекция транскрипта

Пользователь должен увидеть распознанный текст и иметь возможность исправить его. Пока транскрипт содержит неразрешённую ошибку или не подтверждён как рабочий ввод, Draft не должен автоматически перейти к Jira create.

### FR-013. Ошибка STT

При ошибке транскрипции система должна сохранить уже существующий Draft, сообщить безопасную ошибку и предложить текстовый ввод/повтор. Jira create не выполняется.

### FR-014. Неподдерживаемые вложения

Файлы, изображения, видео и иные вложения должны получить понятный отказ без обработки содержимого.

## 4. Draft

### FR-020. Создание Draft

При первой идее система должна создать Draft с уникальным `draft_id`, владельцем sender ID, статусом `EDITING` и версией.

### FR-021. Структура Draft

Draft должен поддерживать как минимум:

- summary;
- контекст и текущее состояние;
- проблему/возможность и цель;
- целевую аудиторию;
- предлагаемое решение и границы;
- критерии приёмки;
- ожидаемые метрики;
- риски, ограничения и зависимости;
- дополнительные сведения/ссылки;
- Marketing Required;
- Category;
- Moscow;
- Impacted Metrics;
- route candidates и выбранный маршрут;
- `catalog_version` и checksum;
- статус полноты, duplicate check и posting operation.

### FR-022. Разделение происхождения данных

Внутри Draft система должна различать:

- факты, сообщённые или подтверждённые пользователем;
- предложения модели;
- неизвестные значения.

Предложение модели не может попасть в Jira как подтверждённый факт без достаточного контекста/подтверждения в диалоге.

### FR-023. Уточняющие вопросы

Модель должна спрашивать только недостающие или неоднозначные сведения, не повторять уже полученные ответы и ограничивать число вопросов в одном сообщении.

### FR-024. Запрет выдумывания

Модель не должна выдумывать baseline, target, сроки, бюджет, юридическое решение, техническую реализацию, Jira options, продукт, команду или PO.

### FR-025. Версионирование

Каждое содержательное изменение Draft должно атомарно увеличивать `version`. Запись должна использовать optimistic concurrency/CAS, чтобы параллельные ответы не перезаписывали друг друга.

### FR-026. Инвалидация зависимых результатов

Изменение поля, влияющего на payload, route или duplicate fingerprint, должно инвалидировать:

- признак READY;
- duplicate check для прежней версии;
- прежний payload hash;
- ещё не начатую posting operation.

Завершённая/`UNKNOWN` posting operation не удаляется и продолжает блокировать повтор для своего payload.

### FR-027. Отсутствие preview

Система не должна формировать отдельную страницу/карточку полного Jira preview и не должна требовать подтверждение preview. Допустимы обычные уточнения и краткие сообщения о том, каких данных не хватает.

### FR-028. Содержательный description

Plugin должен детерминированно собрать description из Draft по разделам:

1. Контекст;
2. Цель / Проблема / Возможность;
3. Целевая аудитория;
4. Что делаем / Предлагаемое решение;
5. Критерии приёмки;
6. Ожидаемые метрики успеха;
7. Риски / ограничения / зависимости;
8. Дополнительные детали и ссылки.

Description является бизнес-обязательным и не может состоять из заглушек.

## 5. Пользователи, заявки и роли

### FR-030. Начальный статус

Новый sender ID должен иметь статус `GUEST`.

### FR-031. Запрос Creator

Guest должен иметь возможность запросить роль Creator. Для одного пользователя допускается не более одной активной заявки `PENDING`; повтор возвращает текущий статус.

### FR-032. Admin card

Business Admin должен получить минимальную карточку:

- numeric sender ID;
- username/display name как недоверенные справочные snapshots;
- дата первой активности;
- краткое непредметное резюме назначения заявки;
- идентификатор Draft без приватного Jira-содержимого;
- детерминированные действия approve/deny/block.

### FR-033. Проверка admin

Admin handler должен сравнить host-derived sender ID с server-side allowlist. LLM в проверке и применении решения не участвует.

### FR-034. Trusted identity by admin decision

При approve admin подтверждает, что считает владельца данного Telegram sender ID идентифицированным и доверенным для роли Creator. Система должна зафиксировать admin ID, user sender ID, время, решение, reason (если задан) и role version.

### FR-035. Атомарное решение

Разрешение, отклонение, отзыв, suspension и block должны быть атомарными. При конкурентных решениях действует первое успешно зафиксированное решение для текущей версии заявки/роли.

### FR-036. Проверка роли в момент create

Активная роль Creator должна повторно проверяться непосредственно перед claim posting operation и перед фактическим POST. Отозванная, suspended или blocked роль запрещает create.

### FR-037. Approval не является approval Feature

Решение admin выдаёт доверенную роль, а не утверждает конкретную идею. Повторный approval каждой задачи отсутствует.

## 6. Knowledge Catalog и маршрутизация

### FR-040. Отдельный артефакт

Catalog должен поставляться как отдельный versioned артефакт/задача, а не редактироваться публичным ботом в пользовательском диалоге.

### FR-041. Владение

OpenClaw является владельцем и актуализатором Catalog. Конкретный процесс сбора, проверки, публикации и обновления должен быть спроектирован отдельно; до его согласования допускается только явно верифицированная версия данных.

### FR-042. Версия и целостность

Каждая опубликованная версия Catalog должна быть неизменяемой, иметь `catalog_version`, checksum, дату публикации и сведения о проверке.

### FR-043. Нормализованная схема

Catalog должен позволять сопоставить как минимум:

- product ID/name/description;
- stream/domain/team/dev teams;
- допустимые Jira option IDs/values;
- PO Jira identity при необходимости;
- доверенный PO Telegram route;
- keywords/examples;
- период активности записи;
- source reference и verification metadata.

### FR-044. Импорт

Plugin должен валидировать структуру и checksum Catalog, отклонять неизвестную/повреждённую версию и импортировать допустимые связи в plugin-owned storage.

### FR-045. Выбор маршрута

Если маршрут однозначен, система может предложить его в диалоге. Если есть несколько допустимых кандидатов, система должна показать 2–3 варианта и получить уточнение. Неизвестная команда не создаётся.

### FR-046. Проверка Jira options

Перед включением route fields в payload все значения должны пройти server-side проверку по разрешённым Jira options. Неподтверждённое значение блокирует READY либо исключается только если поле необязательно и это допускает контракт.

### FR-047. Смена Catalog

Draft должен ссылаться на конкретную версию. Если активная версия изменилась до create, plugin должен пересчитать маршрут и duplicate narrowing для текущей версии Draft; автоматический create до завершения перерасчёта запрещён.

## 7. Поиск дублей

### FR-050. Только Creator видит детали

Jira duplicate details можно запрашивать и показывать только при активной роли Creator. Guest не должен получать key, ссылку, summary, фрагмент description, score или список кандидатов.

### FR-051. Catalog narrowing

До Jira search plugin должен определить допустимую область по активному Catalog: продукт/маршрут/keywords и другие server-side фильтры.

### FR-052. Bounded Jira search

Поиск должен:

- выполняться только на фиксированном Jira origin;
- быть ограничен проектом FPF и разрешёнными issue types/status scope;
- использовать только server-side шаблон JQL/REST-параметров;
- иметь фиксированный верхний предел кандидатов, страниц, полей ответа и timeout;
- не принимать произвольный JQL, URL, project или field list от пользователя/модели.

Точные пределы конфигурируются и тестируются; их изменение не должно расширять модельные полномочия.

### FR-053. Минимальные детали

Creator получает только необходимые для решения данные: Jira key/link, краткий summary, признак/объяснение сходства и при необходимости ограниченный безопасный фрагмент. Полные приватные Jira contents в чат не выгружаются.

### FR-054. Решения

Для текущей версии Draft поддерживаются:

- `DUPLICATE_SELECTED` — выбран известный Jira issue; новый POST запрещён;
- `NOT_DUPLICATE` — Creator явно продолжает;
- `NEEDS_CLARIFICATION` — требуются уточнения, create запрещён;
- `NO_CANDIDATES` — bounded search завершён без кандидатов, отдельное действие не требуется.

### FR-055. Актуальность решения

Результат и решение должны быть связаны с `draft_id`, `draft_version`, catalog version и fingerprint. Изменение значимых данных требует нового поиска.

### FR-056. Ошибка поиска

Если обязательный duplicate search недоступен или завершился неоднозначно, create должен быть fail closed. Нельзя трактовать ошибку как отсутствие дублей.

## 8. Предикат READY

### FR-060. Готовность

Draft получает `READY` только если одновременно:

- есть активный Creator;
- нет незавершённых исправлений voice transcript;
- заполнены summary и содержательный description;
- заполнены четыре обязательных custom fields;
- значения соответствуют Jira create metadata/options;
- маршрут согласован или корректно исключён из payload по контракту;
- Catalog актуален;
- duplicate check актуален;
- результат duplicate check разрешает создание (`NOT_DUPLICATE` или `NO_CANDIDATES`);
- нет нерешённых вопросов и model-only предположений в обязательных полях;
- нет блокирующей posting operation.

### FR-061. Нет READY для выбранного дубля

При `DUPLICATE_SELECTED` Draft должен перейти в состояние, исключающее новый create, и сохранить ссылку только на уже известный Jira issue.

### FR-062. Устойчивость к гонкам

READY должен проверяться внутри той же транзакционной/атомарной процедуры, которая claim-ит posting operation. Проверка только в LLM-сообщении недостаточна.

## 9. Автоматическое создание Jira

### FR-070. Автоматический trigger

После перехода текущей версии Draft в READY plugin должен без отдельной кнопки и preview запустить deterministic create pipeline.

### FR-071. LLM не вызывает POST

У модели не должно быть прямого `jira_create` tool. POST выполняет только plugin handler после server-side проверок.

### FR-072. Posting operation

До сети plugin должен атомарно создать/claim-ить posting operation с:

- UUID operation ID;
- draft ID/version;
- payload hash;
- локальным unique idempotency key;
- состоянием `POSTING`;
- attempt count и timestamps.

### FR-073. Локальная идемпотентность

Один и тот же `draft_id + draft_version + payload_hash` не может создать более одной локальной операции. Конкурентные triggers должны получить существующее состояние, а не отправить второй POST.

### FR-074. Payload whitelist

Payload должен формироваться только по `JIRA_CREATE_CONTRACT.md`. Jira base URL, project, issue type, field IDs и HTTP method задаются server-side.

### FR-075. Подтверждённый успех

Только валидный ответ Jira с issue ID/key либо успешная ручная reconciliation позволяют установить `CREATED`, сохранить key/link и пометить Draft `CREATED`.

### FR-076. Jira key

Jira key/number является идентификатором уже известной задачи. До его получения нельзя формировать предполагаемую ссылку или сообщать, что задача создана.

### FR-077. Поля назначения

`assignee` и `reporter` должны быть полностью omitted из create payload. Plugin не выполняет transition; Jira применяет стандартный initial workflow.

### FR-078. Успешный ответ пользователю

Creator должен получить Jira key и ссылку. Ответ не должен содержать credentials, raw response или внутренние технические данные.

## 10. Ошибки и reconciliation

### FR-080. Validation 4xx

Валидный Jira validation error переводит operation в `FAILED_FINAL`. Пользователь получает санитаризированное объяснение; исправление Draft создаёт новую версию, но повтор допустим только после устранения конкретной ошибки и новой полной проверки.

### FR-081. Authentication/authorization

При 401/403 create блокируется, Technical Owner уведомляется. Пользователь не может инициировать retry.

### FR-082. Rate limit/5xx до подтверждённой отправки

Retry допустим только для ошибок, где реализация может доказать, что request не был принят Jira. Retry ограничен, учитывает `Retry-After` и использует backoff.

### FR-083. Неоднозначный timeout

Если POST был отправлен и результат неизвестен:

- operation → `UNKNOWN`;
- Jira key/id остаются пустыми;
- auto retry POST запрещён;
- любые автоматические новые операции для того же Draft/payload блокируются;
- Creator получает сообщение «результат неизвестен, требуется ручная проверка» без предполагаемого key;
- Technical Owner получает операционное уведомление.

### FR-084. Нет custom correlation field

Система не должна рассчитывать на создание или использование custom Jira correlation field. Локальные operation ID и payload hash служат audit/локальной дедупликации, но не доказывают наличие задачи в Jira.

### FR-085. Manual reconciliation

Technical Owner должен иметь защищённую детерминированную процедуру ручной reconciliation:

- проверить operation, время и payload hash;
- ограниченно найти возможную задачу по доступным production-признакам;
- при однозначном совпадении сохранить реальный Jira ID/key и завершить как `CREATED`;
- при отсутствии доказательства оставить create заблокированным до явного ручного решения;
- никогда не запускать автоматический повторный POST из `UNKNOWN`.

Все действия reconciliation аудируются.

### FR-086. Restart recovery

При старте plugin должен обнаруживать операции `POSTING`, для которых нет подтверждённого ответа. Если факт неотправки нельзя доказать, они переводятся в `UNKNOWN`, а не повторяются.

## 11. Уведомления

### FR-090. Creator

После подтверждённого create Creator получает key/link. При `UNKNOWN` получает только статус неопределённости и информацию о ручной проверке.

### FR-091. PO Telegram route

После `CREATED` plugin должен определить PO по зафиксированной версии Catalog и отправить Telegram-уведомление на доверенный server-side route.

### FR-092. Содержание PO notification

Уведомление PO должно содержать минимум:

- факт создания новой Feature;
- Jira key/link;
- краткий summary;
- идентификатор/отображаемое имя автора только в разрешённом объёме;
- указание продолжить стандартный процесс в Jira.

### FR-093. Идемпотентность уведомления

Каждый тип уведомления должен иметь delivery state. Retry доставки не должен отправлять Jira POST повторно. Повтор notification ограничен и не создаёт новую Feature.

### FR-094. Нет PO route

Если Feature создана, но PO route отсутствует/невалиден, Jira operation остаётся `CREATED`; фиксируется notification failure и уведомляется Business Admin/Technical Owner. Отсутствие маршрута не отменяет созданную задачу.

### FR-095. Admin notifications

Business Admin получает заявки на доступ и операционные ошибки в пределах своей роли. Успешный create адресуется прежде всего Creator и PO; дополнительная admin notification может быть конфигурационной, но не заменяет PO notification.

## 12. Данные и состояния

### FR-100. Минимальные сущности

Plugin-owned storage должен содержать:

- `users`;
- `access_requests`;
- `role_grants`;
- `drafts`;
- `catalog_versions` и нормализованные route entries;
- `duplicate_checks`;
- `posting_operations`;
- `notifications`;
- append-only `audit_log`.

Confirmation entity для кнопки create в MVP не требуется.

### FR-101. User states

```text
GUEST → PENDING → CREATOR
           ├──→ GUEST (DENIED)
           └──→ BLOCKED
CREATOR → SUSPENDED → CREATOR
CREATOR/SUSPENDED → BLOCKED
```

### FR-102. Draft states

```text
EDITING → READY → POSTING → CREATED
   ↑        │        ├──→ EDITING (подтверждённая исправимая ошибка)
   │        │        ├──→ FAILED_FINAL
   │        │        └──→ UNKNOWN (блокировка до manual reconciliation)
   │        └──→ DUPLICATE_LINKED
   └──────────── изменения версии
EDITING/READY → CANCELLED
```

### FR-103. Posting states

```text
PENDING → POSTING → CREATED
                  ├──→ FAILED_RETRYABLE (только доказанно безопасный retry)
                  ├──→ FAILED_FINAL
                  └──→ UNKNOWN → CREATED | MANUAL_RESOLUTION_REQUIRED
```

Переход `UNKNOWN → auto retry POST` запрещён.

### FR-104. Audit events

Должны аудироваться как минимум:

- user/access/role decisions;
- Draft create/version/status transitions;
- Catalog version selection/change;
- duplicate search fingerprint/result/decision без полных Jira contents;
- operation claim/state/result;
- manual reconciliation;
- PO/Creator/admin notification status;
- security/rate-limit rejects.

## 13. Tool и hook boundary

### FR-110. Разрешённые model tools

Модели могут быть доступны только typed tools, необходимые для:

- чтения собственного Draft;
- patch собственного Draft;
- запроса роли Creator;
- получения route suggestions;
- запуска bounded duplicate analysis для Creator через server-side wrapper.

Точный allowlist фиксируется plugin manifest и тестами.

### FR-111. Запрещённые tools

Публичному агенту запрещены:

- direct Jira create;
- exec/browser/filesystem;
- generic HTTP/web;
- Gateway/config management;
- произвольный message tool;
- доступ к основному workspace/memory/session store.

### FR-112. Обязательные checks

До model run/tool call/dispatch plugin должен выполнять channel/account/sender/RBAC/rate-limit/destination checks. После вызова — sanitized audit.

## 14. Функциональные критерии приёмки

### FAC-01

Новый Guest создаёт и редактирует только свой Draft в Telegram DM.

### FAC-02

Voice message транскрибируется Whisper `medium`; исправление меняет версию Draft.

### FAC-03

Guest не получает детали duplicate candidates и не может достичь Jira POST.

### FAC-04

Только allowlisted Business Admin может выдать Creator по trusted sender ID; concurrent/replay decision не ломает состояние.

### FAC-05

Для Creator bounded search использует catalog narrowing и фиксированный Jira scope.

### FAC-06

Выбор дубля запрещает новый create; `NOT_DUPLICATE` или отсутствие кандидатов разрешает продолжение.

### FAC-07

Когда обязательные поля заполнены и проверки завершены, система без preview/кнопки создаёт ровно одну Feature.

### FAC-08

Payload содержит обязательные поля, но не содержит assignee/reporter/custom correlation field.

### FAC-09

Concurrent readiness triggers приводят к одному POST.

### FAC-10

Timeout после возможной отправки переводит operation в `UNKNOWN`; рестарт и действия пользователя не вызывают автоматический повторный POST.

### FAC-11

После успеха Creator и PO получают уведомления; notification retry не повторяет Jira create.

### FAC-12

Plugin restart восстанавливает согласованное состояние без небезопасного повторного POST.
