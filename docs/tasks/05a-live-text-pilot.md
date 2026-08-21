# 05A. Контролируемый live text-only pilot на Stages 01–05

## Цель и пользовательская ценность

Проверить runtime/security, persistence, audit, public access-request boundary, RBAC и versioned Draft в настоящих Telegram private DM. Controlled operator остаётся отдельной identity для admin/owner-directive smoke; pilot не открывает Jira create.

## Почему сейчас

Stages 01–05 дают безопасный локальный контур, который полезно проверить на реальном канале до Catalog, duplicate search, Jira metadata/mapper/posting и voice. Ранний pilot должен выявить проблемы model orchestration, Telegram context, permissions и restart durability, не создавая внешних Jira side effects.

## Зависимости и предусловия

- Stages 01–05 приняты и локальные проверки проходят.
- Используется отдельный Telegram bot через canonical account `default`, agent `idea-mvp`, public numeric private-DM ingress, numeric controlled operator `TELEGRAM_PILOT_SENDER_ID` в Business Admin allowlist и reviewed canonical `openai/*` route.
- Настоящие credentials и auth-profile state находятся только в runtime secret/state mounts, вне Git и отчётов.
- Technical Owner явно разрешает окно smoke и имеет rollback/остановку Gateway.

## Scope

- Только входящие текстовые Telegram private DM; любой numeric sender может вызвать typed `/request_access`, но модель/tools доступны только после server-side role admission.
- Реальные host-derived channel/account/sender/destination checks до model run и повторно в каждом typed tool.
- Stage-04 access/RBAC и Stage-05 own-Draft create/read/CAS patch/cancel.
- Проверка audit/storage health и сохранения состояния после controlled restart.
- Локальный readiness без Telegram/Jira вызовов и пошаговый live-smoke runbook.

## Вне scope

- Group/topic, voice/audio/image/video, arbitrary files/links и generic tools.
- Реализованный Catalog lifecycle, Jira metadata/read/search, duplicate decisions, READY/create orchestration, notifications и posting/reconciliation.
- Любой Jira HTTP request, особенно `POST`; Jira credential не инжектируется.
- Production traffic, broad beta, unattended operation и обещание production readiness.

## Реализуемые границы

1. OpenClaw Telegram channel/account используют `dmPolicy: "open"`, `allowFrom: ["*"]`, `groupPolicy: "disabled"`.
2. Native/text core-command parsing выключен; `TELEGRAM_PILOT_SENDER_ID` ограничивает remaining directive/owner authorization и controlled smoke, а plugin effective config не использует его как requester allowlist.
3. `before_agent_run`, command и tool contexts принимают только `telegram` account `default`, agent `idea-mvp`, numeric direct peer destination и user trigger; Guest free-form блокируется до модели.
4. Agent tool allowlist остаётся exact и tools скрыты/отклонены до role gate; media audio understanding явно disabled.
5. Jira `writeMode` остаётся manifest `const: "disabled"`; runtime использует `DisabledJiraIssueClient`, не получает Jira credential и не содержит create tool/transport.
6. `readiness:pilot` проверяет effective OpenClaw/plugin boundaries, model route, Catalog checksum, disabled Jira adapter и storage health, не вызывая Telegram, OpenAI или Jira.

## Атомарные инженерные задачи

1. Зафиксировать Stage-05A в карте задач сразу после Stage-05; поздние full lifecycle и voice оставить deferred.
2. Зарегистрировать public typed `/request_access` с idempotent status и строгой host-derived DM validation без model run.
3. Перевести Telegram DM policy на open wildcard, оставить groups disabled/peer-isolated sessions, отключить native/text core commands и отдельно ограничить remaining directive/owner authorization controlled operator identity.
4. Закрепить reviewed model route через `OPENAI_MODEL`; отключить audio understanding.
5. Удалить Jira credential из Compose/.env pilot runtime; сохранить fixed Jira scope только как fail-closed конфигурацию.
6. Добавить offline structural readiness и live-local readiness с безопасными кодами без raw exceptions/IDs/secrets.
7. Добавить regression tests на public numeric sender, malformed/group/thread/destination rejection, Guest pre-model/tool gate, command boundary, text-only policy, storage restart, RBAC/Draft/CAS и disabled Jira writes.
8. Опубликовать операторский runbook с prechecks, positive/negative smoke, restart proof, evidence и rollback.

