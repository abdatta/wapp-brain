# Agent Guide

Wapp Brain is a local-first WhatsApp archive and second-brain engine. It imports user-supplied Android backup data into a local SQLite archive, provides a local UI for browsing chats/messages, and is intended to grow into live ingestion plus a private second-brain wiki with citations.

## North Star

Build a trustworthy local archive of the user's WhatsApp messages, then layer search, retrieval, summarization, question answering, private wiki generation, and citations back to exact messages.

## Hard Rules

- Keep WhatsApp data local by default.
- Do not upload chats, contacts, metadata, media, decrypted databases, keys, logs, generated brain/wiki files, embeddings, or indexes unless the user explicitly opts in.
- Do not use WhatsApp Web scraping for backup import.
- Do not bypass protections or recover data without user-supplied files and keys.
- Do not log backup keys, message bodies, decrypted DB contents, or raw row dumps by default.
- Never commit real WhatsApp files, keys, media, generated archives, generated brain/wiki files, `.env`, `.wapp-brain/`, or `.second-brain/`.
- Treat remote Postgres, Supabase, hosted vector databases, and hosted LLM workflows as privacy-sensitive opt-ins.

## Local Data

- Default private workspace: `.wapp-brain/`.
- Default SQLite archive: `.wapp-brain/archive.sqlite`.
- Store repo-local private data there: WhatsApp SQL files, decrypted working files, debug logs, generated second-brain wiki pages, summaries, embeddings, and retrieval indexes.

## Implementation Notes

- Runtime: Node.js/TypeScript, Express API bound to `127.0.0.1`, React/Vite UI, SQLite via `better-sqlite3`.
- Import: plaintext `msgstore.db` for fixtures/already-decrypted files; `msgstore.db.crypt15` with a user-supplied 64-character key or `encrypted_backup.key`; optional `wa.db` for contact names; optional media directory as context only.
- Storage: parser/import code writes through `ArchiveRepository`; `SqliteArchiveRepository` is the durable adapter.
- Keep re-imports idempotent and preserve source metadata useful for future parser improvements.
- Inspect real SQLite schemas defensively instead of assuming one WhatsApp version.
- Use synthetic fixtures for tests; never commit real WhatsApp data.

## UI Design Language

These are defaults, not suggestions. A new surface that breaks one needs a stated reason.

- **Every loading state is a shimmer skeleton, never a "Loading…" string or a bare spinner.**
  The skeleton must occupy the *same box* as the loaded content — same border, radius, padding,
  and gaps — so nothing shifts when data arrives. Reuse `SkeletonRows`/`SkeletonMessages` from
  `thread.tsx` where the shape fits; otherwise write a per-surface skeleton alongside the
  component's CSS and drive it from the shared `shimmer` keyframe. Show it on first load *and*
  on refetches that change what the list means (a filter change), but not on in-place updates
  the user just triggered — a skeleton flash there reads as data loss.
- **Unknown is never zero.** While a value is loading, shimmer it; never render `0`, `—`, or an
  empty chart that a reader could mistake for a real measurement.
- **Never render a raw identifier as a name.** A NULL display name is an explicit state
  ("Unnamed group", "Unnamed channel", "Unresolved contact") — see `chatDisplayLabel`. JIDs,
  node ids, and doc ids are plumbing and do not belong in a heading.
- **No raw JSON in the UI**, and inferred values must be visually distinguishable from
  authoritative ones, with their freshness stated.
- **Anything that can take ~1s or more shows progress and never blocks the event loop.** Failures
  surface in the UI *and* the server console — never silently.
- **Counts are clickable or they are noise.** A number the user cannot open is a dead end once a
  list runs to hundreds of rows.

## Docs

- `docs/README.md` - wiki index.
- `docs/PROJECT_OVERVIEW.md` - product overview.
- `docs/ARCHITECTURE.md` - app/data flow.
- `docs/IMPORTING_AND_DATA_MODEL.md` - importer behavior.
- `docs/SECURITY_AND_PRIVACY.md` - privacy guardrails.
- `docs/ROADMAP.md` - future live store and second brain.
- `docs/TESTING.md` - verification.
- `docs/LIMITATIONS.md` - known edges.

## Verification

- Meaningful changes: run `npm test` and `npm run doctor`.
- Frontend/API changes: run the local app and inspect the UI.
- Production serving changes: run `npm run build`.
- Do not run `npm run build` just to verify docs-only cleanup if the goal is to keep generated `dist/` out of the worktree.
