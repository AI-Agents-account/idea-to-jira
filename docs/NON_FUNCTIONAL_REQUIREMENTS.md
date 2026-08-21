# Нефункциональные требования: Idea-to-Jira MVP

> Обновление 2026-08-21: fixed numeric Jira IDs заменены configuration-driven URL/project/type/JQL/search fields и startup/refresh metadata discovery. Security, bounds, idempotency и UNKNOWN invariants сохраняются.


**Статус:** актуальная базовая версия для MVP
**Версия:** 1.0
**Дата:** 2026-08-20
**Целевой контур:** production

## 1. Назначение

Документ устанавливает требования к безопасности, надёжности, производительности, эксплуатации, хранению данных, наблюдаемости и качеству Idea-to-Jira MVP.

Уровни с пометкой «предварительный SLO» должны быть подтверждены нагрузочным и production-smoke тестированием, но являются целевыми для реализации.

## 2. Архитектурная изоляция

### NFR-001. Отдельный контейнер

MVP должен работать в отдельном Docker-контейнере, не разделяющем runtime state, workspace, sessions, plugin database и secrets с основным OpenClaw-ассистентом.

### NFR-002. Последний стабильный OpenClaw

На момент каждого production deployment должен использоваться последний стабильный релиз OpenClaw. Конкретные version/tag и image digest должны фиксироваться в release record; плавающий непроверяемый образ не считается достаточным.

### NFR-003. Контролируемое обновление

Обновление OpenClaw/plugin должно проходить backup, migration preflight, compatibility checks, smoke test и иметь проверенный rollback для приложения и данных.

### NFR-004. OpenClaw-only application

Бизнес-логика реализуется custom mixed plugin внутри выделенного OpenClaw без отдельного прикладного backend. Jira client, RBAC, state machine и SQLite являются server-side границей безопасности; prompt/skill ею не являются.

### NFR-005. Production target

Конфигурация, права, мониторинг, backup и runbook должны быть рассчитаны на production Jira. Тестовые заглушки и dev credentials не должны попадать в production deployment.

## 3. Безопасность

### NFR-010. Least privilege

Публичному агенту доступен точный allowlist typed plugin tools. `exec`, browser, filesystem, generic HTTP/web, Gateway/config, arbitrary message и direct Jira create недоступны.

### NFR-011. Identity

Единственный технический идентификатор пользователя — host-derived Telegram sender ID из доверенного server-side requester context. Значения sender ID из текста, model output, callback payload и client-supplied fields не могут подменить его. Username/display name являются недоверенными snapshots. Бизнес-доверие к identity для Creator возникает только после admin decision.

### NFR-012. Fail closed

При отсутствующем/неоднозначном sender ID, роли, Catalog, Jira metadata, обязательном поле, duplicate result или network outcome система должна запрещать create.

### NFR-013. Secrets

Telegram bot token, Jira credential и model/OAuth credentials:

- хранятся только в OpenClaw SecretRef или защищённом окружении;
- не записываются в Git, docs, plugin SQLite, Draft, audit, prompt или Telegram;
- не передаются модели;
- не попадают в headers/body diagnostics и error messages;
- для OAuth-backed auth profiles хранятся в OpenClaw state, а локальный encryption key — в отдельном persistent `OPENCLAW_AUTH_PROFILE_SECRET_DIR`; оба mount используются Gateway и CLI, резервируются согласованно и не публикуются в Git.

### NFR-014. Credential isolation

Jira credential должен иметь минимальные необходимые production-права: чтение ограниченного scope для duplicate search и create в FPF. Service account предпочтителен и обязателен до расширения пилота; временный credential требует зафиксированной ротации.

### NFR-015. Network egress

Контейнер должен иметь egress только к необходимым Telegram/OpenAI/Jira endpoints и разрешённым инфраструктурным сервисам. Пользователь и модель не могут менять destination.

### NFR-016. Prompt injection resistance

Весь пользовательский, Catalog и Jira-текст считается недоверенным. Он не может менять system policy, tool allowlist, role, Jira origin/project/type/fields, notification destination или запускать команды/URL.

### NFR-017. Payload whitelist

Jira payload строится из server-side allowlist. Неизвестные field IDs, произвольные значения и arbitrary JSON от модели или пользователя отклоняются и никогда не пересылаются в Jira напрямую.

### NFR-018. Admin boundary

Admin callbacks/commands обрабатываются детерминированно и проверяют sender ID по server-side allowlist. Admin роль не даёт host/OpenClaw owner access.

### NFR-019. Callback/replay

Любые Telegram callbacks должны быть связаны с actor/chat/action state и защищены от replay. При этом callback create в MVP отсутствует.

### NFR-020. Storage permissions