## Catalog-before-duplicate/READY/create invariant

Stage-05A не активирует Catalog и поэтому не может выполнять duplicate search, достичь READY или вызвать create. В любом будущем full lifecycle verified active Catalog version/checksum/schema обязателен **до** duplicate search, READY evaluation и Jira create claim. Недоступный/stale/непроверенный Catalog означает fail closed; pilot не ослабляет этот порядок.

## Тесты и проверяемые evidence

- Config/unit: controlled operator отсутствует/invalid или не входит в Admin allowlist — readiness отклоняется; plugin requester config от него не зависит.
- Requester/security: любой numeric private-DM sender принят; non-numeric, group-like destination, thread, wrong channel/account/trigger блокируются.
- Deployment: public wildcard/open DM сочетается с disabled groups, disabled native/text core commands и controlled directive/owner allowlists; generic tools отсутствуют, audio disabled, Compose не передаёт `JIRA_TOKEN`.
- RBAC/Draft: access anti-replay, own-Draft boundaries, immutable versions, stale CAS и cancel.
- Persistence/restart: schema/quick/FK health, WAL restart и reopened Draft/version state.
- Jira: config/manifest gate disabled и adapter deterministic throw; ни один test/smoke step не делает network POST.

## Проверяемые критерии приёмки

1. Guest sender может выполнить только typed access/status flow и не достигает model run, core command/directive execution или tool mutation.
2. Approved Creator может пройти RBAC flow и создать/прочитать/изменить/отменить только собственный Draft через Telegram DM text.
3. После controlled restart текущий access state, Draft ID и version сохраняются.
4. Voice/media не транскрибируется и не изменяет Draft; text-only ограничение отражено в readiness/config.
5. Catalog остаётся непригодным для READY; duplicate/READY/create отсутствуют.
6. Jira credential отсутствует в pilot container env, create tool отсутствует, Jira POST равен нулю.

## Exit criteria

- `npm run validate:json`, `npm run build`, `npm run lint`, `npm run test`, `scripts/preflight.sh` и `npm run readiness:pilot` проходят в соответствующих offline/live-local средах.
- Заполнен smoke evidence record без private payloads, IDs, токенов и raw logs.
- Любой failed boundary/readiness check останавливает pilot; broadening allowlist или открытие Jira не используется как workaround.
- Решение продолжить, исправить или закрыть pilot принято Technical Owner вручную.

После успешного pilot следующим implementation package является Stage-08 read-only metadata/mapper. Core этапов 09–12 разрешено разрабатывать только на synthetic fixtures/fake transports; route-dependent acceptance ждёт полного Stage-06, а voice остаётся отложенным до Stage-15 E2E.

## Трассируемость

BR-001/004/005/011; FR-010—018, FR-020—028, FR-036, FR-060—062, FR-090, FR-100—105; NFR-010—012, NFR-020—023, NFR-030—032, NFR-040—043, NFR-050—053, NFR-060—063, NFR-090—093; D-001—003, D-020, D-025; JC-003—004.

## Риски и blockers настоящего live smoke

- Нужны реальный dedicated Telegram bot token и numeric pilot sender ID; их нельзя получать или проверять offline.
- Нужен выбранный доступный `openai/*` model route и действующий auth profile; config validation не доказывает provider login/model entitlement.
- Нужны writable persistent mounts с корректным owner/mode и явное окно controlled restart.
- OpenClaw config подтверждает отключение audio understanding, но реальное Telegram media rejection и отсутствие Draft mutation должны быть проверены negative smoke; Stage-07 voice не реализован.
- Настоящий Telegram delivery/context и model orchestration требуют внешнего smoke, который не выполняется в реализации Stage-05A без отдельного разрешения.
