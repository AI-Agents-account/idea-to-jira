# Этап 01. Runtime, конфигурация и security foundation

[К карте этапов](README.md)

## Цель и ценность

Создать проверяемую deny-by-default границу выделенного агента, чтобы последующие функции не могли обойти identity, destination, tool и Jira-write gates. Ценность — безопасно наращивать MVP, не превращая scaffold в случайно пишущий production-бот.

## Порядок и зависимости

- Baseline `83ac301`; этап не зависит от продуктовых сервисов.
- До начала сверить фактический OpenClaw plugin/requester API с закреплённой версией `2026.7.1-2`; не проектировать hooks по догадке.

## Scope

- startup-валидация критичной конфигурации и единый тип effective config;
- проверка account/channel/DM/host-derived sender/chat context перед бизнес-операциями;
- точный tool allowlist, destination lock, rate-limit interface и явный create-disabled gate;
- проверка согласованности manifest, OpenClaw config, Compose env и runtime paths.

## Out of scope

- RBAC, SQLite schema, Draft, Catalog parser, Whisper, Jira HTTP и уведомления;
- выбор production model и открытие Jira write.

## Конкретные компоненты и файлы

- `packages/idea-to-jira-plugin/src/config.ts`, `packages/idea-to-jira-plugin/src/index.ts`;
- целевые узкие модули `packages/idea-to-jira-plugin/src/runtime/requester-context.ts`, `packages/idea-to-jira-plugin/src/runtime/policy.ts` после подтверждения SDK API;
- `packages/idea-to-jira-plugin/openclaw.plugin.json`, `config/openclaw.json5`;
- `.env.example`, `compose.yaml`, `Dockerfile`, `scripts/preflight.sh`, `scripts/healthcheck.mjs`;
- unit/config fixtures в `packages/idea-to-jira-plugin/tests/`.

Указанные новые пути — целевая декомпозиция. Перед созданием файла исполнитель обязан сверить фактические OpenClaw SDK/API и сохранить узкую ответственность; путь не является разрешением выдумать неподтверждённый интерфейс.

## Атомарные задачи

1. Инвентаризировать доступный requester/channel context и lifecycle hooks закреплённого OpenClaw SDK; записать подтверждённый контракт в кодовых тестах/архитектуре.
2. Определить одну server-side структуру config: fixed Jira scope, пути state/Catalog, admin allowlist, limits, retention, STT model и write mode; значения с секретами принимать только через защищённый runtime source.
3. Добавить строгую parse/startup validation с unknown-key reject и санитаризированными ошибками; критическая ошибка переводит приложение в create-disabled diagnostic mode.
4. Реализовать deterministic precondition для выделенного Telegram account, DM, sender ID, chat ID и исходного destination; client/model поля identity игнорировать/отклонять.
5. Зафиксировать model tool allowlist только на существующих безопасных tools; direct Jira/HTTP/exec/browser/filesystem/message/config tools не добавлять.
6. Ввести явный write gate, который по умолчанию и во всех dev/CI конфигурациях закрыт; существующий `DisabledJiraIssueClient` сохранить конечной границей до этапа 13.
7. Согласовать env ↔ manifest ↔ config names и устранить скрытые неиспользуемые параметры без добавления секретов в tracked файлы.
8. Расширить preflight/readiness так, чтобы health и create-readiness были разными сигналами.

## Data, state и integrations

- Новых business records нет. Config snapshot может содержать только несекретные effective flags/versions; secret values не сериализуются.
- Интеграции: OpenClaw host context и Telegram adapter только для проверки boundary; внешние вызовы не нужны.

## Security и reliability

- Fail closed при неизвестном account/channel/sender/chat, invalid config и destination.
- Admin IDs, tokens, OAuth state и Jira origin не выводить модели, пользователю, логам или fixtures.
- Не расширять `channels.telegram.dmPolicy: open` до полномочий: любой DM остаётся Guest до server-side grant.

## Migration, rollback и recovery

- Data migration отсутствует. Изменения config schema должны иметь backward-compatibility test или явный отказ старта.
- Rollback — возврат к прежнему manifest/config при сохранённом write-disabled adapter; отсутствие новой config не должно открыть write.
- Recovery после invalid startup: диагностический режим + исправление operator config, без изменения пользовательских данных.

## Тесты

- Unit: valid/invalid/unknown config, пустые secrets references, admin allowlist format, fixed project/type.
- Security: spoofed sender/chat/account в params/model text, group update, destination substitution, forbidden tool registration.
- Native: `npm run validate:json`, `npm run check`, `npm run build`, Compose rendering/preflight.

## Acceptance criteria

- Все business handlers получают только валидированный trusted requester context.
- Tool/config snapshot доказывает deny-by-default; Jira POST недостижим.
- Ошибка критичной конфигурации видна оператору безопасным кодом и не раскрывает значение.
- Health не заявляет readiness Jira/Telegram/model/Catalog.

## Exit criteria

- Config, requester-context и forbidden-tool tests проходят в CI.
- Production Jira transport отсутствует или неизменно принудительно выключен.
- Проверены runtime paths/permissions, необходимые этапу 2; все неподтверждённые OpenClaw hooks оставлены явными blockers, а не assumptions в коде.

## Traceability

BR-002, BR-003, BR-010; FR-001—FR-005, FR-110—FR-112; NFR-001—NFR-005, NFR-010—NFR-019, NFR-082; D-004, D-010, D-015, D-018, D-023; Jira contract §§3—4, JC-024.

## Риски, unknowns и decisions

- Не подтверждён точный OpenClaw API trusted context/hooks — блокер реализации handler boundary.
- `JIRA_*` env сейчас не используется plugin config; нельзя считать его защитой или готовностью.
- Выбор primary model и stable image digest — deployment evidence, не hardcode этого этапа.