Каталог plugin state должен иметь права не шире `0700`, SQLite и backup files — не шире `0600`, с учётом возможностей container volume/runtime user.

### NFR-021. Dependency security

Container image и plugin dependencies должны проходить SBOM/dependency scan, pinning и проверку известных критических уязвимостей перед release.

### NFR-022. Security headers/data redaction

Логи не должны содержать authorization headers, cookies, raw Telegram updates, полные Jira response bodies, voice payloads или полные описания идей.

### NFR-023. Приватное сообщение об уязвимости

Сведения об уязвимостях должны передаваться Technical Owner или владельцу репозитория по утверждённому приватному каналу. В публичных issues, чатах и отчётах запрещено публиковать credentials, персональные данные, приватное содержимое Jira и эксплуатационно пригодные подробности production-уязвимости до согласованного исправления и раскрытия. Runbook должен определять канал, ответственного за triage, целевой срок первичного ответа, severity и порядок координированного исправления.

### NFR-024. Реакция на компрометацию credential

Credential, обнаруженный в чате, issue, логе, commit, container layer, CI artifact, backup или ином неразрешённом контуре, считается скомпрометированным. До возобновления эксплуатации необходимо:

1. отозвать credential у соответствующего provider;
2. выпустить и безопасно установить новый credential;
3. проверить затронутые доступы, repository history, artifacts, logs и backups на распространение;
4. удалить доступные копии по утверждённой процедуре, не считая удаление заменой ротации;
5. зафиксировать incident, affected scope и доказательство ротации без публикации значения секрета.

## 4. Надёжность и целостность

### NFR-030. Атомарность критичных операций

Role grant/revoke, Draft CAS, duplicate decision, READY claim, posting operation claim и state transition должны быть транзакционными.

### NFR-031. SQLite durability

Для plugin-owned SQLite обязательны:

- WAL mode;
- `foreign_keys=ON`;
- bounded `busy_timeout`;
- `synchronous=FULL` для транзакций ролей и posting operations;
- транзакционные миграции;
- consistency check при старте.

### NFR-032. Идемпотентность

Локальный ключ `draft_id + draft_version + payload_hash` должен исключать конкурентный повтор операции. Уведомления имеют отдельную идемпотентность и не могут повторить create.

### NFR-033. Неоднозначный POST

После timeout/connection loss, когда request мог быть принят Jira, состояние — `UNKNOWN`. Без Jira key нет доказательства известной задачи; автоматический повторный POST и автоматическое создание новой operation запрещены. До любого потенциального повтора обязательна manual reconciliation; дальнейшее действие допускается только как отдельное аудируемое решение Technical Owner по утверждённому runbook, а не как автоматический retry.

### NFR-034. Нет Jira correlation field

Custom correlation field недоступен и не должен предполагаться. Локальный operation ID не является Jira identity. Reconciliation выполняется вручную и fail closed.

### NFR-035. Crash recovery

После restart незавершённые операции должны восстанавливаться без повторной отправки. `POSTING` без доказанного результата переводится в `UNKNOWN`, если нельзя доказать, что сеть не использовалась.

### NFR-036. Bounded retries

Retry допускается только для доказанно безопасной категории ошибки и ограничивается количеством, временем и backoff. `Retry-After` обязателен. `UNKNOWN` не retry-ится автоматически.

### NFR-037. Upstream circuit breakers

Для Jira, model provider и Telegram/STT должны быть отдельные circuit breakers, чтобы деградация upstream не блокировала Gateway и не создавала шторм запросов.

### NFR-038. Graceful shutdown

Plugin должен прекращать приём новых posting operations, завершать или безопасно фиксировать текущие транзакции, закрывать HTTP/SQLite resources и позволять однозначное восстановление.

### NFR-039. Backup/restore

Должны быть:

- регулярный backup plugin state и Catalog;
- шифрование backup в соответствии с production policy;
- отделение backup от credentials;
- согласованное сохранение и восстановление OpenClaw auth profiles вместе с отдельным auth-profile encryption key, без включения их в прикладной backup/export;
- периодическая restore-проверка;
- документированные RPO/RTO до production go-live.

Значения RPO/RTO пока не согласованы и являются обязательным operational input.

## 5. Производительность и ёмкость

### NFR-040. Response latency

Предварительные SLO при нормальной доступности upstream:

- p95 ответа без LLM/Jira/STT — не более 2 секунд;
- p95 Draft update с LLM — не более 20 секунд;
- p95 bounded duplicate search — не более 10 секунд;
- p95 подтверждённого Jira create — не более 10 секунд;
- статус о принятии voice message — не более 2 секунд; полная транскрипция измеряется отдельно.

### NFR-041. Async I/O

Длительные LLM, STT, Jira и Telegram операции не должны блокировать Gateway event loop. SQLite critical sections должны быть короткими.

