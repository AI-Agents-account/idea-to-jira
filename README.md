# Idea-to-Jira

**Статус: production-oriented scaffold и controlled Stage-05A text-pilot candidate, не production MVP; Jira write отключён, реализованы Stage-01—05 foundation и fail-closed pilot boundaries.**

Репозиторий задаёт ориентированный на production каркас выделенного Telegram-бота и выделенного агента OpenClaw. Целевая система должна помогать автору структурировать продуктовую идею, безопасно проверять роль и дубли и создавать Jira `Feature` в фиксированном контуре. Сейчас этот процесс существует только как требования и целевая архитектура: запуск контейнера не даёт готовый пользовательский MVP и не должен получать production-трафик.

## Что реализовано сейчас

- корневой npm workspace и пакет плагина `@idea-to-jira/openclaw-plugin`;
- узкие typed tools для create/read/CAS-patch/cancel собственного Draft и access request; прямой Jira create отсутствует;
- versioned Draft schema v1 с immutable versions, per-field provenance, owner predicate, active-Draft limit и audit;
- строгая нормализация/валидация, bounded question policy и детерминированный JC-004 formatter из восьми секций;
- pure fail-closed completeness/readiness evaluator с versioned Catalog/transcript/metadata/duplicate/operation proofs и без transport;
- единая startup-валидация runtime-конфигурации: Telegram account/channel, фиксированный Jira scope, protected env refs, Catalog schema/checksum, allowlist, STT, rate/retention limits и runtime paths;
- fail-closed `before_agent_run` gate и tool-factory gate по trusted OpenClaw context: только user-triggered Telegram DM, agent `idea-mvp`, canonical Telegram account `default`, numeric sender и destination, равный sender;
- process-local token-bucket interface, payload limit и fail-closed security gates;
- versioned typed audit envelope, append-only SQLite writer, атомарный audited-operation boundary, safe error taxonomy и централизованная drop-by-default redaction;
- structured log contract, bounded metric/alert interfaces, раздельные local correlation IDs, retention metadata и access-controlled sanitized audit export;
- явный create-disabled readiness signal и `DisabledJiraIssueClient`: Jira write остаётся недоступен;
- plugin-owned SQLite schema v4, transactional checksum-guarded migrations, versioned Draft backfill, WAL/FK/FULL durability policy, private file modes, startup consistency gate, unit-of-work и online backup primitive;
- durable Guest/Pending/Creator/Suspended/Blocked lifecycle, idempotent access requests, allowlisted Business Admin decisions and Creator grant suspend/restore/revoke/block with CAS/anti-replay;
- typed `/request_access` and `/access` command handlers, fixed server-side Admin destinations, content-free access cards and reusable own-Draft/active-Creator authorization checks;
- unit/security/config/deployment/storage-тесты, TypeScript type-check, JSON/OpenClaw validators и CI;
- Dockerfile и Compose-каркас выделенного OpenClaw Gateway/CLI с постоянными томами и ограничениями контейнера;
- OpenClaw-конфигурация с отдельным агентом, Telegram DM, peer-scoped сессиями и allowlist только из пяти реализованных plugin tools;
- Stage-05A boundary: DM allowlist одного protected numeric sender, повторная plugin-side sender check, explicit audio-understanding disable и offline/live-local readiness;
- pilot runtime не инжектирует Jira credential; disabled adapter и manifest/config gate исключают Jira POST;
- заготовка Knowledge Catalog, намеренно неполная и не пригодная для production-маршрутизации.

## Что ещё не реализовано

