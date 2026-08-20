# 16. Production readiness и go-live gates

## Цель и пользовательская ценность

Принять осознанное решение о production запуске на основании проверяемого release record, а не наличия scaffold или отдельных green tests. Запуск должен быть обратимым, наблюдаемым и начинаться с минимального пилотного blast radius.

## Почему сейчас

Go-live — не разработка ещё одной функции, а финальная проверка всех технических, security, data и operational предусловий. Он выполняется только после полной integrated evidence matrix и успешного restore/rollback drill.

## Зависимости и предусловия

Приняты этапы 1–15. Закрыты O-001—O-007. Нет critical/high defects без формально утверждённого запрета затронутой функции. Release commit/image digest неизменны со времени тестов; production configuration и secrets подготовлены вне Git.

## Scope

- Final readiness review и signed release record.
- Проверка owners, runbooks, alerts, dashboards, backup/restore, credential rotation и incident route.
- Production deploy с write gate off, read-only smoke, затем отдельное controlled enablement.
- Ограниченный pilot/canary, наблюдение и rollback/kill criteria.
- Production-safe E2E smoke без лишних Jira writes и post-launch verification.
- Передача в эксплуатацию и план первой контрольной точки.

## Вне scope

Расширение MVP, массовый rollout без pilot evidence, принятие новых архитектурных решений «по ходу запуска», отключение fail-closed guards ради доступности и автоматическое удаление тестовых Jira issues.

## Компоненты и файлы

- Release checklist/record из versioned template `docs/runbooks/go-live-checklist.md` с runtime evidence вне Git при необходимости.
- Deployment/rollback/incident/reconciliation/backup/credential/Catalog runbooks этапа 14.
- Dashboards/alerts и release manifest с commit, image digest, schema, mapper, metadata, Catalog и OpenClaw versions.
- Production config/secret references в operator-managed storage; repository содержит только schema/example.

## Атомарные инженерные задачи

1. Зафиксировать release identity: Git SHA, image digest/signature/SBOM, OpenClaw/plugin/Node versions, schema/migrations, mapper/metadata/Catalog hashes.
2. Подтвердить approvals/owners: Product/Business, Technical Owner, security, data/privacy, operations/on-call и Jira service account owner согласно принятой governance.
3. Проверить, что production secrets, bot/Jira credentials и auth profiles находятся только в approved secret storage; rotation/revocation tested.
4. Проверить dedicated Telegram account, DM-only/group disabled, peer scope, bindings, tool allowlist и server-side requester/destination checks.
5. Проверить production Jira metadata/options/permissions и Catalog/PO routes непосредственно перед deploy; drift оставляет write gate off.
6. Проверить backup freshness, успешный restore drill, disk/capacity, RPO/RTO, rollback image и kill-switch доступность ответственному operator.
7. Проверить dashboards/alerts: health/readiness, write gate, create outcomes, UNKNOWN age, notification failure, Jira/STT/Telegram degradation, DB/disk, backup age.
8. Deploy image by digest с Jira write disabled и egress write blocked/controlled; выполнить migration, consistency и startup recovery.
9. Выполнить read-only smoke: health/readiness, DM routing, RBAC/Draft/Catalog/metadata/search в разрешённом synthetic scope; zero POST.
10. Провести go/no-go checkpoint. Любой blocker останавливает enablement без ручного обхода данных/state.
11. По отдельному явному разрешению включить write gate для ограниченного Creator/pilot cohort и выполнить один production-safe create smoke по approved disposable/synthetic policy.
12. Подтвердить ровно один Jira issue, валидный key/project/type/required fields/unassigned/initial workflow и Creator/PO notifications; не выполнять plugin transition/delete.
13. Сразу проверить audit/redaction/metrics и отсутствие credential/private payload в logs/artifacts.
14. Наблюдать pilot в утверждённом окне; не расширять cohort до прохождения thresholds по errors/UNKNOWN/latency/notifications.
15. При stop criterion отключить новые writes kill switch; сохранить state/evidence, не повторять UNKNOWN и следовать rollback/reconciliation runbook.
16. После успешного окна подписать release outcome, зафиксировать known limitations и назначить дату/owner post-launch review.

## Границы данных, состояний и интеграций

Production smoke использует минимальные синтетические данные и отдельное разрешение. Release record хранит identifiers/hashes/results, но не secrets, raw Draft/Jira bodies, Telegram routes или transcripts. Feature enablement принадлежит operator boundary и не доступен модели/пользователю.

## Безопасность и надёжность

Go-live fail closed: availability не важнее запрета duplicate/unauthorized POST. Нет bypass для stale metadata, audit failure, missing backup/reconciliation owner или unknown config. Stop/rollback не удаляет operation/audit и не повторяет create. Pilot ограничивает actor cohort, rate и время.

## Миграция, rollback и recovery

Rollback criteria определены до enablement: security/privacy violation, duplicate/unauthorized POST, false CREATED, unresolved migration/recovery, secret exposure, alerting failure, UNKNOWN threshold и data integrity defect. Сначала disable writes, затем preserve evidence/backup, после чего binary/config rollback по compatibility matrix. `UNKNOWN` остаётся manual reconciliation; restore не используется для стирания результата POST.

## Тесты и проверки

- Повторить release gate этапа 15 на exact commit/image digest.
- Production config validation и secret-reference presence без вывода values.
- Read-only smoke до enablement; call counter/audit подтверждают zero POST.
- Отдельно одобренный one-create smoke с проверкой Jira postconditions и notifications.
- Kill-switch/rollback/alert-on-call tabletop или live drill в безопасном scope.
- Post-deploy backup/readiness/restart check без повторного POST.

## Проверяемые acceptance criteria

1. Все O-001—O-007 имеют решение, owner и evidence; нет молчаливых defaults на material production choices.
2. Release identity совпадает с проверенным artifact, а configuration drift отсутствует.
3. До отдельного enablement production получает zero POST; enablement недоступен модели/пользователю.
4. Одобренный smoke создаёт ровно одну Feature и доставляет trusted notifications без secret/private leakage.
5. Любой `UNKNOWN` не приводит к auto retry и имеет работающий alert/reconciliation owner.
6. Backup/restore, kill switch, rollback и on-call проверены до расширения pilot.

## Exit criteria

- Подписан go/no-go record со всеми обязательными approvals/evidence.
- Production-safe smoke и наблюдение pilot соответствуют утверждённым thresholds.
- Нет critical/high security, integrity, recovery или privacy blockers.
- Передача в эксплуатацию завершена: owners/runbooks/dashboards/alerts доступны, post-launch review назначен.
- При отрицательном решении система остаётся в согласованном read-only/write-disabled состоянии с конкретным blocker list.

## Трассируемость

BR-001—012, BAC-01—10; FR-001—112, FAC-01—12; NFR-001—097 и раздел 11; D-001—023; JC §3–16; O-001—O-007.

## Риски, неизвестные и решения

- **Risk:** различие test и production metadata/network/Telegram behavior; pre-enable read-only evidence обязательно.
- **Risk:** pressure to bypass UNKNOWN/audit/backup gates ради срока; go-live checklist запрещает bypass.
- **Decision needed:** pilot cohort, окно наблюдения, quantitative stop/expand thresholds и approvers.
- **Blocker:** неподписанный release record, непроверенный restore/kill switch или отсутствующий reconciliation owner означает no-go.
