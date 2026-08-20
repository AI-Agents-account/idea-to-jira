# 07. Voice intake и локальный Whisper `medium`

## Цель и пользовательская ценность

Позволить пользователю отправить voice в Telegram DM, увидеть распознанный текст, исправить/принять его и только затем использовать как подтверждённый ввод Draft. Ошибка STT не портит существующий Draft и не приближает create.

## Почему сейчас

Voice изменяет Draft version и readiness, поэтому строится поверх persistence/provenance. Он независим от Jira и может быть принят до duplicate/create.

## Зависимости и предусловия

Этапы 1–5. На production host должны быть доказаны runtime/model/resources; до evidence feature может быть выключена config gate с текстовым fallback.

## Scope

- Telegram voice-only media acceptance и bounded download.
- Local Whisper `medium` adapter/worker.
- Transcript states, review/correction/confirmation.
- Temporary raw audio lifecycle и short retention.
- Queue, rate/capacity/circuit breaker, cancellation и safe errors.

## Вне scope

Другие attachments, cloud STT, smaller-model silent fallback, сохранение audio в Git/backups и automatic Jira progression from unreviewed transcript.

## Компоненты и файлы

- `packages/idea-to-jira-plugin/src/voice/telegram-voice-handler.ts`, `whisper-adapter.ts`, `transcript-service.ts`, `queue.ts`.
- Runtime config/Compose/Dockerfile для local model/runtime и bounded temp storage.
- Transcript persistence/ref в Draft.
- Integration fixtures synthetic and non-personal; no committed audio unless explicitly synthetic/licensed and minimal.

## Атомарные инженерные задачи

1. Принимать только Telegram voice media из valid DM context; files/images/video получают deterministic refusal.
2. Проверять declared/actual media type, size, duration и download bounds до expensive work.
3. Сохранять raw audio только в restricted temporary path, random name, no user filename/path traversal.
4. Queue work per sender/global limits; ack ≤2s target без обещания готового transcript.
5. Запускать только local Whisper model exactly `medium`; startup readiness проверяет model files/runtime.
6. Изолировать worker/process, timeout/memory/cpu limits и graceful cancellation.
7. Создавать transcript record `PENDING/PROCESSING/REVIEW_REQUIRED/ACCEPTED/FAILED/EXPIRED` с draft/version binding.
8. Не patch Draft автоматически до user correction/acceptance; accepted text проходит normal Draft typed proposal/provenance path.
9. Correction создаёт новую Draft version и сохраняет minimal transcript provenance.
10. STT failure оставляет Draft unchanged, даёт text/retry option и audit safe code.
11. Удалять raw audio сразу после safe completion либо короткого bounded retry window; срок утвердить в privacy runbook.
12. Исключить raw audio из logs, SQLite, backups и model provider; transcript text следует Draft retention.
13. Circuit breaker/queue pressure не блокирует Gateway event loop.
14. Добавить capacity metrics без media/user labels.

## Границы данных, состояний и интеграций

Raw Telegram file never enters model context. Whisper local output — untrusted text до review. Transcript accepted state связан с exact Draft version; поздняя completion для stale/cancelled Draft не применяется автоматически.

## Безопасность и надёжность

Path traversal, decompression/media bombs, oversized/duration abuse, concurrent jobs и stale callbacks fail closed. Temporary directory `0700`, files `0600`. Worker stderr проходит redaction. Queue bounded; restart помечает uncertain in-flight transcript failed/retryable без изменения Draft.

## Миграция, rollback и recovery

Transcript tables из schema v1. Если feature disabled/rollback, existing Draft remains editable text-only. Startup очищает only expired temp files по безопасному root guard; destructive cleanup реализуется отдельно и тестируется. Raw media никогда не восстанавливается из app backup.

## Тесты

### Unit/integration

- Valid voice → review → correction/accept → one Draft version.
- Unsupported media/oversize/duration/mime mismatch/path payload rejected.
- Timeout/model crash/queue full leaves Draft unchanged.
- Stale transcript completion не patchит newer Draft.
- Exact `medium` selection, no silent fallback.

### E2E/security/performance

- Synthetic Telegram update → local fake/real Whisper test profile → review UI → Draft.
- Raw bytes/filename/transcript absent from logs/audit/backups.
- Capacity test measures time/memory and event-loop responsiveness.
- Restart during processing yields safe recoverable state.

## Проверяемые критерии приёмки

1. Voice ack быстрый, transcription async и bounded.
2. Unreviewed/failed transcript не позволяет READY.
3. User correction атомарно создаёт новую version.
4. Raw voice удаляется по short policy и не входит в Git/backup/log.
5. Недоступный Whisper предлагает text fallback, не меняя Jira state.

## Exit criteria

- Local Whisper `medium` adapter и transcript lifecycle покрыты тестами.
- Production capability evidence можно собрать этапом 15/16.
- Privacy/runbook фиксирует raw voice срок.
- Jira write остаётся disabled.

## Трассируемость

BR-001/011; FR-011—014, FR-026, FR-060; NFR-013/022/041/045/050/052/060/062/064/066/073/082/092/096/097; D-017.

## Риски, неизвестные и решения

- **Evidence needed:** CPU/RAM/latency/model loading on production host.
- **Decision needed:** concrete short raw-audio retry/retention window.
- **Risk:** container image/model size and supply chain; pin/checksum artifacts and scan.
- **Assumption:** no raw audio backup; text fallback is always available.
