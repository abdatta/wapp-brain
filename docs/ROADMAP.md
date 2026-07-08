# Roadmap

This is a direction document, not a commitment to build every item immediately.

## Phase 1: Backup Import

Goals:
- import Android backup data
- keep everything local
- preserve enough metadata for future parser improvements
- provide a UI for manual validation
- keep re-imports idempotent

Likely next improvements:
- test with real user-supplied backups
- document real-device extraction paths more clearly
- improve unsupported-schema diagnostics
- improve contact/name resolution when `wa.db` is missing

## Phase 2: Live WhatsApp Store

Goal: keep the archive updated as new messages arrive.

Initial approach:
- use Baileys behind a narrow code-level WhatsApp Web adapter
- normalize live events into the same archive tables
- make live ingestion resumable and idempotent
- clearly separate backup import runs from live sync runs
- track per-chat checkpoints, suspected gaps, and bounded recovery status
- flag chats as uncertain or needs-user-action when WhatsApp Web cannot prove enough history

Current limits:
- the maintainer is opt-in and CLI-first for real pairing/running
- on-demand history reliability must be verified with a real linked-device spike
- media is downloaded and archived by the live maintainer (view-once included); the single write exception to the read-only posture is the scoped media re-upload request
- browser automation clients are intentionally out of scope

Open questions:
- ideal backfill limits after real-device testing
- whether auth state should move from private files to a SQLite-backed key store
- how broadly to apply edits, reactions, and receipts in the UI

## Phase 3: Search And Retrieval

Goal: make the local archive useful as memory.

Likely work:
- full-text search over local messages
- date, sender, chat, and message-type filters
- durable source IDs for citations
- optional local embedding index
- privacy review before any hosted embedding/LLM service

## Phase 4: Second Brain

Goal: generate a private second-brain wiki and answer questions about the user's WhatsApp messages with citations.

Current foundation:
- local memory runs and source-window ledger
- Obsidian-compatible Markdown pages under `.wapp-brain/memory/pages`
- citation sidecars and SQLite citation maps back to exact messages
- manual and scheduler-ready REM commands
- local retrieval across committed memory plus short-term current messages
- explicit Codex provider opt-in for future high-reasoning generation

Minimum bar:
- answer natural-language questions
- cite exact source messages/chats/timestamps
- distinguish direct evidence from inference
- avoid inventing unsupported claims
- support follow-up inspection in the local UI

Possible features:
- people and relationship timelines
- conversation summaries
- decision and commitment extraction
- reminders and unresolved threads
- topic maps
- personal memory search
- exportable cited reports
- repo-local private wiki artifacts under `.wapp-brain/memory/`

Continue improving this layer only while preserving exact source citations and local-first defaults.