### NFR-042. Bounded duplicate search

Поиск дублей должен иметь конфигурируемые жёсткие пределы timeout, страниц, кандидатов и возвращаемых полей. Значения по умолчанию определяются после production Jira load test и фиксируются в deployment config.

### NFR-043. Rate limits

Рекомендуемые стартовые пределы:

- 10 входящих сообщений в минуту на sender;
- 100 LLM-сообщений в сутки на sender;
- 3 активных Draft на sender;
- 1 активная access request;
- 5 create attempts в час на Creator, не считая запрещённые retry из `UNKNOWN`;
- отдельные global limits для LLM, STT, Jira search и Jira create.

Все пределы конфигурируемы, применяются до дорогостоящего вызова и не должны обходить Business Admin block.

### NFR-044. Capacity preflight

Перед go-live должны быть измерены:

- одновременные диалоги;
- CPU/RAM/disk для OpenClaw и SQLite;
- время и память Whisper `medium`;
- Jira search/create quota и влияние;
- Telegram/model provider limits.

### NFR-045. Whisper resources

Вычислительные ресурсы для Whisper `medium` считаются доступными. Deployment preflight должен доказать загрузку модели, доступность runtime, приемлемое время обработки и отсутствие memory pressure на OpenClaw.

## 6. Доступность и деградация

### NFR-050. Draft preservation

Недоступность LLM, STT, Jira или Telegram notification не должна повреждать уже сохранённый Draft или роль.

### NFR-051. LLM degradation

При quota/error Draft сохраняется; пользователь получает безопасный статус. Jira create не запускается, если проверка полноты не завершена.

### NFR-052. STT degradation

При недоступном Whisper система предлагает текстовый ввод. Необработанное voice не становится содержимым Jira.

### NFR-053. Jira degradation

При недоступной Jira READY может быть сохранён, но operation запускается только по правилам safe claim/retry. Неоднозначная отправка блокирует автоматизацию до reconciliation.

### NFR-054. Notification degradation

Ошибка Telegram-уведомления PO не откатывает созданную Jira-задачу. Доставка повторяется отдельно в bounded режиме; затем создаётся alert.

### NFR-055. Availability target

Числовой production SLO доступности и maintenance window должны быть согласованы до go-live. До этого система обязана иметь health checks и операционные alerts, но не заявляет неподтверждённый процент доступности.

## 7. Privacy, данные и retention

### NFR-060. Data minimization

В model context, admin/PO notifications, audit и Jira search results передаётся только минимум данных, необходимый для текущей операции.

### NFR-061. Публичность документации

Документы `docs/` не должны содержать секреты, токены, приватные Jira descriptions/search results, внутренние credentials или персональные admin IDs. Допускаются согласованные schema IDs и общие contract facts.

### NFR-062. Retention Draft

Draft, transcript text, duplicate checks и связанные временные данные хранятся 90 дней после последнего изменения, затем удаляются контролируемой fail-closed retention-задачей.

### NFR-063. Retention audit

Access grants, admin decisions, posting operations и audit events хранятся 1 год, если production policy не требует более строгого срока.

### NFR-064. Voice payload retention

Исходный voice payload не должен храниться дольше, чем нужно для транскрипции и технически безопасного retry; конкретный короткий срок фиксируется в privacy/runbook до go-live. Текст транскрипта следует сроку Draft.

### NFR-065. Deletion correctness

Retention job должен быть идемпотентным, тестируемым и учитывать backup lifecycle. Ошибка удаления создаёт alert; она не должна приводить к неконтролируемому удалению иных записей.

### NFR-066. Model data flow

Внешнему model provider передаются только необходимые тексты без credentials/headers и лишнего Jira-контекста. Data flow и правовое основание должны быть документированы production owner.

## 8. Наблюдаемость и аудит

### NFR-070. Structured logs

Логи должны быть структурированными и содержать timestamp, component, event type, outcome, local correlation/operation ID и санитаризированный error code.

### NFR-071. Correlation semantics

Локальный correlation ID используется только для трассировки. Он не является Jira key и не подтверждает создание задачи.

### NFR-072. Метрики

Обязательные метрики:

- active Guest/Creator;
- access requests по исходам;
- Draft lifecycle;
- duplicate search count/latency/error/decision;
- Jira create success/final failure/unknown;
- LLM/STT/Jira/Telegram latency и error rate;
- notification delivery;
- rate-limit/security blocks;
- SQLite busy/retry и migration status;
- reconciliation age для `UNKNOWN`.

### NFR-073. Alerts

Alerts должны срабатывать как минимум на:

