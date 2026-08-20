# Этап 02. SQLite, schema и migrations

[К карте этапов](README.md)

## Цель и ценность

Дать плагину собственное crash-consistent хранилище и транзакционную основу критичных state machines. Ценность — роли, Draft и posting operations переживают restart без гонок и слепых повторов.

## Порядок и зависимости

- Этап 01: validated paths/config и create-disabled startup.
- Canonical enum decision закрыт D-025: schema v1 использует `EDITING` и `PENDING`; `DRAFTING`/`CLAIMED` не выпускаются как вторая машина состояний.

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

## Acceptance criteria

- Schema создаётся/обновляется детерминированно и имеет проверяемую версию.
- Critical transaction не может завершиться частично; concurrent claims блокируются constraints.
- Restart не теряет committed records; invalid DB никогда не открывает Jira write.
- DB, WAL и test backups отсутствуют в Git diff/artifacts.

## Exit criteria

- Fresh/upgrade/interrupted/future-schema migration и recovery suites проходят.
- Persistent enum schema v1 согласована и зафиксирована migration contract tests.
- Storage paths, owner/modes и SQLite durability проверены внутри целевого контейнера.
- Этапы 3–5 могут использовать единый transaction/repository boundary без обхода constraints; Jira write остаётся выключен.

## Traceability

BR-012; FR-025—FR-026, FR-035, FR-062, FR-072—FR-073, FR-100—FR-104; NFR-020, NFR-030—NFR-031, NFR-035, NFR-039, NFR-081; D-007—D-009; Jira contract JC-031—JC-032.

## Риски, unknowns и decisions

- Driver decision закрыт D-024: встроенный `node:sqlite` проверен на pinned Node `24.19.0`; дополнительный native addon/dependency не добавлен.
- Persistent enum conflict закрыт D-025 и migration contract tests.
- Read-only root + volume ownership проверяются target-container smoke test с UID/GID фактически собранного image.
- WAL не копируется как одиночный live DB-файл: `createConsistentBackup()` использует SQLite online backup API, restore проверяет application ID, migration history, `quick_check` и foreign keys.

## Реализационные evidence

- Schema и migrations: `packages/idea-to-jira-plugin/src/storage/migrations/`.
- Connection/startup/health/permissions/backup: `packages/idea-to-jira-plugin/src/storage/`.
- Contract, recovery и operator verification: `docs/STORAGE.md`.
- Unit/integration evidence: `packages/idea-to-jira-plugin/tests/storage.test.ts` и `storage-startup.test.ts`.
- Target-container smoke: `scripts/storage-container-check.mjs` и CI step `Verify SQLite durability and mount permissions in target container`.
