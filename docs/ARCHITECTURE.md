# Architecture

## Runtime

The app is a Node.js/TypeScript project with:
- Express API server.
- React/Vite client.
- SQLite local archive through `better-sqlite3`.
- CLI commands for initialization, import, inspect, cleanup, fixtures, and doctor checks.

Default local endpoints:
- Vite dev UI: `http://127.0.0.1:5900`
- Production-style server/API: `http://127.0.0.1:3600`

## Data Flow

```text
user files/key
  -> validation
  -> decrypt or open msgstore
  -> SQLite schema inspection
  -> defensive WhatsApp parser
  -> normalized records
  -> ArchiveRepository
  -> local SQLite archive
  -> local API
  -> React viewer
```

## Important Modules

- `src/server/server.ts` exposes the local API and serves built assets.
- `src/server/cli.ts` handles command-line workflows, progress bars, and debug logs.
- `src/server/config.ts` reads `.env` settings.
- `src/server/import/decrypt.ts` prepares plaintext or crypt15 msgstore inputs.
- `src/server/import/parser.ts` converts WhatsApp-like schemas into normalized records.
- `src/server/import/importer.ts` orchestrates import runs and message batching.
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

Messages and entities use stable source-derived keys where possible so repeated imports can update existing rows instead of duplicating them.

## Future Postgres/Supabase Notes

A future adapter should map:
- SQLite integer primary keys to Postgres identity/BIGSERIAL columns.
- JSON text columns to `jsonb`.
- stable unique source keys to unique indexes.
- message pagination to indexes on `(chat_id, timestamp_ms, id)`.

Do not default to Supabase or another remote service. WhatsApp archives are private, and remote storage must be explicit opt-in.
