# 09. Bounded duplicate search и решение Creator

## Цель и пользовательская ценность

Предупредить очевидные дубли, показав активному Creator только минимально необходимые кандидаты в фиксированном Jira scope. Guest не видит Jira details, ошибка поиска не трактуется как отсутствие дублей, а решение связано с точной версией Draft/Catalog.

## Почему сейчас

Поиск зависит от RBAC, Draft fingerprint, Catalog narrowing и Jira read boundary. Он обязателен до READY/create и не должен расширять полномочия модели.

## Зависимости и предусловия

Этапы 1–6 и 8. O-004 должен дать query template/limits до production; synthetic Jira search fixture позволяет реализовать безопасный интерфейс раньше.

## Scope

- Server-side search plan builder из Catalog/Draft.
- Fixed project/type/status scope, bounded pages/candidates/fields/timeouts.
- Candidate minimization/scoring explanation без full private contents.
- Decisions `DUPLICATE_SELECTED/NOT_DUPLICATE/NEEDS_CLARIFICATION/NO_CANDIDATES`.
- Fingerprint/version binding, invalidation, privacy/rate limits.

## Вне scope

Arbitrary JQL, embeddings backend, Guest details, issue updates/link creation в Jira и Jira POST.

## Компоненты и файлы

- `packages/idea-to-jira-plugin/src/duplicates/search-plan.ts`, `jira-search-client.ts`, `fingerprint.ts`.
- `duplicate-service.ts`, `candidate-view.ts`, `decision-service.ts`.
- Catalog/Draft/RBAC repositories; typed Creator-only tool.
- Sanitized synthetic Jira fixtures и query contract tests.

## Атомарные инженерные задачи

1. Определить versioned fingerprint из material Draft fields + catalog version + mapper/search-plan versions.
2. Catalog narrowing возвращает only verified product/route/keywords server-side; unknown route blocks search readiness.
3. Build fixed JQL/REST parameters internally: project FPF, approved issue types/status scope; no raw user/model clauses.
4. Enforce hard limits candidates/pages/fields/timeout/response bytes and Jira rate budget.
5. Fetch only key, safe link basis, summary and minimal approved comparison fields; description fragment optional and bounded/redacted.
6. Check active Creator before query and before revealing result; Guest receives neutral status only.
7. Store sanitized result metadata/candidate references, not full Jira body; bind to draft ID/version/catalog/checksum/fingerprint.
8. If no candidates after successful complete bounded search, persist `NO_CANDIDATES` atomically.
9. If candidates, show bounded list + deterministic/sanitized similarity reason; require Creator `DUPLICATE_SELECTED`, `NOT_DUPLICATE` or `NEEDS_CLARIFICATION`.
10. Bind callback/action to actor/chat/check/version/candidate allowlist; anti-replay and CAS.
11. `DUPLICATE_SELECTED` stores real existing key/reference and transitions Draft to non-create path.
12. Draft/Catalog/search-policy change invalidates result/decision and blocks READY.
13. Any timeout/partial page/malformed response/401/403/429/5xx is error, never `NO_CANDIDATES`.
14. Rate-limit search per sender/global and circuit-break Jira read separately from create.
15. Audit only fingerprint/result counts/decision/error codes; no candidate summaries.

## Границы данных, состояний и интеграций

Search is Jira read metadata distinct from create contract. Model may help explain normalized similarity only on bounded safe fields; it cannot build JQL, choose hidden candidates or decide duplicate for user. Link uses trusted Jira origin and validated existing key.

## Безопасность и надёжность

Role revoke before response suppresses details. Candidate IDs in callbacks are opaque and server-bound. Partial/truncated search fails closed. Search failure preserves Draft. `DUPLICATE_SELECTED` never triggers Jira modification and does not imply new issue created.

## Миграция, rollback и recovery

Search policy/fingerprint version changes make old checks stale. Rollback binary must fail closed on unknown fingerprint version. Restart preserves decision; stale/unfinished checks become failed/stale, not no-candidates.

## Тесты

### Unit/contract

- Exact fixed search plan and hard limits.
- Arbitrary JQL/origin/project/field/status injection rejected/ignored with failure.
- Fingerprint stability/change matrix.
- Decision transitions and candidate allowlist.

### Integration/security/recovery

- Guest/revoked role → no query details/no reveal.
- 0 candidates only after complete success.
- Partial page/timeout/429/5xx/malformed response → fail closed.
- Draft/Catalog mutation invalidates check/decision.
- Restart/concurrent decisions yield one valid outcome.

## Проверяемые критерии приёмки

1. Search request невозможно расширить client/model input.
2. Guest ни в одном response/log/audit не видит key/link/summary/score.
3. Candidate results bounded and minimized.
4. READY разрешён только current `NOT_DUPLICATE` или `NO_CANDIDATES`.
5. Search error/partial result никогда не становится `NO_CANDIDATES`.

## Exit criteria

- O-004 query/limits evidence зафиксированы либо production enablement blocked.
- Duplicate state/version/fingerprint tests зелёные.
- `DUPLICATE_SELECTED` завершает Draft без create.
- Jira POST всё ещё невозможен.

## Трассируемость

BR-005—007; FR-050—056, FR-060—062, FR-100/104/110—112; NFR-012/015—017/030/036/037/042/043/053/060/070—073/090—093/097; D-005/006; JC §3, §14, contract tests 9–11; O-004.

## Риски, неизвестные и решения

- **Blocker/evidence:** exact limits/query/status scope после production load test.
- **Risk:** Jira summary itself may be private/prompt-injecting; minimize, escape and never treat as instruction.
- **Assumption:** no embedding service in MVP; scoring can be deterministic/bounded model assistance without new backend.
- **Refinement:** selected duplicate link is existing issue identity, not create success.
