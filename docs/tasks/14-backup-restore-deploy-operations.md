# 14. Backup, restore, deployment и эксплуатационные runbooks

## Цель и пользовательская ценность

Сделать release воспроизводимым и восстановимым: состояние Draft/RBAC/posting/audit сохраняется по утверждённым RPO/RTO, secrets остаются вне backup, а обновление или rollback не создают повторный Jira POST.

## Почему сейчас

Backup и deployment должны работать с финальной schema и operation semantics. Их нельзя откладывать до аварии, но нельзя проектировать до появления migrations, `UNKNOWN` recovery и write gate. Этап предшествует общей E2E-проверке и go-live.

## Зависимости и предусловия

Этапы 1–13 реализованы с default Jira write disabled. Закрыт O-006: владелец эксплуатации, SLO/RPO/RTO, backup cadence/retention/location, maintenance window, on-call/incident route. Согласованы secret storage, image registry и production host/network boundary.

## Scope

- Reproducible pinned image, SBOM/provenance и release manifest.
- Production Compose/deployment overlay без секретов в Git.
- SQLite-consistent encrypted backup, integrity verification и restore drill.
- Startup sequencing: config → migration → consistency → operation recovery → readiness → optional write enable.
- Upgrade/rollback/canary/kill-switch procedures.
- Runbooks: deploy, restore, UNKNOWN, credential rotation, Catalog rollback, degraded Jira/STT/Telegram, incident/redaction.
- Operational health/readiness, metrics and alert wiring.

## Вне scope

Оркестратор вне выбранного production контура, multi-region HA, автоматический destructive cleanup, публикация backup/credential и обещание недоказанного SLO.

## Компоненты и файлы

- `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`, `.github/workflows/ci.yaml`.
- `scripts/preflight.sh` и новые узкие `scripts/backup-state.sh`, `scripts/verify-restore.sh` либо эквивалентные versioned entrypoints.
- `docs/runbooks/deploy.md`, `backup-restore.md`, `rollback.md`, `credential-rotation.md`, `unknown-reconciliation.md`, `incident-response.md`.
- `packages/idea-to-jira-plugin/src/storage/backup.ts`, startup/readiness integration при необходимости.
- Release manifest с image digest, OpenClaw/plugin/schema/mapper/Catalog versions и проверками; без environment values.

## Атомарные инженерные задачи

1. Проверить актуальный stable OpenClaw и plugin SDK compatibility; зафиксировать exact image digest, не только mutable tag.
2. Генерировать SBOM и dependency/image scan evidence; блокировать release при policy violations.
3. Разделить read-only image/config, writable SQLite/state, temporary voice и external secret mounts с минимальными permissions.
4. Устранить неоднозначность текущего bind mount `./data/state:/home/node/.openclaw`: документировать/разнести runtime config, auth state и application DB так, чтобы backup scope был явным.
5. Определить backup set: SQLite consistent snapshot + schema/version/catalog references + необходимый audit; исключить credentials, OAuth/auth profiles, raw voice, transient transcripts и logs.
6. Реализовать SQLite online backup/checkpoint procedure без копирования живых `db/wal/shm` как несогласованного набора.
7. Шифровать backup operator-managed key, применять restrictive mode, checksum и retention; key не хранить рядом с backup/в Git.
8. Верифицировать каждый backup через restore в изолированную директорию, migration/consistency checks и row/state invariants.
9. Restore запускать только при write gate disabled и network write blocked; после restore unsafe `POSTING` обязан стать `UNKNOWN`, не POST.
10. Зафиксировать startup ordering и fail-closed readiness. Liveness не должна означать готовность к create.
11. Добавить graceful shutdown: stop intake/claims, завершить/зафиксировать безопасные local tx, затем остановить worker.
12. Описать rolling/canary или stop-the-world upgrade в рамках выбранного single-instance topology; исключить два активных writer без доказанного lease/lock.
13. Реализовать rollback matrix для binary/schema/config/mapper/Catalog; destructive down migration не использовать по умолчанию.
14. Проверить credential rotation: новый secret подхватывается контролируемо, старый отзывается, значения нигде не логируются.
15. Настроить alerts для write gate, UNKNOWN age, backup age/failure, restore drill, migration/consistency, Jira/Telegram/STT degradation и disk capacity.
16. Провести documented restore drill и измерить фактические RPO/RTO; заявлять только измеренные значения.

