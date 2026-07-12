## 1. Parser: extract the CDN download descriptor

- [x] 1.1 Extend `MediaSidecarInfo` and `loadMediaSidecarTable` in `src/server/import/parser.ts` to also read the descriptor columns from `message_media` — `media_key`, `direct_path`, `message_url`, `enc_file_hash`, `media_key_timestamp`, `file_length` — column-guarded and streamed, with BLOB columns kept as base64
- [x] 1.2 In `iterateMediaRefs`, for a media row with no usable local `file_path` but a present `media_key`, build a `MediaDownloadDescriptor` (mediaType mapped from the message type; base64 `mediaKey`/`fileEncSha256`/`fileSha256`; `directPath`/`url`/`mediaKeyTimestamp`/`mimeType`/`fileName`/`fileLength`/dims/duration) plus a best-effort `retryKey` (remoteJid = chat jid, id = `key_id`, `fromMe`, participant = sender jid) and attach it to the ref
- [x] 1.3 Add optional `downloadDescriptor?: MediaDownloadDescriptor | null` to `ImportMediaRef`; do not attach it when a local `file_path` is present, nor when `media_key` is absent (genuinely unrecoverable)

## 2. Import backfill: enqueue recoverable media

- [x] 2.1 In `src/server/import/mediaBackfill.ts`, when `matchRefToFile` finds no local file but the ref carries a `downloadDescriptor`, call `repository.enqueueMediaDownloads([...])` (message key + chat + sourceMessageId + descriptor + thumbnail + isViewOnce + priority 0) instead of only counting the ref missing
- [x] 2.2 Rely on the queue's first-capture-wins dedup (unique `message_key`) so re-import and already-stored media never double-queue or re-download; do not eagerly trigger the download pass
- [x] 2.3 Extend `MediaBackfillSummary` with `queuedForRecovery` and `unrecoverable` counts; update `mediaBackfillWarning` (`MEDIA_INGEST_SUMMARY`) and the `media-progress` event to report the breakdown
- [x] 2.4 Keep it abort-proof: enqueue errors warn (privacy-safe, counts only) and never abort message import

## 3. Reuse the existing queue and worker (no schema/worker change)

- [x] 3.1 Confirm the enqueue reuses the existing `media_download_queue` (`descriptor_json` already holds the full descriptor) with no new column or provenance value; recovered assets keep the accurate `live-download`/`media-retry` source
- [x] 3.2 Confirm the existing download worker drains import-enqueued rows unchanged (`pending → downloading → stored / expired_unrecoverable`), recovering when live sync is connected — no worker edits

## 4. Honest missing label (no new availability states)

- [x] 4.1 Relabel the `import_missing` reason in `src/server/interpretation/messageInterpretation.ts` (`MEDIA_AVAILABILITY_REASONS`) from "The media file was not found in the imported media folder." to an honest "This media was never saved on your phone, so the backup has no copy of it."
- [x] 4.2 Update the matching client media availability text in `src/client/App.tsx`
- [x] 4.3 Confirm enqueued file-less media reads `pending`/`downloading` via the existing `deriveMediaAvailability` in both `sqliteRepository.ts` and `memoryRepository.ts` (no derivation code change needed)

## 5. Tests

- [x] 5.1 Parser: from a modern `message_media` fixture with descriptor columns, a descriptor is attached for a file-less row with `media_key`, not attached when `file_path` is present, and not attached when `media_key` is absent
- [x] 5.2 Backfill: no-local-match + descriptor enqueues (deduped) via `enqueueMediaDownloads`; no-descriptor stays unrecoverable; summary reports archived/queued/unrecoverable; import never aborts on enqueue failure
- [x] 5.3 Availability parity: an enqueued file-less message reads `pending`, a keyless file-less message reads import-missing — asserted against both the sqlite and memory repositories
- [x] 5.4 Interpretation: the import-missing reason is the honest "never saved on your phone" text, and the old folder wording is not produced

## 6. Verification and docs

- [x] 6.1 PASSED 2026-07-12: real backup + media folder re-imported (6.5 min, merge); summary read "15,714 of 22,916 media messages archived from the folder, 5,471 queued to recover from WhatsApp, 1,731 with no recoverable copy"; queued media reads `pending` ("Media download is queued."), keyless media reads the honest "never saved on your phone" label; enqueue deduped against existing queue rows (first-capture-wins) and message import stood throughout
- [x] 6.2 PASSED 2026-07-12: with live sync connected, queued items transitioned live — stored 79→86+ (fresh links recovered, incl. same-day photos), expired_unrecoverable 80→91 (old links going terminal honestly) — while imported messages stood untouched; the drain surfaced two field defects, both fixed and committed (silent pass completion 600c1a3, unbounded socket awaits 27d7a23)
- [x] 6.3 Update `docs/IMPORTING_AND_DATA_MODEL.md` (and media docs) to describe CDN recovery of file-less media and that recovery runs when live sync is connected
