# 06. Knowledge Catalog: schema, публикация, импорт и rollback

## Цель и пользовательская ценность

Дать системе проверяемый источник product/route/options/PO mapping, чтобы она предлагала только реальные активные маршруты и не выдумывала команды или destinations. Невалидный Catalog сохраняет Draft editing, но блокирует search/READY/create.

## Почему сейчас

Duplicate narrowing, optional route fields и PO notification зависят от одной immutable версии. Catalog должен быть готов до этих функций, а lifecycle D-012 — закрыт до production publication.

## Зависимости и предусловия

Этапы 1–5. Нужны version/checksum storage и Draft catalog reference. Для production закрыть O-001/O-005; до этого использовать только synthetic signed-off fixtures.

## Scope

- Нормализованная versioned schema и immutable artifact format.
- Build/validate/checksum/publish/import/activate/deprecate/rollback workflow.
- Route matching suggestions и ambiguity handling.
- Jira option references, PO Telegram route references, source/verification metadata.
- Last-known-good activation и expiry alerts.

## Вне scope

Miro online sync, model-generated trusted catalog, произвольное редактирование ботом, Jira create и фактическая PO доставка.

## Компоненты и файлы

- `knowledge/catalog.md` заменить/дополнить machine-readable versioned artifact/fixtures без private production records в Git.
- `src/catalog/schema.ts`, `parser.ts`, `checksum.ts`, `import-service.ts`, `route-service.ts`.
- CLI/operator command или reviewed script для offline build/validation; без secrets.
- Catalog repositories, tests и runbook publication/rollback.

## Атомарные инженерные задачи

1. Закрыть D-012 ADR/decision update: authoritative sources, extractor, reviewer, cadence/trigger, source priority, publication и rollback owner.
2. Определить schema version и records: stable product ID/name/description, stream/domain/team/dev teams, Jira option IDs/labels, PO route ref, keywords/examples, active interval, source refs, verified_at/by.
3. Разделить display text (untrusted data) и control fields; Markdown никогда не меняет policy/tools/config.
4. Определить canonical serialization и checksum, исключив nondeterministic timestamps из hash body либо формализовав их.
5. Validate uniqueness, references, active intervals, exact one PO route where required, no secret/private Jira content.
6. Build immutable artifact; published version не редактируется in place.
7. Import transaction: parse → schema/checksum → semantic validation → option-reference validation status → store full version → atomically activate.
8. Invalid import оставляет last-known-good active и audit/alert.
9. Route service возвращает 0/1/2–3 suggestions; multiple требует user confirmation, zero блокирует.
10. Draft фиксирует catalog_version/checksum; active change помечает route/search stale.
11. Implement deprecation/expiry: Draft editing remains; READY/create fail closed.
12. PO route хранить server-side opaque destination, не отдавать model/user; определить validation/lifecycle/fallback.
13. Rollback активирует ранее проверенную immutable version новым audit event без изменения artifact.
14. Добавить freshness/status diagnostics без записи Catalog contents в logs.
15. Зафиксировать Jira option refs как `UNVERIFIED/VERIFIED/STALE`; только VERIFIED допускает payload.

## Границы данных, состояний и интеграций

Catalog text и source payload недоверен. Parser не исполняет instructions/URLs. Production PO destinations и source details могут храниться вне Git в runtime artifact; Git fixtures synthetic. Jira metadata verifier подтверждает IDs, но не переписывает Catalog silently.

## Безопасность и надёжность

Atomic activation, checksum, immutable versions, size/record/depth limits, no arbitrary fetch. Unknown/inactive/ambiguous route блокирует READY. Destination lock использует opaque route ID. Catalog compromise не даёт tool/config/Jira transport authority.

## Миграция, rollback и recovery

Schema changes требуют new schema/version and migrator/import test; старый active artifact остаётся readable до controlled activation. Rollback — переключение на verified prior version, затем invalidation Draft/search. Restore проверяет checksum до activation.

## Тесты

### Unit/contract

- Canonical checksum stability; malformed/tampered artifact reject.
- Duplicate IDs/broken refs/invalid intervals/missing verification/PO route.
- 0/1/multiple route suggestions и no invented route.
- Prompt injection strings остаются data.

### Integration/security/recovery

- Failed import leaves previous active version.
- Concurrent activate yields one current version/audit sequence.
- Active version change invalidates Draft route/duplicate readiness.
- Production-like artifact fixture contains no real personal destinations/private Jira data.
- Restored artifact must revalidate checksum/schema.

## Проверяемые критерии приёмки

1. У каждого active record есть immutable version/checksum/source verification.
2. Повреждённый/просроченный Catalog не влияет на last-known-good и выключает create по policy.
3. Неоднозначный route показывает максимум 2–3 безопасных варианта и требует решения.
4. Unknown team/value не создаётся моделью.
5. PO destination никогда не задаётся text/tool params.

## Exit criteria

- D-012/O-001 закрыты согласованным lifecycle design для production либо этап отмечен blocked для go-live.
- Synthetic import/activation/rollback tests зелёные.
- Route API готов для Draft/duplicate/notification.
- Jira option state остаётся unverified до этапа 8; create disabled.

## Трассируемость

BR-007/008/010; FR-040—047, FR-051, FR-055, FR-060, FR-091/094, FR-100; NFR-012/016/060/073/082/083/097; D-011—013, D-016; O-001/O-005; JC §7, §9, §14.

## Риски, неизвестные и решения

- **Blocker:** D-012/O-001 lifecycle.
- **Blocker:** O-005 PO route verification/privacy/fallback.
- **Evidence needed:** option IDs validated separately by Jira create metadata, не GET issues.
- **Risk:** source may contain prompt injection/private data; strict schema + minimization + no execution.
