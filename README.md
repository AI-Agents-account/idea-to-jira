# Idea-to-Jira

**Статус: production-oriented scaffold, не готовый MVP; Jira write отключён, реализован только typed draft validation.**

Репозиторий задаёт ориентированный на production каркас выделенного Telegram-бота и выделенного агента OpenClaw. Целевая система должна помогать автору структурировать продуктовую идею, безопасно проверять роль и дубли и создавать Jira `Feature` в фиксированном контуре. Сейчас этот процесс существует только как требования и целевая архитектура: запуск контейнера не даёт готовый пользовательский MVP и не должен получать production-трафик.

## Что реализовано сейчас

- корневой npm workspace и пакет плагина `@idea-to-jira/openclaw-plugin`;
- typed tool `idea_to_jira_validate_draft`, который принимает `summary`, `problem`, `desiredOutcome`, необязательные `evidence` и `labels`;
- проверка обязательных строк, обрезка пробелов, дедупликация списков и детерминированная сборка Draft для `Feature`;
- проверка конфигурации плагина: ключ проекта и необязательный путь к каталогу;
- fail-closed адаптер Jira: любой вызов `createIssue` завершается ошибкой `Jira writes are disabled in the scaffold`;
- unit-тесты Draft service, TypeScript type-check, JSON validator и CI;
- Dockerfile и Compose-каркас выделенного OpenClaw Gateway/CLI с постоянными томами и ограничениями контейнера;
- OpenClaw-конфигурация с отдельным агентом, Telegram DM, peer-scoped сессиями и allowlist из единственного реализованного plugin tool;
- заготовка Knowledge Catalog, намеренно неполная и не пригодная для production-маршрутизации.

## Что ещё не реализовано

- полноценный Telegram-диалог и хранение версионированного Draft;
- приём и локальная транскрипция voice через Whisper `medium`, показ и коррекция транскрипта;
- Guest/Creator/Business Admin RBAC, заявки, выдача и отзыв доступа;
- plugin-owned SQLite, миграции, аудит, retention, backup/restore;
- проверяемый импорт и обновление Knowledge Catalog;
- bounded duplicate search и решение Creator по найденным кандидатам;
- READY predicate, атомарный operation claim и идемпотентность;
- Jira payload mapper по allowlist, POST, обработка ответа и ручная reconciliation состояния `UNKNOWN`;
- уведомления автору, Business Admin и Product Owner;
- production monitoring, alerts, runbooks, security/integration/E2E и performance evidence.

Целевые возможности и принятые ограничения описаны в [бизнес-требованиях](docs/BUSINESS_REQUIREMENTS.md), [функциональных требованиях](docs/FUNCTIONAL_REQUIREMENTS.md), [нефункциональных требованиях](docs/NON_FUNCTIONAL_REQUIREMENTS.md), [контракте Jira create](docs/JIRA_CREATE_CONTRACT.md) и [журнале решений](docs/DECISIONS.md). Текущее и целевое состояние разведены в [архитектуре](ARCHITECTURE.md). Полная последовательность оставшейся реализации и quality gates собрана в [декомпозиции задач](docs/tasks/README.md).

## Роли целевой системы

