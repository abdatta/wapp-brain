# Importing And Data Model

## Supported Inputs Today

Historical import accepts:
- `msgstore.db` for plaintext fixtures or already-decrypted databases.
- `msgstore.db.crypt15` with a matching 64-character key or `encrypted_backup.key`.
- Optional `wa.db` or `wa.db.crypt15` for contact/name enrichment.
- Optional WhatsApp media folder, read in place from disk (any size, including the real multi-GB folder) and matched to media messages and archived.

## UI Import Wizard

The local web UI treats backup load as a guided wizard. You point it at a single WhatsApp backup folder and the server auto-detects the rest — nothing is uploaded, because the browser and the local server share the machine (`127.0.0.1`).

The wizard flow is:
- **Browse for your WhatsApp backup folder** — a native OS folder dialog opens (Windows today) and returns the folder's absolute path. Where the native picker is unavailable (non-Windows / headless), type the folder path instead.
- The server **auto-detects** the folder: `msgstore.db.crypt15` (or a dated rotation / plain `msgstore.db`), optional `wa.db`, and the `Media/` folder, searching the root and the standard `Databases/` / `Media/` subfolders. It shows a detection summary before import, and lists any recognized auxiliary backup databases (`chatsettingsbackup`, `status_backup`, `offloaded-media`, `backup_settings`, `commerce_backup`, `stickers_db`) as **detected and reserved for a follow-up** — they are not ingested yet.
- **Paste the 64-character key** in the text field. The key is text only (the same key decrypts the whole backup); there is no key-file picker in the UI.
- Verify the key locally before import starts.
- Choose merge or clear-and-replace.
- Watch phase progress for validation, verification/decryption, schema parsing, message import, media, warnings, and completion.

All inputs are **read in place** from the detected paths; nothing is copied or uploaded into the app. Only the importer's decrypted intermediates live under the local work dir and are cleaned up afterward. An **advanced override** lets you set individual `msgstore` / `wa.db` / media paths for non-standard layouts (still read in place, still no upload). The picker, folder scan, and key verification each show a busy indicator and run without blocking the server.

> The CLI `npm run import` still accepts a `--key-file` for scripted imports; only the browser wizard is key-text-only.

Merge mode keeps existing archive rows and relies on idempotent upserts. Clear-and-replace mode removes archive data and live recovery state before importing the selected backup as the new baseline. It requires explicit confirmation in the UI.

Once a UI import starts, the work runs in the local server process. Refreshing the browser does not stop that in-process job; the UI asks the server for the current import job and reopens the progress screen when one is active. If the local server process itself is stopped, the import stops with that process.

The progress screen includes a confirmed stop action for active UI imports. Before the job begins writing, the server captures a local archive restore point. If the user stops the import, the server aborts the job, restores that snapshot, removes any decrypted intermediates, and reports the job as cancelled. This prevents partially imported contacts, chats, messages, or replace-mode clears from being left behind.

UI import jobs also emit privacy-safe progress to the local server log. Log lines include the short import job id, mode, lifecycle step, file byte counts, message processed/persisted counts, warning codes, and terminal status. They intentionally do not include backup keys, local file paths, message bodies, decrypted rows, or raw database dumps.

When the app is started with `npm run server` or `npm run dev`, UI imports also render terminal progress similar to the CLI import command. File verification/decryption phases use byte progress bars, and message import uses message-count progress when the source schema exposes a total. Set `WAPP_IMPORT_PROGRESS=off` to disable terminal bars in noisy terminal wrappers, or `WAPP_IMPORT_PROGRESS=bars` to force them on.

During large message imports, the importer yields between message batches after recording progress. This keeps the local HTTP server responsive enough for the browser to poll current progress instead of appearing stuck while terminal progress continues.

## What The Importer Preserves

Where available, the importer stores:
- contacts from `wa.db` after opening plaintext input or decrypting `wa.db.crypt15`
- chats and inferred chat type
- inferred group participants from message senders
- source message identity
- timestamps as WhatsApp Unix milliseconds and UTC datetimes
- direction/from-me
- message body or caption
- message type and raw type code
- media-like metadata such as MIME type/name
- quoted row references
- deleted/forwarded/starred flags
- raw/source metadata useful for future parser improvements

### Reply Quote Snapshots

