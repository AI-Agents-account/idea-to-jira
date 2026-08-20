# 11. Manual reconciliation и restart recovery

## Цель и пользовательская ценность

После crash/timeout не создавать дубль: unsafe in-flight operation становится `UNKNOWN`, Technical Owner получает защищённую процедуру проверки, а Jira issue связывается только при однозначном evidence. Пользователь видит честный статус без выдуманного key.

## Почему сейчас

Reconciliation является обязательной защитой до включения Jira POST. Она строится поверх durable operation state и должна быть проверена на fake transport до реальной сети.

## Зависимости и предусловия

Этапы 1–3 и 10. Для production закрыть O-007: actor authority, evidence threshold, manual resolution/new-send approval trail. Jira read client должен поддержать только bounded reconciliation search.

## Scope

- Startup scan/recovery `POSTING`/incomplete attempts.
- Conservative proof-not-sent rules.
- Protected Technical Owner reconciliation query/decision interface.
- Evidence references, transition UNKNOWN→CREATED or MANUAL_RESOLUTION_REQUIRED/blocked.
- Creator/owner safe status and operational alerts.
- Runbook and restart/crash fault tests.

## Вне scope

Automatic POST retry from UNKNOWN, automatic candidate linking, hidden correlation field, routine Jira create transport и arbitrary issue search.

## Компоненты и файлы

- `packages/idea-to-jira-plugin/src/reconciliation/startup-recovery.ts`, `reconciliation-service.ts`, `evidence.ts`.
- `packages/idea-to-jira-plugin/src/reconciliation/jira-search.ts` fixed bounded operator query.
- Technical Owner deterministic CLI/admin handler with strong server-side authorization.
- Runbook `docs/runbooks/unknown-reconciliation.md` без private examples.
- Fault-injection/restart integration harness.

## Атомарные инженерные задачи

1. На startup lock posting intake до migration/consistency/recovery scan.
2. Найти `POSTING`/incomplete attempts; если durable marker доказывает network never started, перевести в safe pre-send state по policy; иначе `UNKNOWN`.
3. Никогда не вызывать transport из startup recovery.
4. Создать alert/outbox for each new/aged UNKNOWN with opaque operation ID/error code.
5. Авторизовать reconciliation только Technical Owner server-side credential/allowlist; Telegram user/model role insufficient.
6. Read operation view: timestamps, payload hash, mapper/metadata/catalog versions, sanitized business fingerprints; no credentials/raw body.
7. Fixed bounded Jira search by project/type/time and approved business attributes; no arbitrary JQL/URL/fields.
8. Require explicit evidence references and exact real issue ID/key for `FOUND_MATCH`; service independently validates issue scope.
9. Atomic transition UNKNOWN→CREATED only if one current decision and validated evidence; enqueue standard notifications once.
10. `NO_PROOF/AMBIGUOUS` keeps automatic create blocked and records manual status.
11. Separate exceptional authorization of a future new send from retry; define new auditable operation/approval trail only after O-007, never automate.
12. Reject replay/concurrent conflicting reconciliation decisions via version/CAS.
13. User status for UNKNOWN contains no assumed key/link; after proven match only real key.
14. Audit actor/evidence reference/decision/time and reconciliation age metric.
15. Test repeated restarts, process kills at each transport phase, malformed evidence and role spoofing.

## Границы данных, состояний и интеграций

Reconciliation reads production Jira separately from create path. Local hash/operation/time narrows investigation but is never sufficient identity. Operator evidence is referenced, not copied with private Jira content into public logs/docs.

## Безопасность и надёжность

Fail closed on ambiguous/multiple/no candidates. Operator cannot type arbitrary origin/JQL. Unknown stays durable across restart/Draft edits. Concurrent reconciliation first valid commit wins. Automatic scheduler cannot select UNKNOWN.

## Миграция, rollback и recovery

Startup recovery versioned; rollback must recognize unknown newer records and freeze create. Reconciliation audit immutable. Backup restore with stale in-flight operation reruns conservative scan and cannot POST.

## Тесты

### Unit/integration

- Recovery matrix for NOT_STARTED vs MAY_HAVE_SENT vs missing marker.
- UNKNOWN→CREATED only valid key/id/scope/evidence.
- NO_PROOF/AMBIGUOUS remains blocked.
- Replay/concurrent decisions.

### Crash/security/E2E

- Kill before claim/after claim/before send/during send/after response before commit.
- Repeated restarts + repeated READY/user message → no additional fake POST.
- Spoofed Technical Owner/model input rejected.
- Bounded reconciliation search cannot accept arbitrary query.
- Restored backup with POSTING → safe UNKNOWN/no send.

## Проверяемые критерии приёмки

1. Startup never sends Jira POST.
2. Unsafe/unprovable in-flight operations become UNKNOWN.
3. UNKNOWN remains no-key/no-success until validated manual evidence.
4. Repeated restart/actions preserve exact no-auto-retry invariant.
5. Every manual decision is actor/version/evidence audited.

## Exit criteria

- O-007 runbook approved for production or go-live explicitly blocked.
- Crash matrix green with exact transport counters.
- Technical Owner interface and authorization tested.
- Create still disabled; reconciliation dependency satisfied for stage 13.

## Трассируемость

BR-012; FR-075/076, FR-083—086, FR-090, FR-103/104; NFR-030/033—039/071—073/084/093/094/097; D-007—010; JC-040—053, contract tests 13/14/17; O-007.

## Риски, неизвестные и решения

- **Blocker:** O-007 authority/evidence/new-send policy.
- **Risk:** search result coincidence without correlation field; threshold must prefer unresolved over false match.
- **Assumption:** no automatic resolution even with one candidate; operator explicitly verifies.
- **Refinement:** `MANUAL_RESOLUTION_REQUIRED` may be posting substate, but never eligible for automatic send.
