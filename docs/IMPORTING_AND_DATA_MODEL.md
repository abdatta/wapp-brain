# Importing And Data Model

## Supported Inputs Today

Historical import accepts:
- `msgstore.db` for plaintext fixtures or already-decrypted databases.
- `msgstore.db.crypt15` with a matching 64-character key or `encrypted_backup.key`.
- Optional `wa.db` for contact/name enrichment.
- Optional media directory path for context only.

## UI Import Wizard

The local web UI now treats backup load as a guided wizard instead of asking for raw paths first.

The wizard flow is:
- pick `msgstore.db.crypt15` or `msgstore.db` with a file picker
- optionally pick `wa.db`, a key file, and media inputs
- paste a 64-character key or use the selected key file
- verify the key locally before import starts
- choose merge or clear-and-replace
- watch phase progress for validation, verification/decryption, schema parsing, message import, warnings, and completion

Selected files are staged only under `.wapp-brain/import-staging/` on the local server. The server binds to `127.0.0.1` by default, so the browser upload is local to the machine. Manual path fallback remains available for environments where browser file picking is not enough.

Merge mode keeps existing archive rows and relies on idempotent upserts. Clear-and-replace mode removes archive data and live recovery state before importing the selected backup as the new baseline. It requires explicit confirmation in the UI.

Once a UI import starts, the work runs in the local server process. Refreshing the browser does not stop that in-process job; the UI asks the server for the current import job and reopens the progress screen when one is active. If the local server process itself is stopped, the import stops with that process.

The progress screen includes a confirmed stop action for active UI imports. Before the job begins writing, the server captures a local archive restore point. If the user stops the import, the server aborts the job, restores that snapshot, removes staged files, and reports the job as cancelled. This prevents partially imported contacts, chats, messages, or replace-mode clears from being left behind.

UI import jobs also emit privacy-safe progress to the local server log. Log lines include the short import job id, mode, lifecycle step, file byte counts, message processed/persisted counts, warning codes, and terminal status. They intentionally do not include backup keys, local file paths, message bodies, decrypted rows, or raw database dumps.

When the app is started with `npm run server` or `npm run dev`, UI imports also render terminal progress similar to the CLI import command. File verification/decryption phases use byte progress bars, and message import uses message-count progress when the source schema exposes a total. Set `WAPP_IMPORT_PROGRESS=off` to disable terminal bars in noisy terminal wrappers, or `WAPP_IMPORT_PROGRESS=bars` to force them on.

During large message imports, the importer yields between message batches after recording progress. This keeps the local HTTP server responsive enough for the browser to poll current progress instead of appearing stuck while terminal progress continues.

## What The Importer Preserves

Where available, the importer stores:
- contacts from `wa.db`
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

## Media Status

Media is not imported as files yet.

The app preserves message/media type metadata and displays placeholders. Future media work should copy or index media locally without exposing a public static directory by accident.

The live maintainer follows the same first-pass rule: preserve media metadata and missing-media state, but do not download or expose media files unless a future explicit feature adds that behavior.