Modern Android imports defensively capture WhatsApp's reply-owned `message_quoted` snapshot and known media, location, vCard, and mention companions when present. The full captured quote stays local in a one-to-one archive record owned by the reply; absent or malformed optional tables keep the existing pointer-only reply behavior. Later backup or live observations can fill missing snapshot fields without erasing the earlier local capture.

## Structured Signal Capture

After canonical chats, messages, identities, and edit-key collapse are in place, import captures optional structured signals with `captureVersion` `1`. The same canonical records are also accepted from live notify and history events.

- `identity_number_changes` records structurally verified old/new JID pairs. It is evidence for a later identity consumer, not an automatic person connection.
- `group_membership_periods` and `group_membership_events` retain available current/past membership bounds, role, and verified `add`, `remove`, `join`, `leave`, `invite`, `accept`, `promote`, or `demote` actions. Actor and affected-person roles are separate. In particular, `message_system_group.is_me_joined` alone never creates an owner membership fact.
- `chat_metadata_history` retains observed subject, description, photo, invite-link, announcement, restriction, member-add, join-approval, and disappearing-message settings with stable anchors; unverified action codes and unavailable fields are not guessed.
- `message_locations`, `message_location_observations`, `message_vcards`, `message_edit_events`, `message_deletions`, `message_media_interpretations`, and `archive_signal_observations` retain complete local source observations. Location records can include quality, movement, sequence, duration/final, caption/comment/URL, and thumbnail-presence fields. vCards retain lossless parsed properties plus the source card when available.
- sender-embedded link previews reuse `message_link_previews`; no URL is fetched during import.
- `engagement_aggregates` retains only per-chat counters, bounds, exact median response latency, sample count, and algorithm version. Raw receipt/device rows and recipient identifiers never leave source SQLite.

Optional tables and columns are inspected before use. A missing, renamed, malformed, or unreadable companion only skips that signal family/row and emits a content-free warning; ordinary messages and other compatible families continue importing.

For engagement version 1, the denominator is eligible outgoing messages, delivery/read counts are backed by available receipt/device timestamps, and a response-latency sample is an incoming message immediately following an outgoing message in chronological order. SQLite ranks numeric samples to calculate the exact median, so the importer does not retain a latency array in Node memory.

### Consumer Handoff

Changes #5, #8, and #9 should consume the focused repository methods rather than parse message metadata: `listIdentityNumberChanges`, `listGroupMembershipPeriods`, `listGroupMembershipEvents`, `listChatMetadataHistory`, and `listEngagementAggregates`. Each row carries source, event key, observation time, and capture/algorithm versions. Consumers must represent unavailable or skipped fields as unknown, never infer a number change from a display name, a group action from an unverified numeric code, or a person match from a vCard hint.

Signal re-imports use natural keys and monotonic enrichment: missing fields fill, newer/richer live observations are retained, and an enrichment of a message used by a brain episode marks only that episode stale. `brain_episode_signal_anchors` stores message key, signal kind, and capture version (never raw text); regeneration makes a replacement episode transactionally and does not advance an already-covered watermark.

### Owner-Local Detail And Downloads

The message-list API intentionally stays compact for pagination. Opening a message detail view calls the loopback-only focused detail route, which may return every retained field for the archive owner: exact location telemetry, raw vCard source and properties, edit/deletion timestamps and provenance, transcript/accessibility text, and system role/raw-type fields. Each vCard can be downloaded locally: source bytes are preferred; a minimal `.vcf` is constructed only from a trustworthy display name and phone-form JID. LID-only or otherwise insufficient records return no download.

## Schema Strategy

WhatsApp Android schemas are unofficial and change over time. The parser should:
- inspect tables/columns before reading them
- support known legacy and modern-ish shapes
- skip malformed rows with privacy-safe warnings
- preserve source metadata instead of throwing unknown details away
- fail clearly when no supported message schema is present

Currently supported schema families:
- legacy `messages` with `key_remote_jid`, `key_from_me`, `key_id`, `data`, `timestamp`, and media columns
- modern-ish `message`, `chat`, `jid`, and `message_text` mappings

## Idempotency

Exact re-runs should not duplicate data.

Messages are upserted by stable source-derived keys. Cross-backup dedupe can still be imperfect if WhatsApp changes row identity and key IDs are unavailable.

