# Architecture

## Runtime

The app is a Node.js/TypeScript project with:
- Express API server.
- React/Vite client.
- SQLite local archive through `better-sqlite3`.
- CLI commands for initialization, import, inspect, cleanup, fixtures, and doctor checks.
- Optional live WhatsApp maintainer using a code-level WhatsApp Web client adapter.

Default local endpoints:
- Vite dev UI: `http://127.0.0.1:5900`
- Production-style server/API: `http://127.0.0.1:3600`

## Data Flow

```text
user files/key
  -> validation
  -> decrypt or open msgstore and optional contacts sidecar
  -> SQLite schema inspection
  -> defensive WhatsApp parser
  -> normalized records
  -> ArchiveRepository
  -> local SQLite archive
  -> local API
  -> React viewer
```

Optional live maintenance flow:

```text
server start
  -> reconcile stale session/run state
  -> auto-resume when linked credentials exist (LIVE_AUTO_RESUME)
  -> local WhatsApp Web protocol client
  -> live/offline/history events + message state updates (edits/deletes/reactions)
  -> live normalizer
  -> ArchiveRepository upserts (deletes tombstone originals)
  -> per-chat checkpoints and evidence-based gap windows
  -> periodic bounded recovery loop (closes gaps from ingested evidence)
  -> local API/UI health, grouped uncertainty, and re-pair alerts
```

Live gap detection is evidence-based: a gap opens only when platform-reported
chat recency is newer than the chat's archived watermark, and it closes only
when covering history evidence has actually been ingested. Quiet chats never
open gaps. Windows beyond the platform recovery horizon are reported as grouped
uncertainty instead of per-chat alerts. A logged-out linked device stops
reconnection and surfaces a re-pair action instead of retrying forever.

## Identity Model

One WhatsApp message = one archive row, keyed by `(canonical chat JID, key_id)`
across every source (backup import, history sync, live delivery). LID↔phone
mappings are persisted in `identity_links` and every JID canonicalizes through
them at the repository write boundary; mappings learned late trigger an
idempotent merge of chats, contacts, messages, checkpoints, and gap windows
recorded under the LID form. Display identity is name → push name → phone
number — never a raw identifier; unnamed groups and unresolved LID identities
are counted as identity health and surfaced as alerts. Archives written under
the previous identity scheme are refused with a re-import instruction
(`schema_meta.identity_version`); there is no migration path by design.

## Message Interpretation

Every archived message resolves to honest meaning through one shared type
vocabulary: backup Android type codes (`messageTypeFromCode`) and live payload
keys (`detectMessageType`) map to the same type strings (poll, event, album,
view-once media, business template/list, group invite, payment invite, status
mention, history share, admin-revoked, waiting-for-message…). User-confirmed
codes only — unconfirmed codes stay `unknown_<code>` and render as a quiet
"Legacy message"; `npm run unknown-report` regenerates the private mapping
worksheet, preserving annotations, for anything still unidentified.
Interpretation (`src/server/interpretation/messageInterpretation.ts`) is a
server-side contract: message DTOs and memory evidence carry `{ label, reason }`
so the thread view, second brain, and future search/MCP/agent consumers present
the same meaning without client string logic. A bare "Unsupported message" is
never produced; the truly unreadable states why.

Backup sidecar tables enrich mapped types at import (poll questions/options,
event details, template text and buttons, group-invite names), and
`message_add_on` records converge through the same targeted state-update path
live sync uses: reactions, edit history, poll votes, and event responses apply
to the original message keyed by canonical identity. Android re-keys edited
messages in place, so the importer keys edited rows by their
`message_edit_info.original_key_id` — the identity live sync archived them
under.

