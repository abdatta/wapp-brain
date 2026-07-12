## Context

Today the archive keeps only three media scalars per message — `has_media`, `media_mime_type`, `media_name` — on both ingestion paths. The actual bytes are never fetched or stored, no locator exists, there is no media-serving endpoint, and the UI renders media as text placeholders. The "media folder import" is validated then discarded (`src/server/import/importer.ts:49-63`).

The two ingestion paths are fundamentally different and must be treated as such:

- **Live sync (Baileys linked device)** receives, inside each media message, the descriptor needed to fetch the encrypted blob from WhatsApp's media CDN: `mediaKey`, `directPath`/`url`, `fileEncSha256`, `fileSha256`, `mediaKeyTimestamp`, plus size/dimensions/duration and an embedded `jpegThumbnail`. Normalization currently reads only `caption`/`mimetype`/`fileName` and drops everything else (`src/server/live/normalize.ts:953-986`). The descriptor is present in the Baileys event handler (`baileysClient.ts:137-165`) and gone by the time a record reaches the DB. WhatsApp media CDN links expire, so the fetch is time-sensitive.
- **Backup import (Android msgstore)** has no download keys; historical media lives as files in the user's WhatsApp media folder, mapped by the backup's `message_media` / `message_view_once_media` / `message_thumbnails` tables — none of which the importer reads today.

Hard constraints carried from the existing system:
- The live client is read-only at the app layer: `installReadOnlySocketGuards` (`baileysClient.ts:532`) throws on `sendMessage`, `readMessages`, `sendReceipt(s)`, presence, `chatModify`, group/profile writes; `markOnlineOnConnect:false`. This is what keeps the linked device invisible and, critically, keeps view-once media viewable on the phone (view-once "opened" is driven by a played/read receipt, which the app must never send).
- The archive is honest: it never fabricates state and degrades unreadable content to a truthful label rather than a bare "unsupported" (`message-interpretation` capability). Media availability must be reported with the same honesty.
- Real scale (~325k messages / ~3.7k chats), verified against a real linked device. Durable, resumable, bounded background work is the established pattern (`retained_encrypted_payloads` + secrets pass on the 30s recovery tick; `live_gap_windows` retry state machine).

## Goals / Non-Goals

**Goals:**
- Download, decrypt, and permanently store every media item from live sync and from import, keyed to its message with provenance and an honest availability state.
- Capture view-once photo/video/voice without the phone losing its own ability to view them.
- Recover expired live media via scoped WhatsApp media re-upload requests, without ever sending receipts/presence/chat-visible traffic.
- Make the media-folder import actually ingest media, resilient to large folders and bad paths, warning (never aborting) on media problems.
- Serve and render media locally: thumbnails, full view, inline audio, document rows.
- Retain downloaded media across sender revoke/delete (backup-store behavior).
- Content-addressed dedupe so forwarded/re-sent identical media is stored once.
- Expose media availability + asset references server-side for downstream consumers (thread view, search, second brain, MCP).

**Non-Goals:**
- Re-encoding, transcoding, or generating new thumbnails with a native image/video library (no `sharp`/`ffmpeg` dependency). We store originals and reuse WhatsApp's embedded `jpegThumbnail`.
- Encrypting the media store at rest (consistent with the already-plaintext local `archive.sqlite`).
- Virtualizing the thread view (a separate, larger refactor); this change mitigates media cost with lazy loading only.
- Recovering media for messages archived *before* this change that carry no descriptor (no `mediaKey` was captured) — those are recoverable only via the import folder.
- Sending anything to WhatsApp other than media re-upload requests. No read/played receipts, ever.
- A configurable retention/eviction policy or storage cap — unbounded retention is the accepted design.
- Parsing the companion backup databases (`offloaded-media.db.crypt15`, `stickers_db.bak.crypt15`, `status_backup.db.crypt15`, `chatsettingsbackup`, `commerce_backup`, `backup_settings`). The message archive's media mapping comes from `msgstore`'s own media sidecar tables plus the media folder; companion DBs add nothing needed for message-linked media and stay out of scope.
- Zip-archive media upload. Direct-path ingestion (Decision 9) covers the multi-GB case strictly better on a local server; adding an unzip dependency buys nothing.
- Edit history for backup-imported messages beyond what the backup records — pre-change edits only ever kept the final text, so history is a live-forward capability.

## Decisions

