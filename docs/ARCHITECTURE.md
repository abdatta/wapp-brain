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

Second-brain memory is derived data. SQLite stores the run ledger, source windows, page revisions, citations, validation issues, and job lock. Markdown pages and citation sidecars are written under `.wapp-brain/memory/` by default. Pages use YAML front matter, stable IDs, tags, aliases, and plain Markdown so the folder can be opened by Obsidian or another local Markdown tool later without coupling the core app to that tool.

## Future Postgres/Supabase Notes

A future adapter should map:
- SQLite integer primary keys to Postgres identity/BIGSERIAL columns.
- JSON text columns to `jsonb`.
- stable unique source keys to unique indexes.
- message pagination to indexes on `(chat_id, timestamp_ms, id)`.

Do not default to Supabase or another remote service. WhatsApp archives are private, and remote storage must be explicit opt-in.
