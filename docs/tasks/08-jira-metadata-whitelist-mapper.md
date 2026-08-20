# 08. Jira read metadata, versioned contract и whitelist mapper

## Цель и пользовательская ценность

Получить доказанный read-only snapshot create contract Jira Server 11.3.8 и детерминированно построить разрешённый payload, не отправляя POST. Пользователь не столкнётся с выдуманными полями/options; unknown/stale metadata блокирует READY.

## Почему сейчас

Duplicate search и create должны использовать fixed Jira boundary. Exact custom-field shapes нельзя выводить из GET существующих issues. Сначала проверяется write schema metadata и mapper на fixtures, потом разрешается сеть записи.

## Зависимости и предусловия

Этапы 1–6 (Catalog refs полезны, optional fields могут остаться disabled). Нужны production service account/auth details O-002/O-003 для финального snapshot; разработка начинает с synthetic contract fixtures.

## Scope

- Fixed-origin Jira read client и TLS/redirect/timeouts policy.
- Compatibility/create metadata/options retrieval с actual credential.
- Sanitized immutable snapshot hash/version/freshness.
- Versioned semantic-to-Jira whitelist mapper и canonical payload/hash.
- Required/optional fields, strict unknown reject, no assignee/reporter/transition/correlation.
- Metadata-change circuit breaker/create disable state.

## Вне scope

Duplicate JQL/search, Jira POST, retries after POST, issue mutation и production create enablement.

## Компоненты и файлы

- `src/jira/http-client.ts`, `metadata-client.ts`, `metadata-schema.ts`.
- `src/jira/metadata-snapshot-service.ts`, repositories.
- `src/jira/payload-mapper.ts`, `canonical-json.ts`, mapper versions.
- Contract fixtures generated/sanitized from approved metadata, never private issue data.
- `JIRA_CREATE_CONTRACT.md` update only if evidence changes normative mapping.

## Атомарные инженерные задачи

1. Зафиксировать production origin/auth scheme/path outside public docs; runtime config allows only one HTTPS origin.
2. Implement GET-only transport method allowlist; redirects disabled/cross-origin forbidden; headers never logged.
3. Verify Jira version, project `18100`/`FPF`, Feature `11500`, create permission and standard initial behavior evidence.
4. Retrieve create metadata/options for required and selected optional fields with page/size/time bounds.
5. Parse via strict schemas; unknown/malformed/oversized response fails closed.
6. Store sanitized snapshot: schema shapes, option stable IDs, limits, timestamp, hash, Jira/contract/mapper versions; no issue contents/credential.
7. Mark snapshot `VERIFIED/STALE/INVALID`; freshness policy config and alerts.
8. Implement semantic required values → exact JSON shape for project, issuetype, summary, description and four custom fields.
9. Optional route field appears only when active mapper allowlist + Catalog verified option + metadata permit; otherwise omitted or blocks per contract.
10. Mapper rejects unknown keys, arbitrary JSON, field IDs, option labels without stable ID, placeholders/oversize.
11. Omit assignee/reporter entirely; prohibit status/transition and any local correlation marker.
12. Canonicalize object keys/semantically unordered arrays and compute payload hash; version rules explicit.
13. Compare live snapshot hash to approved baseline; drift disables create until revalidation/contract tests.
14. Separate read metadata scope from Jira issue search scope and future write scope in interfaces/credentials evidence.
15. Keep `DisabledJiraIssueClient` as write implementation.

## Границы данных, состояний и интеграций

Metadata is authoritative for technical shapes/options, normative docs for business-required description/whitelist. GET issues do not prove create schema. Model/user supply semantic choices only, never field IDs/origin/path/method/JQL/header.

## Безопасность и надёжность

SSRF prevented by fixed origin/path builder. Redirect off. Bounded response parser. 401/403 alerts safe code and invalidate readiness. Metadata cache cannot silently outlive version/freshness policy. Canonical payload may be retained only according to data minimization; logs use hash/version, not body.

## Миграция, rollback и recovery

New field/schema requires new contract/mapper version and fixtures. Existing Draft references semantic values; remapping stale metadata requires new readiness computation, not silent mutation. Rollback mapper uses matching approved snapshot version; mismatch disables create.

## Тесты

### Unit/contract

- Exact eight required elements and JSON shape fixtures.
- Allowed/invalid options, summary/description limits.
- Omitted assignee/reporter, no status/transition/correlation.
- Unknown field/arbitrary model JSON rejected.
- Canonical hash stable and changes on material payload change.

### Integration/security

- Fake Jira metadata 200/malformed/oversize/401/403/429/5xx/timeout/redirect.
- Fixed origin/path/method cannot be overridden.
- Snapshot drift/stale → readiness/create gate false.
- Sanitized fixture/log contains no credentials/private issue contents.

## Проверяемые критерии приёмки

1. Metadata snapshot has evidence timestamp/hash/version and exact field shapes.
2. Mapper produces only contract whitelist from semantic Draft/Catalog values.
3. Any unknown/stale/invalid field/option yields no POST-capable payload.
4. No assignee/reporter/correlation/transition in serialized payload.
5. Jira write client remains disabled and tests assert zero POST.

## Exit criteria

- O-002/O-003 закрыты evidence для production enablement либо явно остаются go-live blocker.
- Versioned mapper/fixtures/metadata drift gate ready.
- Duplicate stage gets safe read client base without transport authority expansion.
- Create feature flag still false.

## Трассируемость

BR-004/007/009; FR-046, FR-060, FR-071/074/077; NFR-012—017, NFR-032, NFR-080/082/083, NFR-090—093/097; D-007, D-018—022; JC §2–12, JC-001—032, contract tests 1–8/18; O-002/O-003.

## Риски, неизвестные и решения

- **Blocker/evidence:** exact JSON shapes/options/limits and auth/path with production credential.
- **Risk:** metadata endpoint availability/semantics differ in Jira Server 11.3.8; compatibility test must be authoritative.
- **Assumption:** optional route fields default disabled.
- **Contradiction guard:** read issue fields never substitute create metadata evidence.
