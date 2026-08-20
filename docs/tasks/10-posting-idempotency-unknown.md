# 10. Posting state machine, atomic claim, idempotency и `UNKNOWN`

## Цель и пользовательская ценность

Гарантировать, что готовый payload порождает не более одной локальной posting operation, concurrent events не делают двойной запрос, а неоднозначный результат всегда блокирует автоматизацию. На этом этапе transport fake/disabled: production POST ещё невозможен.

## Почему сейчас

Atomic claim и failure semantics должны быть доказаны до подключения Jira POST. Иначе тестирование реального adapter уже может создать дубли.

## Зависимости и предусловия

Этапы 1–5, 8–9 и audit baseline 3. Canonical posting enum schema v1 согласована. RBAC предоставляет role recheck, mapper — immutable payload/hash, duplicate — current proof.

## Scope

- Pure readiness evaluator + transactional recheck/claim.
- Unique operation/idempotency key and attempt ledger.
- Posting transition service and transport phase classification.
- `FAILED_RETRYABLE/FAILED_FINAL/UNKNOWN` semantics.
- Automatic trigger orchestration без model tool/button/preview.
- Fake transport and exhaustive concurrency/error tests.

## Вне scope

Production Jira HTTP POST, manual reconciliation UI/runbook, PO notification delivery и enable flag true.

## Компоненты и файлы

- `src/posting/readiness-claim-service.ts`, `posting-service.ts`, `state-machine.ts`.
- `src/posting/idempotency.ts`, `transport-result.ts`, `retry-policy.ts`.
- Operation repositories/transactions, audit/outbox.
- Deterministic fake Jira transport with request counters/fault injection.

## Атомарные инженерные задачи

1. Зафиксировать allowed operation transitions and invariants; unknown enum fails closed.
2. Compute local unique key from `draft_id + draft_version + payload_hash`; operation UUID отдельный.
3. In one transaction re-read owner, active Creator, exact Draft version, transcript accepted, Catalog/metadata current, duplicate decision, mapper result and blockers.
4. В той же transaction insert/claim unique operation and transition Draft `READY→POSTING`; existing operation возвращается без new transport.
5. Immediately before transport recheck active Creator and feature gate; failure before network → safe final/cancel state with zero send.
6. Separate transport phases `NOT_STARTED/CONNECTING/REQUEST_MAY_HAVE_BEEN_SENT/RESPONSE_VALIDATED`; conservative unknown classification.
7. Record attempt count/timestamps/error code without raw body/header.
8. Valid synthetic response with real-format ID/key → `CREATED`; malformed/partial success after potential send → `UNKNOWN`.
9. 4xx validation → `FAILED_FINAL`; corrected Draft requires new version/full checks.
10. 401/403 → operational block, no user retry.
11. Retryable only when adapter proves request not accepted/not sent; bounded attempts/backoff/Retry-After. Any uncertainty → `UNKNOWN`.
12. `UNKNOWN` key/id remain null; block same Draft/payload and all automatic new operations with equivalent content according to documented guard.
13. No transition `UNKNOWN→POSTING`; no user/model API can request retry.
14. Automatic trigger is internal domain event after READY/decision, not exposed create tool/callback.
15. Enqueue notifications only on durable `CREATED`; no delivery in this stage beyond outbox fixture.
16. Add concurrency/fault tests asserting exact transport call count.

## Границы данных, состояний и интеграций

Payload generated server-side and immutable for operation. Transport interface accepts only prebuilt validated payload + fixed runtime config, not model args. Local idempotency is not advertised as Jira support. Jira key absent until validated response.

## Безопасность и надёжность

Fail closed on DB/audit/role/config drift. Process abort after potential send is unsafe and recovered later as `UNKNOWN`. Retry scheduler filters only proven safe states; `UNKNOWN` never eligible. No LLM directs transitions.

## Миграция, rollback и recovery

Schema from stage 2; unknown in-flight behavior tested but startup reconciliation implemented stage 11. Rollback binary encountering new operation version must stop create. Completed/UNKNOWN records never deleted on Draft edits.

## Тесты

### Unit/state machine

- Every allowed/forbidden transition.
- Readiness missing/stale reason → zero claim/send.
- Idempotency key/hash and canonical payload version.
- Error classification matrix conservative default UNKNOWN.

### Concurrency/integration/security

- N concurrent READY events → one operation, one fake send.
- Role revoke/config/catalog/metadata change around claim/pre-send → zero unsafe send.
- Timeout after may-send → UNKNOWN; repeated event/message/retry scheduler → same operation, zero additional sends.
- Malformed success → UNKNOWN/no key/link.
- 4xx correction requires new version; no reuse operation.
- Model tool list contains no create/retry.

## Проверяемые критерии приёмки

1. Atomic claim and READY check share one transaction.
2. Unique tuple prevents duplicate operation under concurrency.
3. `UNKNOWN` never has key and never reaches automatic send.
4. Only proven pre-send failures enter retryable budget.
5. Production transport remains disabled and test asserts no external write.

## Exit criteria

- State machine/error matrix/concurrency tests green.
- Fake transport call-count evidence preserved in CI.
- No direct create/retry surface exposed.
- Stage 11 can recover durable operations; create flag false.

## Трассируемость

BR-004/012; FR-036, FR-060—086, FR-102—104; NFR-012/030—038/053/070—075/090—094; D-001—003, D-007—009; JC §3–4, JC-030—053, contract tests 8–14/17–18.

## Риски, неизвестные и решения

- **Decision needed:** canonical `PENDING/CLAIMED` naming before schema; semantics must preserve no-network boundary.
- **Risk:** HTTP library cannot prove not-sent for many failures; classify UNKNOWN by default.
- **Assumption:** equivalent-content block at least exact tuple; broader dedupe policy must not allow bypass by no-op edits.
- **Blocker:** production POST remains disabled until stages 11–12 and audit/reconciliation gates pass.