Live WhatsApp Web events use source keys derived from WhatsApp Web identity:
- source prefix
- chat JID
- participant/sender when present
- from-me flag
- WhatsApp message ID

This lets the same message converge when it appears through backup import, real-time live sync, offline append sync, history sync, or bounded backfill.

## Live Maintenance Data

Live maintenance stores additional local state:
- linked-device session metadata and connection status
- live sync run status and totals
- per-chat latest archived/live and oldest verified checkpoints
- suspected gap windows with retry and confidence status
- event receipts for idempotent replay protection

The recovery planner works per chat rather than using one global watermark. If one chat appears current and another has a ten-hour suspected gap, only the gapped chat is scheduled for deeper recovery.

Live sync is disabled until an imported backup baseline exists. If the latest archived message is older than the configured recovery window, the user must import a fresher backup before linking live sync. The UI surfaces this as a guided setup state rather than showing live controls that cannot safely run yet.

## Second-Brain Memory Data

Memory consolidation is derived from archive messages. It does not replace the raw archive.

The memory layer stores:
- memory runs with status, totals, and source bounds
- source windows with deterministic hashes for idempotent REM reruns
- evidence packs with local citation labels
- page revisions and current/stale page state
- citation edges back to exact archive messages
- validation issues for unsupported or stale claims
- a job lock so scheduled/manual runs cannot overlap

Generated Markdown pages live under `.wapp-brain/memory/pages/` by default. Citation sidecars live under `.wapp-brain/memory/citations/`, and dry-run evidence previews live under `.wapp-brain/memory/runs/`. These files are private WhatsApp-derived data.

The default REM command consolidates completed messages up to the previous local day and leaves newer messages as short-term context. Query reads combine committed pages with short-term archive messages newer than the latest committed window.

## Media Status

Media is archived as first-class local content.

- **Import backfill**: the importer reads the backup's media sidecar tables (`message_media`, `message_view_once_media`, thumbnail tables), matches each media message to a file in the provided WhatsApp media folder (content hash first, then recorded path, then unique name), copies matches into a content-addressed store under `.wapp-brain/media/`, and links them to messages with import provenance. Missing/unreadable/ambiguous files warn (privacy-safe counts); media problems never abort a message import, and a wrong media-folder path degrades to a warning. The media phase reports live progress in the wizard and server terminal, including the recovery breakdown (archived / queued for recovery / no recoverable copy).
- **Import CDN recovery**: much WhatsApp media has no local file in the backup (`message_media.file_path` is NULL) because the phone never downloaded it or later freed the space — but the backup still holds the encrypted download descriptor (`media_key`, `direct_path`, hashes). For those, the importer extracts the descriptor and enqueues the message into the same durable media download queue used by live sync, so the background worker fetches and decrypts it from WhatsApp's CDN (and falls back to a media re-upload request for expired links). Recovery runs while live sync is connected; queued media reports `pending`/`downloading` rather than a false "missing from your folder" claim. Media with no local file and no recovery key stays honestly unrecoverable.
- **Live capture**: the live maintainer captures the downloadable descriptor of every incoming media message (image, video, voice/audio, document, sticker, GIF, and view-once variants) at the event boundary, queues it durably, and downloads + decrypts it in the background with bounded batches, retries, and backoff. View-once media downloads at the highest priority and — because the app never sends read/played receipts — remains unopened and viewable on the phone. For expired CDN links the app may send a scoped WhatsApp media re-upload request (the single sanctioned outbound; never a receipt).
- **Storage**: blobs are stored once by `sha256(plaintext)` (forwards/re-sends dedupe), written atomically, retained across sender delete/revoke, and never evicted. Deleted messages keep their held text, caption, and media with a deleted marker.
- **Serving**: original media and thumbnails stream from loopback-only endpoints (`/api/media/assets/:id` with HTTP range support); media bytes never leave the machine by default, and no media paths or bytes are logged.
- **Honesty**: every media message resolves to a server-computed availability state — `stored`, `downloading`, `pending`, `expired_unrecoverable`, `not_captured` (arrived while offline), or `import_missing` — surfaced through interpretation to every consumer instead of a fixed "media is not kept" claim. `import_missing` now means the media was never saved on the phone and carries no recovery keys ("no recoverable copy"); it never blames the media folder the user selected, and recoverable media reports `pending`/`downloading` instead.