- полноценная разговорная orchestration поверх реализованных Draft tools;
- приём и локальная транскрипция voice через Whisper `medium`, показ и коррекция транскрипта;
- Catalog/posting repositories, retention execution, production alert routing и backup scheduling/operations;
- проверяемый импорт и обновление Knowledge Catalog;
- bounded duplicate search и решение Creator по найденным кандидатам;
- подключение live Catalog/metadata/duplicate proofs к реализованному READY predicate, атомарный operation claim и posting orchestration;
- Jira payload mapper по allowlist, POST, обработка ответа и ручная reconciliation состояния `UNKNOWN`;
- уведомления автору, Business Admin и Product Owner;
- production monitoring backend/dashboards, destination routing, runbooks, security/integration/E2E и performance evidence.
- byte-level media rejection до model run: подтверждённый SDK `before_agent_run` context не содержит typed attachment discriminator, поэтому pilot использует disabled audio understanding и operational text-only policy;

Целевые возможности и принятые ограничения описаны в [бизнес-требованиях](docs/BUSINESS_REQUIREMENTS.md), [функциональных требованиях](docs/FUNCTIONAL_REQUIREMENTS.md), [нефункциональных требованиях](docs/NON_FUNCTIONAL_REQUIREMENTS.md), [контракте Jira create](docs/JIRA_CREATE_CONTRACT.md) и [журнале решений](docs/DECISIONS.md). Storage contract, migration/recovery и проверка backup описаны в [руководстве по persistence](docs/STORAGE.md), audit/redaction/telemetry contract — в [Stage-03 baseline](docs/AUDIT_OBSERVABILITY.md), RBAC/access lifecycle — в [Stage-04 contract](docs/RBAC_ACCESS.md), а фактические Draft schema/provenance/CAS/readiness/tool contracts — в [Stage-05 contract](docs/DRAFT_VERSIONING.md). Текущее и целевое состояние разведены в [архитектуре](ARCHITECTURE.md). Полная последовательность оставшейся реализации и quality gates собрана в [декомпозиции задач](docs/tasks/README.md). Контролируемый внешний smoke выполняется только по [Stage-05A runbook](docs/LIVE_TEXT_PILOT.md).

## Роли целевой системы

Guest/Creator/Business Admin access lifecycle реализован в Stage 04; Product Owner, Technical Owner и Catalog-owner строки описывают целевой контракт следующих этапов.

| Роль | Назначение |
| --- | --- |
| **Guest** | Готовит собственный Draft и запрашивает допуск, но не видит детали Jira-дублей и не создаёт задачу. |
| **Creator** | Guest с активным допуском; принимает решение по дублям, после чего готовый Draft может автоматически перейти к create без отдельной кнопки или preview. |
| **Business Admin** | Server-side подтверждает доверие к точному Telegram sender ID, выдаёт/отзывает Creator и работает с санитаризированным аудитом. Не получает доступ к хосту или секретам. |
| **Product Owner (PO)** | Получает уведомление после подтверждённого create и продолжает стандартный процесс в Jira. |
| **Technical Owner** | Развёртывает систему, управляет секретами, backup/restore и вручную разбирает `UNKNOWN`. |
| **OpenClaw — владелец Catalog** | В целевой схеме публикует проверяемые версии Knowledge Catalog; сам процесс обновления каталога пока остаётся отдельным открытым дизайном. |

## Структура репозитория

| Путь | Содержимое |
| --- | --- |
| `package.json`, `package-lock.json` | Корневой private npm workspace, scripts и зафиксированное дерево зависимостей. |
| `packages/idea-to-jira-plugin/` | Исходники, manifest, TypeScript-конфигурация и unit-тесты плагина. |
| `config/openclaw.json5` | Выделенный агент, Telegram account/binding, tool allowlist, plugin loading и token-auth Gateway. |
| `docs/` | Нормативные требования, решения, Jira create, storage и audit/observability contracts. |
| `knowledge/catalog.md` | Неполная fail-closed заготовка каталога, не production-источник маршрутов. |
| `compose.yaml`, `Dockerfile` | Сборка плагина и изолированный запуск Gateway/CLI. |
| `data/state/` | Игнорируемое Git постоянное состояние OpenClaw, включая auth profiles. |
| `data/workspace/` | Игнорируемый Git runtime workspace. |
| `scripts/` | JSON validation, preflight, контейнерный healthcheck и target-container storage check. |
| `tests/fixtures/` | Публичные тестовые данные без production-содержимого. |