### 1. Capture the media descriptor at the Baileys event boundary, persist it, download asynchronously
The descriptor only exists in the raw Baileys message before normalization. We add a capture step in the `messages.upsert` and `messaging-history.set` handlers (and view-once is already unwrapped at `normalize.ts:805-833`, so the inner descriptor is reachable) that extracts a minimal downloadable descriptor and enqueues a `media_download_queue` row keyed by the canonical `(chat, key_id)` message key. A background worker on the recovery tick performs the actual download.

- **Why not download inline in the handler?** It would block event processing, couple ingestion latency to CDN speed, and lose the retry/backoff substrate. Enqueue-then-worker matches the proven `retained_encrypted_payloads` → secrets-pass shape.
- **Why persist the descriptor rather than the full raw payload?** We need only ~8 fields to call `downloadContentFromMessage`; storing full protobufs bloats the DB and risks retaining more sensitive raw data than necessary. The descriptor is stored in the queue row (not the `messages` table) and removed once the asset is stored.
- **Eagerness:** view-once and freshly-arrived media are enqueued at highest priority and normally downloaded within one tick, because their CDN links expire fastest and view-once is absent from backups. The worker still guarantees eventual download for everything else.

### 2. Downloading is passive; media re-upload is the one sanctioned outbound
`downloadContentFromMessage` (Baileys, exported from package root, verified in `@whiskeysockets/baileys@7.0.0-rc13`) is a plain HTTPS GET to the media CDN plus local AES decrypt using `mediaKey`. It sends nothing to the sender and does not touch view-once "opened" state. This is the primary path and requires no change to the read-only posture.

For media whose CDN link has expired, `downloadMediaMessage`'s `reuploadRequest` callback triggers a media-retry (`updateMediaMessage` → `encryptMediaRetryRequest` + `sendNode`). This asks WhatsApp to re-upload the encrypted file; it is **not** a read/played receipt and does not mark view-once as opened. We wire this callback only for the media-retry path.

- **Read-only guard change:** the guard blocklist stays intact for every receipt/presence/send/delete/group/profile method. We add a single, explicit exception so the media-retry send node is permitted — implemented as a dedicated allowed method rather than by weakening the blocklist, so the intent is auditable in one place. Everything that could touch view-once "opened" state (`readMessages`, `sendReceipt(s)`) remains blocked.
- **Rate limiting:** media-retry is bounded per tick and per message (capped attempts with backoff, mirroring `live_gap_windows`). After the cap, the item is marked `expired_unrecoverable` rather than retried forever.
- **Alternative considered — passive-only:** rejected per the user's decision to maximize backup completeness; media-retry is the only way to recover offline-gap and older history media.

### 3. View-once safety rests on "no receipts," verified on the real device
The property "download without the phone losing its view" reduces to "never send a read/played receipt for that message," which is already structurally enforced (guards + `markOnlineOnConnect:false`) and is unaffected by downloading. We keep that enforcement and treat the linked device as a silent observer that also fetches bytes.

