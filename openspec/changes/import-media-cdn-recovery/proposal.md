## Why

When a user imports a backup with their WhatsApp media folder, the importer correctly archives every media message that had a local file — but it permanently gives up on the rest, labelling them "The media file was not found in the imported media folder." Verified against a real backup this session: of 23,099 media messages, 15,714 matched a local file and 7,202 did not, because the phone never saved a local copy (`message_media.file_path` is NULL for 7,552 of 23,491 source rows — auto-download off, or space later freed). But the backup still carries the **encrypted download descriptor** (`media_key`, `direct_path`, `file_hash`, `media_key_timestamp`, …) for most of them: **4,099 are fully CDN-recoverable**, ~2,019 are recoverable via a media re-upload request, and only 1,434 are genuinely unrecoverable. The live path already has the machinery to fetch and decrypt exactly this — a durable media download queue, a background worker (`downloadContentFromMessage`), and scoped media-retry — but the import never feeds it. So thousands of recoverable photos and videos are thrown away and mislabelled as the user's folder being incomplete, when the phone simply never stored the file.

## What Changes

- **Import extracts the CDN descriptor for file-less media**: when a media message has no usable local `file_path`, the parser also reads its download descriptor from `message_media` (`media_key`, `media_key_timestamp`, `direct_path`, `file_hash`/`enc_file_hash`, `mime_type`, `file_length`, dimensions, duration, view-once), surfacing it on the media ref.
- **Import enqueues recoverable media for background download**: media with no local-file match but a usable descriptor is enqueued into the existing `media_download_queue` with import provenance (deduped by canonical message key), instead of being counted as plain missing. Media with neither a local file nor a descriptor stays honestly unrecoverable.
- **Reuse the existing download worker + media-retry**: import-originated queue items flow through the same `pending → downloading → stored / expired_unrecoverable` path as live media. Fresh `direct_path` links download standalone; expired links degrade to a media re-upload request (which requires an active live session).
- **Honest availability, honest label** (**partly BREAKING to the current wording**): media queued for recovery reports `pending`/`downloading` instead of `import_missing`; media with no local copy and no keys reports a truthful "not saved on your phone" state rather than the misleading "not found in the imported media folder." The blanket import-missing label is retired for the descriptor-bearing case.
- **Import media summary reports the real breakdown**: the media phase reports matched-and-archived, queued-for-recovery, and genuinely-unrecoverable counts, so the user sees that most "missing" media is queued, not lost.
- **Benefit applies on next import**: because the descriptor was never persisted before, already-imported file-less media is enqueued when the backup is re-imported (no descriptor exists to backfill from the archive alone).

## Capabilities

### New Capabilities
<!-- None. This extends existing media, import, and interpretation capabilities. -->

### Modified Capabilities
- `media-archival`: the **Import Media Backfill From Backup Folder** requirement gains CDN-recovery — file-less media with a usable descriptor is enqueued for download rather than left import-missing; the **Durable Background Media Download Queue** accepts import-originated (import-cdn) entries and provenance; **Honest Media Availability State** distinguishes queued-for-recovery from genuinely-no-copy.
- `message-interpretation`: **Media Availability Is Interpreted Honestly** replaces the single "missing from the import folder" reason with distinct honest reasons — queued/downloading for recovery, and "not saved on your phone / no recoverable copy" — for the file-less cases.
- `premium-onboarding-workflow`: the **Media Ingestion Progress** requirement reports queued-for-recovery and unrecoverable counts alongside matched/archived, so the import summary reflects that missing media is mostly recoverable.

## Impact

- **Parser**: `src/server/import/parser.ts` (`MediaSidecarInfo` + `loadMediaSidecarTable` read the descriptor columns; `iterateMediaRefs` surfaces a descriptor for file-less rows).
- **Import ingestion**: `src/server/import/mediaBackfill.ts` (on no local-file match with a descriptor, enqueue instead of counting missing) and `src/server/import/importer.ts` (wire the enqueue + summary counts).
- **Queue/worker**: the media download queue repository methods (accept import-originated descriptors + provenance) and the existing download worker/media-retry (no new transport — reuse `downloadContentFromMessage`). Confirm whether fresh-link downloads run without an active live session or only on the maintainer tick.
- **Availability/DTO**: `src/shared/types.ts` (media ref descriptor; availability vocabulary), `src/server/db/sqliteRepository.ts` + `memoryRepository.ts` (`deriveMediaAvailability` split), `src/server/interpretation/messageInterpretation.ts` (reasons/labels), and `src/client/App.tsx` media availability text.
- **Privacy**: descriptors (`media_key`, `direct_path`) are sensitive; they live only in the local queue and logs stay counts-only, consistent with the existing media-archival privacy posture. No media bytes or keys in logs.
- **Dependency**: none new — reuses Baileys `downloadContentFromMessage` / media-retry (already in use for live).
- **Tests**: descriptor extraction from a modern `message_media` fixture; enqueue-on-no-match with dedupe; availability split (queued vs no-copy vs unrecoverable); import summary counts; and that message import never aborts on any of this.