## Границы данных, состояний и интеграций

Backup сохраняет authoritative local state, но не считается Jira identity source. Catalog/metadata/mapper versions сохраняются как references/hashes; секреты восстанавливаются отдельно из secret manager. Restore не включает egress до завершения consistency/recovery. Release manifest не содержит приватные endpoints или IDs получателей.

## Безопасность и надёжность

Все operations scripts fail closed, используют explicit paths и не выводят env. Restore/rollback являются привилегированными operator actions. Backup encryption, access audit и periodic restore обязательны. Disk-full/read-only/partial backup не должен повреждать live DB. Runbook запрещает удалять UNKNOWN/audit для «разблокировки».

## Миграция, rollback и recovery

Deploy flow: backup verified → write gate off → image pull by digest → migration/consistency/recovery → read-only smoke → controlled enable. Rollback binary разрешён только при schema compatibility; иначе forward fix или restore в новый volume по approved runbook. После restore rotate ephemeral leases, не изменяя durable operation identity/idempotency records.

## Тесты

### Integration/recovery

- Online backup под concurrent safe workload; restore checksum/schema/domain invariants.
- Kill во время backup/migration/restore; live source не повреждён, partial artifact не считается valid.
- Restore с `POSTING`/`UNKNOWN`/notification `SENDING`; Jira POST count остаётся zero.
- Upgrade N→N+1 и совместимый rollback; неизвестная schema блокирует startup.
- Disk full, bad permissions, corrupt backup, wrong key, missing Catalog/metadata reference.

### Security/operations

- Secret scan backup/log/release artifacts; credentials/OAuth/transcripts отсутствуют.
- Container non-root/read-only/cap-drop/egress/storage permissions.
- Image digest/SBOM/signature verification согласно выбранной policy.
- Credential rotation и kill-switch drill.
- Measured restore time/capacity and alert delivery on synthetic environment.

## Проверяемые критерии приёмки

1. Из валидного backup восстанавливается согласованное состояние с подтверждёнными schema/domain invariants.
2. Restore и rollback не вызывают Jira POST и не снимают `UNKNOWN` block.
3. Backup не содержит credentials, OAuth/auth profile, raw voice/transcripts или private logs.
4. Production image и зависимости воспроизводимо идентифицируются digest/versions.
5. Startup/readiness не разрешает create до migration, recovery и contract preflight.
6. RPO/RTO и capacity подтверждены измерением либо go-live остаётся blocked.

## Exit criteria

- O-006 закрыт одобренными значениями и owners.
- Успешный restore drill с сохранённым санитаризированным отчётом.
- Все runbooks reviewed, команды проверены в non-production среде.
- Release manifest, SBOM, scans, rollback/kill-switch evidence доступны для этапа 16.

## Трассируемость

BR-010/012; FR-083—086, FR-093, FR-103/104/112; NFR-001—005, NFR-013—015/020/021/024, NFR-031/035/038/039, NFR-043/044, NFR-050—055, NFR-060—065, NFR-070—075, NFR-080—084, NFR-092—097; D-008/010/015/017/023; JC-050—053; O-006/O-007.

## Риски, неизвестные и решения

- **Decision needed:** production topology, backup destination, encryption/KMS, cadence, retention, RPO/RTO и incident ownership.
- **Risk:** backup всего OpenClaw state захватит auth material; требуется explicit application backup set.
- **Risk:** bind mounts и permissions текущего Compose являются scaffold, не доказанным production layout.
- **Blocker:** непроверенный restore или mutable image reference блокируют go-live.