- This is not officially documented by WhatsApp, so implementation includes a real-device verification step: archive a view-once item, confirm the phone still shows it as unopened and viewable.
- View-once is downloaded eagerly and, once stored, is freely viewable in-archive (it is the user's own record) but visibly badged as view-once for honesty.

### 4. Content-addressed store under `.wapp-brain/media/`, `media_assets` for linkage
Blobs are stored by `sha256(plaintext)` in a sharded directory (`media/<ab>/<cd>/<sha256>`), so identical forwarded/re-sent media is stored once. A `media_assets` table records the message→asset linkage and metadata:

- asset identity: `sha256`, relative `storage_path`, `byte_size`, `mime_type`, optional `width`/`height`/`duration_ms`, optional `thumbnail` (the embedded `jpegThumbnail`, stored inline or as a sibling blob).
- linkage + provenance: canonical message key, `source` (`live-download` | `media-retry` | `import-folder`), `is_view_once`, timestamps.
- availability is derived for the message (see Decision 6).

The store lives beside `archive.sqlite` under the config `workDir`; `.wapp-brain/` and `media/` are already gitignored. Blobs are decrypted at rest so they are directly viewable/streamable (consistent with the plaintext local DB).

- **Dedupe + retention interaction:** because media is retained across revoke and there is no eviction, blobs are effectively never deleted; multiple messages may reference one asset safely. Reference counting is unnecessary for this change (only relevant if eviction is ever added — a non-goal).

### 5. `media_download_queue` mirrors the retained-payloads/gap-window substrate
A durable pending-work table processed in bounded batches on the existing recovery tick: `status` (`pending` | `downloading` | `stored` | `retry` | `expired_unrecoverable` | `failed`), `attempts`, `next_attempt_at`, `last_error`, `priority` (view-once/fresh first), plus the stored descriptor. Success stores the asset and clears the row (or marks it terminal); failures back off and retry to a cap. This reuses the maintainer's loop rather than introducing a new scheduler.

### 6. Honest availability state, surfaced through interpretation
Each media message resolves to one availability state, computed server-side and read by every consumer:
- `stored` — bytes present in the store.
- `downloading` / `pending` — enqueued, not yet fetched.
- `expired_unrecoverable` — CDN link gone and media-retry exhausted/refused.
- `not_captured` — arrived while the server was offline; no descriptor was ever seen (view-once in this state is permanently gone).
- `import_missing` — an imported message whose media file was not found/readable in the provided folder.

`messageInterpretation` stops asserting the fixed "Media is not kept in backups." reason for view-once and instead reflects the real state (e.g. no reason when `stored`; an honest reason when `expired_unrecoverable`/`not_captured`). The message DTO (`src/shared/types.ts`) gains an asset reference + availability so the client can render or explain.

### 7. Import backfill: read the media sidecars, match files, copy, warn-not-abort
The importer starts reading `message_media` (file path, mime, size, hash), `message_view_once_media`, and `message_thumbnails`, and stops nulling modern-adapter mime/name (`parser.ts:982-983`). Given a user-provided media folder, it matches each media message's file by content hash first, falling back to relative path/filename, copies the file into the content-addressed store, and links a `media_assets` row with `source=import-folder`. Missing/unreadable/ambiguous files produce an import warning and an `import_missing` state; message import proceeds regardless. A bad media-folder path is a non-fatal warning, never an abort.

### 8a. Import ingests the media folder directly from disk, with progress
The user's WhatsApp media folder is multi-GB; pushing it through a browser upload (the current staging picker materializes and POSTs every file) is the wrong transport when the server is already local. The wizard therefore treats a **direct folder path** as the primary media input: the server validates the path, walks the standard `Media/WhatsApp *` subfolders (Images, Video, Voice Notes, Video Notes, Audio, Animated Gifs, Documents, Stickers, Profile Photos — including their `Sent`/date subdirectories), and ingests files straight from disk — hash, dedupe, copy into the content-addressed store, link. Ingestion reports a dedicated media phase through the existing import-job progress channel (files processed / matched / copied, privacy-safe), so a many-GB folder shows live progress in the wizard and server terminal like the message phases do.

- The existing picker upload remains for small selections; the typed-path input stops being a buried "advanced fallback" for media and becomes the recommended route for the real folder.
- **Alternative considered — zip upload:** rejected; it re-introduces the giant transfer plus an unzip dependency for no gain on a localhost server.
- Matching prefers the backup's recorded content hash (`message_media.file_hash`), falling back to relative path/filename; the folder walk skips unrelated dot-directories (`.Statuses`, `.wamocache`, thumbnails caches) except where a message mapping points into them.

### 8b. Deleted means tombstoned, never blanked
Revoke/delete already tombstones (`is_deleted=1`) while body/caption are sticky-preserved; media retention (Decision 4) extends that to bytes. The missing half is presentation: interpretation currently replaces every deleted message with a bare "Deleted message" label, and the client renders no deletion indicator at all. The contract becomes: **if content was captured before the deletion, it stays visible — text, caption, media alike — decorated with a clear "deleted" marker; the "Deleted message" placeholder is reserved for deletions whose content was never captured.** This is computed server-side (interpretation + DTO flag) so every consumer inherits the same honesty.

### 8c. Consecutive media collapses into an album grid (display-only)
Runs of 4+ media items from the same sender within a short window render as a WhatsApp-style grid (2×2 with a "+N" overflow tile), whether or not WhatsApp marked them as an album message. This is a pure thread-view presentation rule — storage stays one row per message — so grouping never rewrites archive data and search/memory consumers are unaffected.

### 8d. Links become first-class: clickable text and preview cards
Message text is linkified client-side (URLs highlighted, open in a new tab). Link previews reuse what the sender already embedded: `extendedTextMessage` carries title/description/canonical URL and a `jpegThumbnail`; capture stores that thumbnail alongside the message (it is embedded bytes — no network fetch, no page scraping) and the UI renders a compact preview card when held. No outbound fetch of link targets is ever performed by the server.

### 8e. Live edits retain revision history
Today an edit overwrites `body` in place (plus an `edited` marker in metadata). To support "see edit history", applying a live edit first snapshots the current body/caption into an edit-revision store keyed by the canonical message key (revision index, content, edited-at). The DTO exposes `isEdited` and revision availability; the UI shows an "edited" marker and a history view listing prior revisions. Backup-imported edits surface the edited marker only — the backup does not preserve prior texts (see Non-Goals).

### 9. Local serving with range support; lazy rendering
New localhost-only endpoints stream original media (with HTTP range support for video/audio scrubbing) and thumbnails, beside the existing message routes. The client renders images/stickers and video posters from the thumbnail endpoint, opens originals on demand, and plays audio inline. Because the thread view is not virtualized, media uses native lazy loading (`loading="lazy"` + fetch-on-visible) so a media-heavy chat does not fetch everything at once.

## Risks / Trade-offs

- **View-once semantics could change or be misjudged** → Verify on the real linked device before relying on it; the passive+no-receipt design is reversible and adds no new outbound signal; keep the guards as the single enforcement point.
- **CDN links expire before download (offline gaps, history)** → Eager, prioritized download for fresh/view-once; media-retry for expired; honest `expired_unrecoverable`/`not_captured` states when truly gone. View-once missed while offline is unrecoverable by design and reported as such.
- **Media-retry may fail (sender offline or dropped the media)** → Bounded retries then terminal `expired_unrecoverable`; never an infinite loop, never a crash.
- **Download volume saturates bandwidth/CPU/disk** → Bounded per-tick concurrency and batch size; unbounded disk growth is accepted but download pacing is not.
- **`tsx watch` restart kills a download mid-write** → Recommend `npm run server` for live sessions; the queue makes downloads idempotent and resumable, and blobs are written atomically (temp + rename) so a truncated file never registers as `stored`.
- **Import filename collisions / non-unique names** → Prefer content-hash match; fall back to relative path; warn on ambiguous, do not guess silently.
- **Direct-path ingestion walks a multi-GB tree (slow disk, cloud-synced folders, symlinks)** → Stream + hash file-by-file with per-file progress through the import-job channel; skip unresolvable entries with privacy-safe warnings; never follow symlinks outside the selected root; a wrong path degrades to a warning, not an aborted import.
- **Grouping heuristic mis-groups unrelated media** → Grouping is display-only and conservative (same sender, tight time window, 4+ items); individual messages remain individually openable from the grid, and storage is untouched.
- **Unvirtualized thread with many images** → Lazy loading mitigates; full virtualization is deferred to a follow-up and noted, not silently ignored.
- **Larger sensitive surface on disk (decrypted media)** → Store is local-only and gitignored, no bytes/filenames in logs or traces by default; same trust boundary as the already-plaintext archive DB.

## Migration Plan

- **Additive only:** create `media_assets` and `media_download_queue` via the existing additive migration seam; no destructive changes to existing tables. Existing archives open with empty media state.
- **Forward-populating:** live capture begins enqueuing from the moment the change ships; history-sync media that re-arrives is captured too. Import backfill runs when the user (re-)imports with a media folder — re-import is idempotent (verified) and safe while the live session holds.
- **Pre-change historical live media** has no stored descriptor and cannot be re-fetched via keys; it is recoverable only through the import folder and is reported honestly (`not_captured`/`import_missing`) rather than shown as available.
- **Rollback:** the feature is additive and derived. Stopping the worker halts downloads; the media store is derived data that can be deleted and rebuilt from import (and, going forward, from live capture). No archive data is lost by disabling it.

## Open Questions

- Concrete defaults for media-retry rate limit, per-tick download concurrency, and batch size — tune against the real device/archive during implementation.
- Whether the embedded `jpegThumbnail` is sufficient as the video poster in all cases, or whether some video/document types need a generic type icon fallback (leaning: type-icon fallback when no embedded thumbnail exists; no native transcoder).
- Whether import matching should also consult per-chat media subfolder conventions when hash/path match fails, or stop at "warn + `import_missing`" (leaning: stop and warn, to avoid mismatched attributions).
- Offloaded media: WhatsApp can offload on-device media (tracked in `offloaded-media.db`), meaning some historical media is absent from the local `Media` folder and recoverable only from the phone/cloud. In the provided backup that DB is ~2 KB (effectively empty), so it is treated as out of scope; if a future backup shows real offloaded entries, those messages should report `import_missing` honestly rather than appear lost — worth revisiting then.
