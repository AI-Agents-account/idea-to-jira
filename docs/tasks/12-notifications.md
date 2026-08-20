# 12. Идемпотентные уведомления Creator, PO и Business Admin

## Цель и пользовательская ценность

После доказанного create доставить Creator реальный key/link, PO — минимальный actionable context, admin/Technical Owner — только необходимые access/operational alerts. Сбой/повтор notification никогда не откатывает issue и не повторяет Jira POST.

## Почему сейчас

Notification destinations зависят от Catalog/RBAC, а delivery state — от audit/persistence. Реализуется до production create enablement, чтобы `CREATED` не возникал без готового postcondition flow.

## Зависимости и предусловия

Этапы 1–6, 10–11. Production O-005 определяет PO route lifecycle/privacy/fallback. Для тестов — synthetic destinations/fake Telegram adapter.

## Scope

- Notification intents/outbox и per-type idempotency keys.
- Trusted route resolution for Creator original DM, PO Catalog route, admin/TO config.
- Content templates/minimization/redaction.
- Bounded delivery retry/circuit breaker/status/alerts.
- Replay/destination substitution protection.

## Вне scope

Jira POST retry, workflow transitions, arbitrary message tool, user-defined destinations и PO actions through bot.

## Компоненты и файлы

- `packages/idea-to-jira-plugin/src/notifications/notification-service.ts`, `outbox-worker.ts`, `templates.ts`.
- `route-resolver.ts`, `telegram-adapter.ts`, `retry-policy.ts`.
- Notification repositories/delivery attempts/audit.
- Fake Telegram transport and template snapshots.

## Атомарные инженерные задачи

1. Определить types: access request/decision, Creator CREATED/UNKNOWN, PO CREATED, operational alert.
2. Создавать intent transactionally with triggering domain state/outbox; unique key `(event/type/recipient-route-version)`.
3. Creator route — original trusted DM ownership record; PO — exact verified Catalog version/opaque route; admin/TO — server config.
4. Reject destination in model/tool/user/callback params.
5. PO CREATED template: fact, real key/link, short summary, permitted author display/ID policy, standard Jira workflow instruction.
6. Creator UNKNOWN template has no key/link/success claim.
7. Minimize admin cards/errors; no full Draft/Jira response/credentials.
8. Telegram adapter fixed API destination and message schema; raw response redacted.
9. Retry only delivery, bounded count/time/backoff/Retry-After; delivery worker never imports/calls PostingService send method.
10. Delivery state `PENDING/SENDING/DELIVERED/FAILED_RETRYABLE/FAILED_FINAL`; restart recovery idempotent.
11. Missing/invalid PO route after CREATED records failure + alert, does not change Jira operation.
12. Route change after create: use route pinned by catalog version unless approved runbook says otherwise; no silent reroute to user input.
13. Callback/reply from notification cannot grant role/change Jira unless separate authorized handler.
14. Metrics/audit by type/outcome without destination/content labels.
15. Test duplicated outbox events/restarts/concurrent workers with exact send counts.

## Границы данных, состояний и интеграций

Notification stores template version + minimal parameters, not rendered full content where avoidable. Jira key/link only from CREATED record. PO route is opaque server-side data. Telegram failure is independent downstream state.

## Безопасность и надёжность

No arbitrary message tool for model. Destination lock at resolver and adapter. Template escaping protects untrusted summary/display. Failure does not mutate Draft/posting. Repeated worker claims one delivery via transaction lease/idempotency.

## Миграция, rollback и recovery

Template changes versioned; existing intents render pinned version or safe compatible form. Restart reclaims expired sending lease, never creates Jira operation. Rollback preserves delivery records. Catalog route rollback does not rewrite already pinned intent.

## Тесты

### Unit/integration

- Templates contain required/minimal fields and escape untrusted text.
- Creator/PO/admin route resolution and missing route.
- Duplicate intents/concurrent workers → bounded one logical delivery.
- Retry-After/backoff/final alert.

### Security/recovery

- Destination injection/model arbitrary message rejected.
- Raw token/response/private description absent logs/audit.
- Notification retry call count independent of Jira fake transport (zero extra POST).
- Restart during SENDING resumes delivery only.
- PO route missing leaves operation CREATED.

## Проверяемые критерии приёмки

1. Only CREATED emits Creator key/link and PO success.
2. UNKNOWN never emits success/key/link.
3. Notification retry cannot access/create Jira POST.
4. Routes are trusted, versioned and not client-controlled.
5. Missing PO route alerts without rollback of Jira state.

## Exit criteria

- O-005 route lifecycle/fallback/privacy approved or go-live blocked.
- Delivery idempotency/restart/security tests green.
- CREATED synthetic event completes Creator/PO workflow.
- Stage 13 can enable POST only when route readiness passes.

## Трассируемость

BR-008/009/012; FR-005, FR-032, FR-078, FR-083, FR-090—095, FR-100/104/111/112; NFR-015/019/022/030/032/036/037/054/060/070—075/082/090—093/097; D-013/014/016; JC-041—043, contract tests 15–16; O-005.

## Риски, неизвестные и решения

- **Blocker:** verified production PO routes/lifecycle.
- **Decision needed:** permitted author identity detail in PO template under privacy policy.
- **Risk:** Telegram retries may be ambiguous; use local delivery idempotency and conservative duplicate-message handling, never couple to Jira.
- **Assumption:** notification duplicate is less harmful than Jira duplicate, but still bounded/audited.