Эти роли — целевой контракт; текущий scaffold их ещё не реализует.

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
| `docs/` | Нормативные бизнес-, функциональные, нефункциональные требования, решения и Jira create contract. |
| `knowledge/catalog.md` | Неполная fail-closed заготовка каталога, не production-источник маршрутов. |
| `compose.yaml`, `Dockerfile` | Сборка плагина и изолированный запуск Gateway/CLI. |
| `data/state/` | Игнорируемое Git постоянное состояние OpenClaw, включая auth profiles. |
| `data/workspace/` | Игнорируемый Git runtime workspace. |
| `scripts/` | JSON validation, preflight и контейнерный healthcheck. |
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
| `JIRA_BASE_URL` | HTTPS origin целевой Jira без публикации внутреннего адреса в документации. |
| `JIRA_TOKEN` | Runtime credential Jira с минимальными правами. Сейчас plugin его не использует, потому что Jira write отключён, но Compose требует непустое значение. |
| `JIRA_PROJECT_KEY` | Фиксированный ключ проекта; по решениям проекта — `FPF`. Сейчас передаётся в контейнер, а plugin config дополнительно закрепляет тот же ключ server-side. |
| `JIRA_ISSUE_TYPE_ID` | Фиксированный ID типа `Feature`; текущий контракт — `11500`. До реализации mapper переменная не используется для POST. |
| `BUSINESS_ADMIN_TELEGRAM_IDS` | Разделённые запятыми numeric sender IDs доверенных администраторов. Передаётся в контейнер, но RBAC пока не реализован. |
| `KNOWLEDGE_CATALOG_PATH` | Контейнерный путь к каталогу; стандартно `/home/node/.openclaw/workspace/knowledge/catalog.md`. Сейчас plugin config закрепляет этот же путь. |

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
mkdir -p data/state data/workspace data/auth-profile-secrets
```

`data/state` хранит OpenClaw state и auth profiles, а `data/auth-profile-secrets` — локальный encryption key для OAuth-токенов. Для восстановления OAuth нужны оба каталога; не переносите только один из них и не добавляйте их содержимое в Git.

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

Официальная текущая схема OpenClaw использует provider `openai` и canonical model route `openai/*` как для ChatGPT/Codex subscription OAuth, так и для API-key профилей. Для headless Docker выполните device-code вход через предусмотренный сервис `openclaw-cli`:

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

Текущий `config/openclaw.json5` не закрепляет primary model: успешная авторизация сама по себе не доказывает готовность модели для агента. После `models list --provider openai` выберите доступный canonical ID `openai/<model>` и добавьте его в host-файл `config/openclaw.json5`, например:

```json5
agents: {
  defaults: { model: { primary: "openai/<model-from-list>" } },
  list: [
    // существующая конфигурация агента idea-mvp
  ],
},
```

Затем перезапустите Gateway и проверьте effective route:

```bash
docker compose restart openclaw-gateway
docker compose run --rm openclaw-cli models status
```

Не используйте `models set` как основной способ для этого Compose: `config/openclaw.json5` намеренно монтируется read-only, поэтому конфигурацию модели следует менять в отслеживаемом host-файле и проверять отдельным deployment review.

### 4. Собрать и запустить Gateway

```bash
docker compose build --pull openclaw-gateway
docker compose up -d openclaw-gateway
docker compose ps
```

Gateway публикуется только на loopback: `127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}`. Root filesystem контейнера read-only, Linux capabilities сброшены, включён `no-new-privileges`; постоянные данные находятся в `./data/state`, `./data/workspace` и каталоге `OPENCLAW_AUTH_PROFILE_SECRET_DIR`.

### 5. Посмотреть логи и health

```bash
docker compose logs --tail=100 openclaw-gateway
docker compose ps
docker compose exec openclaw-gateway node /app/scripts/healthcheck.mjs
curl --fail --silent --show-error http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/healthz
```

Для непрерывного просмотра логов:

```bash
docker compose logs --follow --tail=100 openclaw-gateway
```

Healthcheck подтверждает только доступность HTTP endpoint Gateway. Он не доказывает готовность Telegram, модели, Knowledge Catalog, RBAC, Jira, уведомлений или end-to-end сценария.

## Безопасность и граница запуска

До появления passing evidence по [нефункциональным требованиям](docs/NON_FUNCTIONAL_REQUIREMENTS.md) scaffold нельзя подключать к production-трафику. Требования к секретам, server-side авторизации, Jira boundary, реакции на компрометацию credential и приватному сообщению об уязвимости закреплены в разделе 3 НФТ. Telegram — недоверенный вход; права, Jira scope, destinations и payload должны проверяться server-side. Реальные Jira, Telegram, OpenAI/OAuth credentials, OpenClaw auth state, Draft/SQLite, транскрипты и пользовательский контент должны оставаться вне Git.