Message secrets (WhatsApp's per-message key layer) are stored by default —
captured live from envelopes and backfilled from the backup's `message_secret`
table — so secret-encrypted updates decrypt immediately or retroactively. Poll
votes and event responses use Baileys' decryptors; secret-encrypted message
edits (`secretEncryptedMessage`, `MESSAGE_EDIT`) are decrypted locally with the
same message-secret AES-GCM scheme (HKDF info `"Message Edit"`, empty AAD, keyed
on the editor's LID) and applied in place as normal edits with retained history,
so a modern encrypted edit updates the original message rather than showing a
placeholder. The edit envelope is never a standalone row — it targets another
message, like poll votes. Undecryptable payloads are retained keyed to their
target until their secret (or LID) is known. Secrets never appear in logs, DTOs,
exports, or diagnostics.

Second-brain memory flow:

```text
archive messages
  -> completed source window selection
  -> evidence packs with stable citation labels
  -> local extractive or explicitly opted-in Codex generation
  -> citation validation
  -> SQLite memory ledger
  -> Obsidian-compatible Markdown under .wapp-brain/memory/pages
  -> local query over long-term pages plus short-term messages
```

## Private Workspace Boundary

The public repo contains the engine: importer, local API/UI, schema, templates, tests, and docs.

Repo-local private data lives under `.wapp-brain/` by default and stays gitignored. This includes WhatsApp SQL files, decrypted working files, the local archive, debug logs, generated second-brain wiki pages, summaries, embeddings, and retrieval indexes.

## Important Modules

- `src/server/server.ts` exposes the local API and serves built assets.
- `src/server/cli.ts` handles command-line workflows, progress bars, and debug logs.
- `src/server/config.ts` reads `.env` settings.
- `src/server/import/decrypt.ts` prepares plaintext or crypt15 SQLite inputs, including msgstore and contacts sidecar databases.
- `src/server/import/parser.ts` converts WhatsApp-like schemas into normalized records.
- `src/server/import/importer.ts` orchestrates import runs and message batching.
- `src/server/live/*` owns the optional live maintainer adapter, normalization, gap auditing, and bounded recovery.
- `src/server/memory/*` owns private second-brain consolidation, provider status, citation validation, Markdown artifact writes, and layered memory query.
- `src/server/db/repository.ts` defines the storage interface.
- `src/server/db/sqliteRepository.ts` owns the archive schema and SQL.
- `src/client/App.tsx` is the primary local UI.

## Storage Boundary

The parser and UI should not depend directly on SQLite. They should depend on normalized types and the `ArchiveRepository` contract.

This is intentional because a future Postgres/Supabase backend should be able to implement the same repository without changing the WhatsApp parser or most of the UI/API surface.

## Current SQLite Tables

The archive stores:
- `import_runs`
- `import_warnings`
- `contacts`
- `chats`
- `chat_participants`
- `messages`
- `live_sessions`
- `live_sync_runs`
- `live_chat_checkpoints`
- `live_gap_windows`
- `live_event_receipts`
- `live_message_updates`
- `identity_links`
- `message_secrets`
- `retained_encrypted_payloads`
- `memory_runs`
- `memory_source_windows`
- `memory_evidence_packs`
- `memory_pages`
- `memory_page_revisions`
- `memory_citations`
- `memory_validation_issues`
- `memory_job_locks`

Messages and entities use stable source-derived keys where possible so repeated imports can update existing rows instead of duplicating them.

Live sync is modeled as a separate source feeding the same normalized archive. Import runs remain distinct from live sync runs, while contacts, chats, and messages still converge through stable source-derived keys.

Reply quote snapshots converge through that same message path. Backup and live envelopes monotonically enrich one local snapshot owned by the reply; evidence consumes it as non-citable context and the thread UI uses it for local previews. When an enrichment changes a reply used by a current episode, its exact window is marked stale and queued for replacement without advancing the archive watermark.

Second-brain memory is derived data. SQLite stores the run ledger, source windows, page revisions, citations, validation issues, and job lock. Markdown pages and citation sidecars are written under `.wapp-brain/memory/` by default. Pages use YAML front matter, stable IDs, tags, aliases, and plain Markdown so the folder can be opened by Obsidian or another local Markdown tool later without coupling the core app to that tool.

## Future Postgres/Supabase Notes

A future adapter should map:
- SQLite integer primary keys to Postgres identity/BIGSERIAL columns.
- JSON text columns to `jsonb`.
- stable unique source keys to unique indexes.
- message pagination to indexes on `(chat_id, timestamp_ms, id)`.

Do not default to Supabase or another remote service. WhatsApp archives are private, and remote storage must be explicit opt-in.
