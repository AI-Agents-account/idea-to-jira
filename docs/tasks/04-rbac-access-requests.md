# Этап 04. RBAC и заявки доступа

[К карте этапов](README.md)

## Цель и ценность

Реализовать trusted identity decision и server-side Guest/Creator/Admin boundary. Ценность — любой пользователь оформляет Draft, но только явно допущенный sender ID достигает Creator-only функций.

## Порядок и зависимости

- Этапы 01—03: trusted requester context, transactions и audit.

## Scope

- user lifecycle, одна active access request, admin approve/deny/block;
- grant/revoke/suspend/restore и role version/CAS;
- deterministic handlers/callback anti-replay;
- authorization policy для own Draft, duplicate details и create prechecks.

## Out of scope

- корпоративный SSO и доказательство identity без Admin;
- approval конкретной Feature;
- host/OpenClaw access для Business Admin.

## Конкретные компоненты и файлы

- целевые `src/auth/authorization.ts`, `src/access/access-service.ts`, repositories и typed tools/handlers;
- migration constraints из этапа 02; `src/index.ts` registration;
- Telegram callback integration только после подтверждения SDK.

Указанные новые пути — целевая декомпозиция. Перед созданием файла исполнитель обязан сверить фактические OpenClaw SDK/API и сохранить узкую ответственность; путь не является разрешением выдумать неподтверждённый интерфейс.

## Атомарные задачи

1. Создавать `GUEST` для нового host-derived sender ID, сохраняя username/display name только как недоверенный snapshot.
2. Реализовать idempotent request: максимум одна `PENDING`, повтор возвращает status.
3. Формировать минимальную Admin card без содержания идеи/Jira; destination только server-side allowlist.
4. Реализовать approve/deny/block handler без LLM: проверить admin sender ID, chat/account, action state/version и anti-replay.
5. В одной transaction сохранить decision, role grant/version и audit; concurrent action получает stale/conflict без второго перехода.
6. Реализовать revoke/suspend/restore/block с атомарностью и понятными состояниями.
7. Создать reusable authorization guards: own resource, active Creator, Business Admin; deny unknown/suspended/blocked.
8. Повторно проверять Creator при будущих duplicate disclosure, operation claim и непосредственно перед POST.

## Data, state и integrations

- `users`, `access_requests`, `role_grants`, audit events; reason хранить ограниченно и санитаризированно.
- Admin allowlist остаётся runtime config/secret, не DB-managed публичным ботом.

## Security и reliability

- Sender ID только host-derived; callback payload содержит opaque action reference, но не авторитет actor.
- Username/display name не участвуют в access key.
- Guest никогда не получает Jira candidate detail даже через error/audit endpoint.

## Migration, rollback и recovery

- Schema migration добавляет constraints/versions; initial users default Guest, роли не backfill.
- Rollback revoke code не должен отменять уже созданные Jira issues; active operations обрабатываются posting policy.
- После restart pending/action state читается из DB; replay старой callback отклоняется.

## Тесты

- Unit/state table для всех role/access transitions и forbidden paths.
- Concurrency: два approve, approve-vs-deny, revoke race, stale callback/replay.
- Security: forged admin ID, sender ID в text/params, чужой Draft, blocked user, destination substitution.

## Acceptance и exit criteria

- Только allowlisted Admin по host-derived ID создаёт active Creator grant.
- Решение и audit атомарны; повтор/replay не меняет outcome.
- Revoke/suspend блокирует новые Creator-only operations.
- Guest access request работает без раскрытия Jira/private Draft.

## Traceability

BR-002—BR-004, BR-006; FR-030—FR-037, FR-050, FR-101, FR-110—FR-112; NFR-011—NFR-012, NFR-018—NFR-019, NFR-030, NFR-043, NFR-090—NFR-091; D-003—D-005.

## Риски, unknowns и decisions

- Фактический deterministic callback API OpenClaw/Telegram нужно подтвердить.
- Admin identity verification вне системы — operational process; бот не должен притворяться SSO.
- Role revoke race окончательно закрывается повторной проверкой в posting transaction/перед сетью.