## Пакеты и зависимости

Репозиторий использует npm workspaces (`packages/*`). Корневой пакет `idea-to-jira@0.1.0` приватный и собственных runtime/dev dependencies не объявляет; его scripts делегируют сборку, type-check и тесты workspace-пакету.

Пакет `@idea-to-jira/openclaw-plugin@0.1.0` по фактическим `package.json` и lock-файлу содержит:

| Категория | Зависимость | Версия | Для чего используется |
| --- | --- | --- | --- |
| Runtime | `typebox` | `1.3.6` | Typed schema параметров OpenClaw tool. |
| Development | `@types/node` | `24.3.0` | Типы Node.js. |
| Development | `openclaw` | `2026.7.1-2` | Plugin SDK для компиляции и тестов. |
| Development | `typescript` | `5.9.2` | Строгая компиляция в `dist/`. |
| Peer | `openclaw` | `>=2026.7.1-2` | Контракт совместимости с host OpenClaw. |

Docker build устанавливает production dependencies плагина с `npm install --omit=dev`; сам OpenClaw приходит из отдельно закреплённого образа `ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}`. Требуется Node.js `>=24.15.0 <25`; CI и Docker build используют Node.js `24.19.0`.

## Практический Docker quickstart

### Предпосылки

- Git;
- Docker Engine с Compose v2 (`docker compose version`);
- для локальных npm-проверок — Node.js `>=24.15.0 <25` и npm;
- отдельный Telegram bot token от BotFather;
- доступ к целевым OpenAI/ChatGPT и Jira учётным данным только через локальный `.env`/защищённое хранилище.

Не публикуйте реальные значения в commit, issue, логах или сообщениях. `.env` и `data/**` исключены из Git, но это не заменяет внешний secret manager для production.

### 1. Подготовить окружение

```bash
cp .env.example .env
```

Заполните `.env` локально:

| Переменная | Значение |
| --- | --- |
| `OPENCLAW_VERSION` | Проверенный tag OpenClaw; scaffold по умолчанию закрепляет `2026.7.1-2`. Для production tag и image digest фиксируются в release record. |
| `OPENCLAW_GATEWAY_PORT` | Необязательный loopback-порт хоста для Gateway; по умолчанию `18789`. Не открывайте его на публичном интерфейсе. |
| `OPENCLAW_AUTH_PROFILE_SECRET_DIR` | Host-каталог с локальным encryption key для OAuth-backed auth profiles; по умолчанию `./data/auth-profile-secrets`. Должен монтироваться и в Gateway, и в CLI, храниться вне Git и резервироваться отдельно от config/state. |
| `OPENCLAW_GATEWAY_TOKEN` | Новый длинный случайный token только для этого Gateway. |
| `TELEGRAM_BOT_TOKEN` | Token отдельного бота от BotFather. |
| `TELEGRAM_PILOT_SENDER_ID` | Единственный numeric Telegram sender ID для controlled DM pilot; тот же ID повторно проверяет plugin runtime. |
| `OPENAI_MODEL` | Reviewed canonical route `openai/<available-model>` для агента. Placeholder из `.env.example` не live-ready. |
| `JIRA_BASE_URL` | HTTPS origin целевой Jira без публикации внутреннего адреса в документации. |
| `JIRA_TOKEN` | **Не задавать для Stage-05A.** Compose не инжектирует Jira credential; pilot не делает Jira GET/POST. |
| `BUSINESS_ADMIN_TELEGRAM_IDS` | Разделённые запятыми numeric sender IDs доверенных администраторов. Controlled one-actor pilot требует включить `TELEGRAM_PILOT_SENDER_ID`; только allowlisted host-derived IDs могут выполнять Stage-04 transitions. |
| `PRODUCT_OWNER_TELEGRAM_IDS` | Server-side allowlist numeric Telegram destinations для будущих PO notifications; startup проверяет формат и непустое значение. |

