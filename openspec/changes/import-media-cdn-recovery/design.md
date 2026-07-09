## Context

The import media backfill (`src/server/import/mediaBackfill.ts`) matches each media message to a file in the user's WhatsApp media folder (content hash → recorded path → basename) and links matches into the content-addressed store. It works: measured against a real backup, it matched 15,714 of 23,099 media messages — essentially every message whose phone kept a local file.

The remaining ~7,200 have `message_media.file_path = NULL` in the source `msgstore`: the phone received them but never saved a local copy (auto-download off, or space later reclaimed). The backfill has nothing on disk to match, so today it counts them missing and `deriveMediaAvailability` (`src/server/db/sqliteRepository.ts:150-168`) returns `import_missing` — "The media file was not found in the imported media folder" (`messageInterpretation.ts:73`). That wording implies the user's folder was incomplete; the truth is the file never existed locally.

But `message_media` still holds the **encrypted download descriptor** for most of them — `media_key`, `media_key_timestamp`, `direct_path`, `file_hash`/`enc_file_hash`, `mime_type`, `file_length`, dimensions, duration. Measured: of 7,552 file-less rows, 4,099 have `media_key` + `direct_path` (fully CDN-recoverable), ~2,019 have `media_key` only (recoverable via media re-upload), 1,434 have no `media_key` (unrecoverable). The archived `media-archival` capability already ships the recovery engine — a durable `media_download_queue`, a background worker using Baileys `downloadContentFromMessage` (HTTPS GET + AES decrypt with `media_key`), and scoped media-retry for expired links, with `pending`/`downloading`/`expired_unrecoverable` availability. The import simply never feeds that queue. This change connects the two.

## Goals / Non-Goals

**Goals:**
- On import, carry the CDN descriptor for media that has no local file, and enqueue the recoverable ones into `media_download_queue` so the existing worker fetches them.
- Report availability honestly: queued-for-recovery (`pending`/`downloading`) instead of `import_missing`; and a truthful "not saved on your phone / no recoverable copy" for media with no descriptor — retire the misleading "imported media folder" wording for the file-less case.
- Reuse the existing queue, worker, media-retry, dedup, and provenance — no new download mechanism.
- Keep import local, fast, and abort-proof: enqueue is bookkeeping; message import never depends on or waits for it.
- Surface the real breakdown (archived / queued-for-recovery / unrecoverable) in the import summary.

**Non-Goals:**
- Changing the local-file matching logic (it is correct).
- Downloading synchronously during import (recovery stays async via the queue).
- Guaranteeing recovery — expired CDN links degrade to media-retry, then `expired_unrecoverable`.
- Recovering the ~1,434 keyless rows (no `media_key` → genuinely gone).
- A new transport, CDN client, or auth path — reuse `downloadContentFromMessage` / media-retry.
- Retroactively enqueuing already-imported media without re-import (the descriptor was never persisted; a re-import repopulates it).
- **A standalone download drainer** — the existing worker runs on the live maintainer's tick and only while a live socket is connected, so import-recovered media downloads when live sync is connected; running recovery without a live session is a separate, larger change.
- **New availability enum states or a persisted "backup had a local path" flag** — the recoverable case is served by the existing `pending`/`downloading` states; the precise folder-absent-vs-never-on-phone split is deferred.
- **A new `media_download_queue` provenance/`import-cdn` column** — the queue already stores the descriptor as JSON; recovered assets keep the accurate `live-download`/`media-retry` source.

## Decisions

### 1. Enqueue at import; download asynchronously via the existing worker
When the backfill finds no local file for a ref but the ref carries a usable descriptor, it writes a `media_download_queue` entry (import provenance) instead of counting the message plain-missing. The already-shipped worker drains the queue on its cadence. Import does not download inline — it stays local and fast, and the enqueue is idempotent bookkeeping that never blocks or aborts message import.

- **Why not download during import?** It would couple import latency to CDN speed/expiry and duplicate the worker's retry/backoff substrate. Enqueue-then-worker is the established pattern (retained-payloads, gap recovery).

### 2. Extract the descriptor only for file-less media, streamed
`loadMediaSidecarTable` / `MediaSidecarInfo` (`parser.ts:658-813`) already read `file_path`, `file_hash`, `mime_type`, etc. from `message_media`; extend them to also read `media_key`, `media_key_timestamp`, `direct_path`, `enc_file_hash`, `file_length`, `width`, `height`, `media_duration`. `iterateMediaRefs` attaches an optional `downloadDescriptor` to a ref when it has no usable `file_path`. Matched-with-a-local-file refs need no descriptor. Reads stay column-guarded and streamed (the table runs to hundreds of thousands of rows).

