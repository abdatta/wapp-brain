# Future Agent Guide

Wapp Store is a local-first WhatsApp message store. It starts with importing user-supplied Android backup files, grows into a live-updated archive, and eventually supports a Karpathy-style second brain with cited answers.

## North Star

Build a trustworthy local archive of the user's WhatsApp messages.

Focus:
- Import Android backup data from user-supplied files.
- Store normalized chats, contacts, participants, messages, and source metadata locally.
- Let the user browse and validate the imported archive in a polished local UI.

Direction:
- Add live ingestion through Baileys or another explicit user-controlled WhatsApp client bridge.
- Keep the local archive updated as new messages arrive.
- Build a second-brain layer on top: search, retrieval, summarization, question answering, and citations back to exact messages.

## Non-Negotiable Guardrails

- Keep WhatsApp data local by default.
- Do not upload chats, contacts, metadata, media, decrypted databases, keys, or logs to external services.
- Do not use WhatsApp Web scraping for backup import.
- Do not bypass protections or recover data without user-supplied files and keys.
- Do not log backup keys, decrypted database contents, message bodies, or raw row dumps by default.
- Treat `.wapp-store/`, `msgstore*`, `*.crypt*`, `wa.db`, media folders, keys, exports, and `.env` as sensitive.

Remote Postgres, Supabase, hosted vector databases, or hosted LLM workflows must be explicit opt-in because they move private messages off the machine.

## Implementation

Runtime:
- Node.js/TypeScript.
- Express local API bound to `127.0.0.1` by default.
- React/Vite local UI.
- SQLite archive file at `.wapp-store/archive.sqlite` by default.

Import path:
- Plaintext `msgstore.db` is supported for fixtures or already-decrypted local files.
- `msgstore.db.crypt15` is supported with a user-supplied 64-character key or `encrypted_backup.key`.
- `wa.db` is optional and enriches contact/chat names when available.
- A media directory can be supplied as context, but media files are not copied or served yet.

Storage:
- Parser/import code writes through `ArchiveRepository`.
- `SqliteArchiveRepository` is the durable SQLite implementation.
- Keep the repository boundary clean so a future Postgres/Supabase adapter can be added without rewriting parser or UI code.

UI:
- Initialize archive.
- Run imports from local file paths.
- Show status, warnings, and counts.
- Browse chats with search/type filters and pagination.
- Browse messages with newest-window paging, chronological display, message search, group sender names, timestamps, directions, and media placeholders.

## Main Code Map

- `src/server/server.ts` - local Express API and static app server.
- `src/server/cli.ts` - CLI commands, progress display, debug logs.
- `src/server/import/decrypt.ts` - crypt15 preparation/decryption and plaintext handling.
- `src/server/import/parser.ts` - defensive WhatsApp schema parsing.
- `src/server/import/importer.ts` - import orchestration and batching.
- `src/server/db/repository.ts` - storage boundary.
- `src/server/db/sqliteRepository.ts` - SQLite schema and persistence.
- `src/client/App.tsx` - local viewer UI.
- `tests/importer.test.ts` - importer, parser, privacy, scale, and crypt15 tests.

## Docs To Read First

- `docs/README.md` - wiki index.
- `docs/PROJECT_OVERVIEW.md` - product shape and goals.
- `docs/ARCHITECTURE.md` - runtime and data flow.
- `docs/IMPORTING_AND_DATA_MODEL.md` - import behavior and normalized records.
- `docs/SECURITY_AND_PRIVACY.md` - privacy rules.
- `docs/ROADMAP.md` - likely next phases.
- `docs/TESTING.md` - verification expectations.
- `docs/LIMITATIONS.md` - known edges.

## Development Rules

- Prefer a small working vertical slice over broad platform work.
- Inspect real SQLite schemas defensively instead of assuming one WhatsApp version.
- Preserve source metadata that can help improve future parsers.
- Keep re-imports idempotent.
- Keep logs useful but privacy-safe.
- Avoid adding services unless the user explicitly asks for them.
- Use synthetic fixtures for tests; never commit real WhatsApp files.

## Verification Checklist

Before handing off meaningful changes:
- `npm test`
- `npm run doctor`
- For frontend/API changes, run the local app and inspect the UI.
- For production serving changes, run `npm run build`.

Do not run `npm run build` just to verify docs-only cleanup if the goal is to keep generated `dist/` out of the worktree.