Jira project/type (`FPF`/`18100`, `Feature`/`11500`), Catalog path/checksum и `writeMode: "disabled"` закреплены server-side в plugin config и не имеют environment override. Для pilot оставьте `JIRA_BASE_URL=https://jira.invalid` и не добавляйте Jira credential.

Сгенерировать Gateway token можно локально одним из способов:

```bash
openssl rand -hex 32
```

или, при установленном Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Скопируйте результат только в `OPENCLAW_GATEWAY_TOKEN` внутри `.env`; не вставляйте его в командную историю, issue или документацию.

Создайте постоянные runtime-каталоги до первого запуска:

```bash
mkdir -p data/state data/workspace data/plugin-state data/auth-profile-secrets
```

`data/state` хранит OpenClaw state и auth profiles, а `data/auth-profile-secrets` — локальный encryption key для OAuth-токенов. Для восстановления OAuth нужны оба каталога; не переносите только один из них и не добавляйте их содержимое в Git.

Compose передаёт весь `.env` непосредственно в Gateway и CLI-контейнеры через `env_file`. Поэтому `scripts/pilot-up.sh` и container entrypoint независимо отклоняют `JIRA_TOKEN` и `OPENAI_API_KEY`: Stage-05A использует только ChatGPT/Codex OAuth и не допускает Jira credential даже в пустом виде.

### Однокомандный controlled pilot

После заполнения `.env` запустите:

```bash
./scripts/pilot-up.sh
```

На хосте нужны только Docker и Docker Compose v2; локальные Node.js и npm не требуются. Скрипт проверяет Compose, собирает image, валидирует инжектированный environment внутри Node-enabled контейнера, поднимает Gateway, предлагает интерактивный OpenAI device-code OAuth при отсутствии сохранённого OAuth-профиля, перезапускает Gateway после входа и запускает health/pilot/create-disabled gates. При любой ошибке после старта Gateway автоматически останавливается. Повторный запуск использует OAuth-профиль из persistent mounts и не требует нового входа.

Если Node.js/npm всё же установлены, доступен эквивалентный alias `npm run pilot:up`. Development preflight (`scripts/preflight.sh`) остаётся отдельной проверкой исходников и не требуется для операторского запуска уже проверенной ревизии.

Остановка без удаления состояния:

```bash
npm run pilot:down
```

Команды ниже остаются детальной ручной процедурой и диагностическим справочником.

### 2. Проверить исходники и Compose

```bash
npm ci
npm run validate:json
npm run check
npm run build
docker compose --env-file .env config --quiet
```

Для проверки только шаблона без production-секретов:

```bash
docker compose --env-file .env.example config --quiet
```

### 3. Авторизовать ChatGPT/OpenAI по подписке

Официальная текущая схема OpenClaw использует provider `openai` и canonical model route `openai/*` как для ChatGPT/Codex subscription OAuth, так и для API-key профилей. `./scripts/pilot-up.sh` сам запускает device-code вход в уже поднятом Gateway, если сохранённый OAuth-профиль отсутствует. Для отдельного ручного входа используйте сервис `openclaw-cli`:

```bash
docker compose run --rm openclaw-cli models auth login --provider openai --device-code
```

Откройте показанный URL/код на доверенном устройстве и завершите вход в нужный ChatGPT-аккаунт. Сервисы `openclaw-cli` и `openclaw-gateway` используют одинаковые постоянные mounts:

- `./data/state` → `/home/node/.openclaw` — state и auth profiles;
- `${OPENCLAW_AUTH_PROFILE_SECRET_DIR}` → `/home/node/.config/openclaw` — локальный encryption key для OAuth token material.

Поэтому профиль переживает удаление одноразового CLI-контейнера и перезапуск Gateway. OAuth backup/restore обязан сохранять оба каталога вместе; их содержимое нельзя добавлять в Git, выводить в логи или передавать модели.