### 3. Enqueue eligibility and the download vs. media-retry split
A file-less ref is **enqueued** when it has a `media_key` (the AES key is mandatory to decrypt). The worker then chooses: `direct_path` present → attempt a direct CDN download; absent or expired → media-retry (re-upload request). A ref with no `media_key` is **not** enqueued and is terminally unrecoverable-from-backup. Enqueue is deduped by canonical message key (upsert), so re-import and already-stored media never double-queue or re-download.

### 4. Availability flips for free on enqueue; the residual missing label is relabelled honestly
`deriveMediaAvailability` (both the SQLite and memory mirrors) already reads the `media_download_queue` status *before* the `import_missing` fallback. So enqueuing a file-less message makes it read `pending` → `downloading` → `stored` / `expired_unrecoverable` automatically — **no change to the availability derivation is required** for the recoverable case. The recoverable media the user is complaining about stops reading "missing" the moment it is enqueued.

What remains `import_missing` after this change is media with **no usable descriptor** (no `media_key`) — genuinely no recoverable copy. Its reason text is relabelled from the misleading "The media file was not found in the imported media folder" to an honest "This media was never saved on your phone, so the backup has no copy of it." The shared derivation stays the single source of truth for every consumer (thread view, search, second-brain, MCP).

Precisely separating "never on your phone" from the rare "your selected folder was missing a file the backup recorded" would need a persisted per-message signal (there is none today) — deferred as a follow-up (see Non-Goals). Likewise, tagging the recovered asset with a distinct `import-cdn` provenance would need a new queue column threaded through both repositories; the recovered asset keeps the accurate `live-download` / `media-retry` source (it is fetched through the live CDN path), and dedicated import-CDN provenance is deferred.

### 5. Import summary reports the recovery breakdown
`MediaBackfillSummary` / the `MEDIA_INGEST_SUMMARY` warning and the media-phase progress add `queuedForRecovery` and `unrecoverable` counts beside `matchedRefs`/`missingRefs`, so the user sees "15,714 archived, 6,100 queued to recover, 1,434 unrecoverable" rather than a flat "7,202 missing".

### 6. Privacy is unchanged and preserved
`media_key`/`direct_path` are sensitive. They live only in the local `media_download_queue` (already private, gitignored workspace) and never appear in logs — media logging stays counts-only, consistent with the media-archival privacy requirement.

## Risks / Trade-offs

- **Most "recoverable" media may fail because CDN links expired** → the worker degrades `direct_path` failures to media-retry, then honestly to `expired_unrecoverable`; the summary never overpromises ("queued to attempt recovery", not "recovered").
- **Downloads need the worker running (and media-retry needs a live session)** → the UI must say queued items download when the app/live sync is active, not instantly; see Open Questions on standalone downloads.
- **Enqueuing thousands at once** → reuse the queue's bounded per-cadence batch + backoff so recovery never starves other work; give import-recovered items lower priority than fresh live media.
- **Descriptor extraction over a huge `message_media`** → column-guarded, streamed, and only attached for file-less rows; negligible added cost.
- **Re-import needed to benefit** → stated plainly; a re-import is idempotent (dedup by key) and only enqueues what is still absent.

## Migration Plan

Additive, no destructive change.
1. Parser surfaces the descriptor; backfill enqueues recoverable file-less media; summary reports the breakdown.
2. `deriveMediaAvailability` + interpretation labels split `import_missing` into queued-for-recovery vs. no-copy vs. folder-missing.
3. Queue/worker accept import-provenance entries (no worker rewrite).
4. Effect: on the next import, previously-missing recoverable media becomes `pending` and downloads as the worker runs. Rollback = revert the enqueue + availability split; matched-media behavior and the live path are untouched.

## Resolved Decisions (were open questions)

- **Standalone download without a live session?** Resolved: **no** — reuse the existing worker as-is. It drains only while the live maintainer holds a connected socket, so import-recovered media downloads when the user has live sync linked/connected. The import enqueues regardless; recovery progresses when live runs. A standalone drainer is a deferred follow-up (Non-Goals).
- **Persist a per-message "backup had a local path" flag?** Resolved: **defer**. The high-value distinction (recoverable → `pending` vs unrecoverable → honest missing label) is delivered without it; the precise folder-absent-vs-never-on-phone split is a follow-up.
- **Download priority / rate.** Resolved: enqueue import-recovered items at the default priority `0` (below live's view-once `100` / fresh `50`), so live capture is never starved; the queue's existing bounded batch + backoff governs rate. Do **not** eagerly kick `runMediaDownloadPass()` on import (that path is connected-socket-only and reserved for fresh live media).

## Follow-ups (out of scope here)

- Standalone (no live session) recovery drain for fresh `direct_path` items.
- A persisted per-message signal to distinguish "never saved on your phone" from "missing from the folder you selected", and a dedicated `import-cdn` asset provenance.
- Preserving the backup's raw stanza `retryKey` (remoteJid/id/fromMe/participant) so expired-link imported media can use media-retry — included best-effort where the backup row makes it cheap, otherwise expired imported links terminate as `expired_unrecoverable`.
