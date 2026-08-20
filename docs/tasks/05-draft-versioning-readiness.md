# 05. Draft, provenance, versioning и READY foundation

## Цель и пользовательская ценность

Дать Guest/Creator полноценный сохраняемый Draft: система помнит подтверждённые данные, различает факты/предложения/unknown, задаёт только нужные вопросы и не теряет изменения при гонках. READY вычисляется детерминированно, но пока не запускает Jira POST.

## Почему сейчас

Catalog, voice, duplicate fingerprint и payload привязаны к точной версии Draft. Сначала нужен стабильный domain contract и CAS, затем интеграционные обогащения.

## Зависимости и предусловия

Этапы 1–4. Canonical Draft enum/schema v1 зафиксированы. Model output доступен только как typed proposal; фактический model route может быть не готов, что не мешает unit/integration через fake extractor.

## Scope

- Полная структура FR-021 и per-field provenance.
- Create/read/patch/cancel собственного Draft.
- CAS versioning, validation, completeness и dependent-result invalidation.
- Deterministic description formatter.
- Readiness evaluator с reasons, жестко не вызывающий transport.
- Ограниченный диалоговый contract вопросов и active Draft limits.

## Вне scope

Voice decoding, Catalog route implementation, Jira metadata/search/payload, posting operations и preview/create button (они запрещены).

## Компоненты и файлы

- `packages/idea-to-jira-plugin/src/domain/draft.ts`, `draft-state.ts`, `provenance.ts`, `readiness.ts`.
- `packages/idea-to-jira-plugin/src/workflow/draft-service.ts` — заменить scaffold DTO полноценным service/repository boundary.
- `packages/idea-to-jira-plugin/src/workflow/description-formatter.ts`, `question-policy.ts`.
- Typed tools own-draft read/patch/request access; schema в `packages/idea-to-jira-plugin/src/index.ts`/manifest tests.
- Persistence repositories и tests/fixtures.

## Атомарные инженерные задачи

1. Определить versioned Draft schema: summary, 8 description sections, required custom business values, route selection, catalog ref, transcript status, duplicate ref, posting ref.
2. Для каждого значения хранить provenance `USER_STATED/USER_CONFIRMED/MODEL_PROPOSED/UNKNOWN/CATALOG_DERIVED` и evidence reference без full duplicate data.
3. Создавать Draft `EDITING`, UUID, owner sender ID, version 1 одной transaction с audit.
4. Read/patch всегда добавляет owner predicate из requester context; client-supplied owner запрещён.
5. Patch schema разрешает только domain fields; unknown/arbitrary Jira fields/JSON отклоняются.
6. CAS `expectedVersion`; conflict возвращает sanitized current version и не теряет update.
7. Классифицировать payload/route/fingerprint-impacting fields и атомарно инвалидировать completeness/READY/duplicate/payload hash refs.
8. Не удалять completed/`UNKNOWN` operations; регистрировать blocker на reuse content.
9. Реализовать content validation: lengths, blank/placeholders, bounded arrays/links, no secret-like values policy без хранения secret в error.
10. Реализовать deterministic description по JC-004; optional empty sections по единому formatter rule.
11. Реализовать completeness reasons и readiness predicate, учитывающий RBAC/transcript/Catalog/metadata/duplicate/operation, но external dependencies передавать typed snapshots.
12. Model proposal не меняет confirmed fact без explicit user confirmation; unknown required field порождает вопрос.
13. Ограничить число вопросов/сообщение и не спрашивать уже confirmed data.
14. Реализовать active Draft limit и cancel без удаления audit.
15. Удалить/переименовать scaffold `JiraIssueDraft.status: ready`, чтобы validation DTO не выглядел как READY state.
16. Не создавать отдельный preview/card/confirmation entity или create callback.

## Границы данных, состояний и интеграций

Domain Draft не содержит HTTP fields/origin/JQL/credentials. Required business values представлены semantic choice IDs до mapper. Model видит минимальную текущую секцию, не весь audit/Jira context. Link validation не делает arbitrary fetch.

## Безопасность и надёжность

Owner check во всех repository operations. Readiness — pure/deterministic evaluator и rechecked later atomically. Role/Catalog/metadata/search failure дают reason `BLOCKED`, а не optimistic READY. Secret-like input не логируется; политика пользовательского контента не должна ложно обещать, что PII отсутствует.

## Миграция, rollback и recovery

Migration может перенести только synthetic scaffold data, но production данных пока нет. Каждая version immutable/history-preserving. Rollback formatter version не изменяет старый payload hash; formatter/schema version участвует в canonicalization позже.

## Тесты

### Unit

- Все fields/provenance transitions и placeholder/length validation.
- Description exact deterministic sections и no hidden marker.
- Completeness/readiness reason matrix.
- Significant vs non-significant patch invalidation.
- Question policy не повторяет confirmed fields.

### Integration/security/recovery

- Concurrent patches: один commit, второй conflict.
- Cross-sender read/patch/cancel → not found/forbidden без data leak.
- Model-proposed required value не даёт READY.
- Role/Catalog/duplicate stale → READY false.
- Restart сохраняет versions/provenance/invalidation.

## Проверяемые критерии приёмки

1. Guest создаёт/редактирует только свой versioned Draft.
2. Каждое meaningful изменение увеличивает version ровно один раз.
3. Stale CAS не перезаписывает данные.
4. Description соответствует JC-004 и не содержит placeholders/operation marker.
5. READY без всех external proofs невозможен и не вызывает POST.

## Exit criteria

- Full Draft schema и formatter version опубликованы в коде/tests.
- Scaffold minimal validator либо адаптирован, либо явно оставлен как intake normalization без ложного READY.
- Catalog/voice/duplicate могут ссылаться на immutable draft version.
- Jira adapter по-прежнему disabled.

## Трассируемость

BR-001/004/011; FR-010, FR-020—028, FR-036, FR-055, FR-060—062, FR-102, FR-110; NFR-030/032/040/043/050/060/062/090; D-001—003, D-020; JC-003—004, JC-030—032.

## Риски, неизвестные и решения

- **Decision needed:** canonical enum conflict должен быть закрыт до реализации.
- **Decision needed:** exact max lengths берутся из config/metadata; до evidence применять conservative config и блокировать oversize.
- **Risk:** provenance слишком coarse; хранить на field/value level, не raw model chain-of-thought.
- **Assumption:** active Draft limit default 3 из NFR-043, конфигурируемый.