- Jira 401/403;
- рост 5xx/429/timeouts;
- любую новую operation `UNKNOWN`;
- notification failure после retry budget;
- SQLite corruption/migration failure;
- backup/restore test failure;
- disk/memory pressure;
- недоступность Whisper model;
- истечение/ошибку Catalog version.

### NFR-074. Audit immutability

Audit log должен быть append-only на уровне приложения. Исправления оформляются новым событием, а не изменением истории.

### NFR-075. Audit sanitization

Audit хранит IDs, версии, hashes, решения и коды исходов, но не credentials, raw request/response bodies, полные descriptions или полные duplicate contents.

## 9. Сопровождаемость и совместимость

### NFR-080. Jira compatibility

Контракт рассчитан на Jira Server 11.3.8. Перед release plugin должен проверить create metadata/options и совместимость API; GET существующих задач не заменяет create-contract.

### NFR-081. Schema migrations

Каждая migration должна быть версионирована, транзакционна, повторно безопасна либо иметь явный guard, протестирована на upgrade и rollback/restore path.

### NFR-082. Configuration validation

На startup валидируются:

- фиксированный Jira project/type;
- наличие SecretRefs;
- admin allowlist;
- Catalog checksum/schema;
- PO routes;
- STT model `medium`;
- tool allowlist и channel binding;
- retention/rate-limit values.

Ошибка критичной проверки запрещает create, но должна позволять диагностировать систему без раскрытия секретов.

### NFR-083. Versioned contract

Изменение required fields, Jira options, Catalog schema или create mapping требует новой версии contract и regression tests.

### NFR-084. Runbooks

До go-live нужны runbooks:

- deploy/rollback;
- backup/restore;
- secret rotation и response на обнаружение credential в Git/chat/log/artifact;
- private vulnerability reporting и incident triage;
- Jira 401/403/429/5xx;
- `UNKNOWN` manual reconciliation;
- Catalog publish/rollback;
- PO notification failure;
- Whisper failure/capacity;
- incident redaction and audit export.

## 10. Тестирование и quality gates

### NFR-090. Unit tests

Покрыть RBAC, trusted identity decision, state machines, Draft CAS/versioning, readiness predicate, payload whitelist/mapping, duplicate decision, idempotency, redaction, rate limits и migrations.

### NFR-091. Security tests

Проверить:

- spoofed sender ID в тексте/JSON;
- Guest duplicate detail access;
- Guest/direct model create;
- forged admin/callback;
- role revoke race;
- prompt injection;
- arbitrary Jira URL/project/field/JQL;
- destination substitution;
- concurrent READY triggers;
- secret/log leakage;
- обнаружение запрещённых secret patterns в repository, image layers и CI artifacts;
- безопасную ротацию тестового credential после simulated leak.

### NFR-092. Integration tests

Проверить Telegram → OpenClaw → Draft DB, local Whisper `medium`, admin approval, Catalog import, bounded Jira search, Jira create contract, PO notification и restart recovery.

### NFR-093. Error matrix

Интеграционные тесты должны включать Jira validation 4xx, 401, 403, 409, 429, 5xx, timeout до отправки, timeout после возможной отправки и malformed success response.

### NFR-094. UNKNOWN invariant

Автотест должен доказать, что timeout после возможной отправки, restart, повтор сообщения и повторный READY event не вызывают новый POST.

### NFR-095. E2E production-safe smoke

До go-live выполняется согласованный production-safe smoke с контролируемой идеей и последующей стандартной обработкой в Jira. Тест не должен использовать приватные Jira contents в документации/логах.

### NFR-096. Performance tests

Измерить p95/p99 для локальных handlers, LLM Draft update, Whisper `medium`, bounded Jira search, create и notification; подтвердить отсутствие блокировки event loop.

### NFR-097. Release gate

Release запрещён при:

- failing security/integration/E2E tests;
- невалидном Catalog;
- неизвестных required Jira options;
- отсутствующем backup/restore proof;
- непроверенном `UNKNOWN` invariant;
- недоступном PO route для production Catalog;
- невозможности запустить Whisper `medium` в выделенных ресурсах.

## 11. Предварительные эксплуатационные критерии приёмки

1. Контейнер изолирован и использует зафиксированный последний стабильный OpenClaw image digest.
2. Secrets отсутствуют в repository, docs, DB, logs и prompts.
3. Валидация Jira Server 11.3.8 create metadata проходит.
4. SQLite durability, backup и restore подтверждены тестом.
5. Все security gates fail closed.
6. `UNKNOWN` никогда не приводит к автоматическому повторному POST.
7. Whisper `medium` проходит capacity/latency preflight.
8. PO notification route проверен без повторного Jira create.
9. Наблюдаемость различает `CREATED`, `FAILED_FINAL` и `UNKNOWN`.
10. Runbooks и release/rollback evidence доступны Technical Owner.