Для нескольких аккаунтов задавайте canonical profile ID с provider prefix, например:

```bash
docker compose run --rm openclaw-cli models auth login --provider openai --device-code --profile-id openai:work
```

Проверка профиля и доступных моделей:

```bash
docker compose run --rm openclaw-cli models auth list --provider openai
docker compose run --rm openclaw-cli models status
docker compose run --rm openclaw-cli models list --provider openai
```

API key — отдельная схема OpenAI Platform с usage-based оплатой; она не использует квоту подписки ChatGPT. Выбирайте её осознанно и храните key как runtime secret. Новые конфигурации и модели используют provider/model prefix `openai/*`; `openai-codex:*` — устаревший формат идентификаторов auth profile, а `openai-codex/*` — legacy model route. Для миграции существующего состояния применяется официальный `openclaw doctor --fix`, но не запускайте исправление без backup и просмотра плана изменений.

Текущий `config/openclaw.json5` закрепляет primary model через deployment value `OPENAI_MODEL`; успешная авторизация сама по себе всё равно не доказывает entitlement. После `models list --provider openai` выберите доступный canonical ID и задайте в `.env`:

```bash
OPENAI_MODEL=openai/<model-from-list>
```

Затем перезапустите Gateway и проверьте effective route:

```bash
docker compose restart openclaw-gateway
docker compose run --rm openclaw-cli models status
```

Не используйте `models set` как основной способ выбора deployment route: launcher один раз создаёт writable runtime-копию `data/config/openclaw.json5` из reviewed `config/openclaw.json5`, чтобы OAuth мог безопасно создать lock/update metadata; route по-прежнему задаётся environment и проверяется readiness.

### 4. Собрать и запустить Gateway

```bash
docker compose build --pull openclaw-gateway
docker compose up -d openclaw-gateway
docker compose ps
```

Gateway публикуется только на loopback: `127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}`. Root filesystem контейнера read-only, Linux capabilities сброшены, включён `no-new-privileges`; постоянные данные находятся в `./data/config`, `./data/state`, `./data/workspace`, `./data/plugin-state` и каталоге `OPENCLAW_AUTH_PROFILE_SECRET_DIR`.

### 5. Посмотреть логи и health

```bash
docker compose logs --tail=100 openclaw-gateway
docker compose ps
docker compose exec openclaw-gateway node /app/scripts/healthcheck.mjs
docker compose exec openclaw-gateway node /app/scripts/pilot-readiness.mjs
curl --fail --silent --show-error http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/healthz
# Ожидаемо non-zero, пока Jira write закрыт:
docker compose exec openclaw-gateway node /app/scripts/create-readiness.mjs
```

Для непрерывного просмотра логов:

```bash
docker compose logs --follow --tail=100 openclaw-gateway
```

Healthcheck подтверждает только liveness HTTP endpoint Gateway. `pilot-readiness.mjs` локально проверяет controlled DM/model/tool/Jira-disabled boundaries и через authenticated loopback Gateway RPC требует `READY` именно от активного поколения plugin runtime с healthy storage; отдельное открытие SQLite не считается runtime-readiness. Скрипт не вызывает Telegram, OpenAI или Jira. Отдельный `create-readiness.mjs` намеренно возвращает `CREATE_DISABLED` и non-zero до реализации всех create preconditions; pilot readiness не подменяет create-readiness.

## Безопасность и граница запуска

До появления passing evidence по [нефункциональным требованиям](docs/NON_FUNCTIONAL_REQUIREMENTS.md) scaffold нельзя подключать к production-трафику. Требования к секретам, server-side авторизации, Jira boundary, реакции на компрометацию credential и приватному сообщению об уязвимости закреплены в разделе 3 НФТ. Telegram — недоверенный вход; права, Jira scope, destinations и payload должны проверяться server-side. Реальные Jira, Telegram, OpenAI/OAuth credentials, OpenClaw auth state, Draft/SQLite, транскрипты и пользовательский контент должны оставаться вне Git.
