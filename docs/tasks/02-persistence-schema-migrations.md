# Этап 02. SQLite, schema и migrations

[К карте этапов](README.md)

## Цель и ценность

Дать плагину собственное crash-consistent хранилище и транзакционную основу критичных state machines. Ценность — роли, Draft и posting operations переживают restart без гонок и слепых повторов.

## Порядок и зависимости

- Этап 01: validated paths/config и create-disabled startup.
- До schema v1 закрыть nomenclature decision по persistent enums `EDITING/DRAFTING`, `PENDING/CLAIMED`; не выпускать две несовместимые машины состояний.

## Scope

- выбор поддерживаемого Node 24 SQLite driver на основании совместимости и supply-chain проверки;
- schema versioning, transactional migration runner, startup consistency check;
- connection policy: WAL, FK, bounded busy timeout, critical `synchronous=FULL`;
- минимальные таблицы FR-100 и constraints, без реализации domain services.

## Out of scope

- диалог, RBAC handlers, Jira transport и retention execution;
- хранение secrets/OAuth/voice binary/full external payloads.

## Конкретные компоненты и файлы

- целевые `packages/idea-to-jira-plugin/src/storage/database.ts`, `packages/idea-to-jira-plugin/src/storage/migrations/*`, `packages/idea-to-jira-plugin/src/storage/transaction.ts`, `packages/idea-to-jira-plugin/src/storage/health.ts`;
- `packages/idea-to-jira-plugin/package.json`/lock только после выбранного driver;
- Compose volume/path и startup wiring в `packages/idea-to-jira-plugin/src/index.ts`;
- migration/upgrade/restore fixtures и tests.

Указанные новые пути — целевая декомпозиция. Перед созданием файла исполнитель обязан сверить фактические OpenClaw SDK/API и сохранить узкую ответственность; путь не является разрешением выдумать неподтверждённый интерфейс.

## Атомарные задачи

1. Сравнить доступные SQLite варианты по Node 24, native-image/build требованиям, maintenance и транзакционным API; зафиксировать решение, не предполагая библиотеку заранее.
2. Утвердить schema v1 и canonical enums, primary/foreign keys, timestamps, versions и CHECK constraints для `users`, `access_requests`, `role_grants`, `drafts`/versions, Catalog, duplicate checks, posting operations, notifications, audit.
3. Запроектировать отдельно immutable version rows и mutable heads там, где требуется CAS; payload/user text не дублировать без необходимости.
4. Создать versioned migration registry с одной transaction на migration, checksum/guard и запретом запуска приложения при частично применённой версии.
5. На каждом connection включить `foreign_keys=ON`, bounded busy timeout и WAL; гарантировать `synchronous=FULL` в role/posting critical transactions.
6. Ввести file/path/permission checks: state dir ≤0700, DB/backups ≤0600 с проверкой реальных mount semantics.
7. Добавить startup `quick_check`/выбранный consistency check и безопасное закрытие ресурсов.
8. Создать repository interfaces и transaction boundary, но не реализовывать бизнес-переходы раньше профильных этапов.

## Data, state и integrations

- SQLite хранит plugin business state, не OpenClaw auth profile. Raw Telegram update, headers, credentials, full Jira response и voice binary в schema не включать.
- Unique constraints должны поддержать одну active access request, Draft CAS и future operation key `draft_id + version + payload_hash`.

## Security и reliability

- Параметризованные queries; SQL/JQL не принимаются от модели.
- Файл DB не монтировать в web-visible/workspace/catalog path; не добавлять в Git/image layer.
- Audit append-only constraint проектировать без хранения полных descriptions.

## Migration, rollback и recovery

- Проверить fresh install, upgrade с предыдущей schema, crash/rollback внутри migration и несовместимую future schema.
- Перед production migration обязателен consistent backup; rollback schema допускается только если доказан, иначе restore всего согласованного snapshot.
- Ошибка DB/migration/consistency запрещает create и включает alert/diagnostic mode.

## Тесты

- Unit/repository: transactions, FK/CHECK/unique constraints, CAS conflicts, busy handling.
- Migration: empty→latest, each supported previous→latest, interrupted migration, repeat guard, future version reject.
- Recovery: WAL restart, corruption fixture/failed check, permission mismatch.

## Acceptance и exit criteria

- Schema создаётся/обновляется детерминированно и имеет проверяемую версию.
- Critical transaction не может завершиться частично; concurrent claims блокируются constraints.
- Restart не теряет committed records; invalid DB никогда не открывает Jira write.
- DB, WAL и test backups отсутствуют в Git diff/artifacts.

## Traceability

BR-012; FR-025—FR-026, FR-035, FR-062, FR-072—FR-073, FR-100—FR-104; NFR-020, NFR-030—NFR-031, NFR-035, NFR-039, NFR-081; D-007—D-009; Jira contract JC-031—JC-032.

## Риски, unknowns и decisions

- Конкретный driver и migration tooling не выбраны — исследовать, не выдумывать.
- Persistent enum conflict должен быть закрыт до первой опубликованной migration.
- Read-only root + volume ownership могут не дать требуемые modes; проверить в container integration test.
