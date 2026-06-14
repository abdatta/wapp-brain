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

Likely approach:
- use Baileys or a similar explicit WhatsApp client bridge
- normalize live events into the same archive tables
- make live ingestion resumable and idempotent
- keep raw event metadata for replay/debugging
- clearly separate backup import runs from live sync runs

Open questions:
- authentication/session storage and privacy
- reconnection and missed-message recovery
- duplicate detection between backup imports and live events
- handling edits, deletes, reactions, receipts, and media

## Phase 3: Search And Retrieval

Goal: make the local archive useful as memory.

Likely work:
- full-text search over local messages
- date, sender, chat, and message-type filters
- durable source IDs for citations
- optional local embedding index
- privacy review before any hosted embedding/LLM service

## Phase 4: Second Brain

Goal: generate a private GBrain-style wiki and answer questions about the user's WhatsApp messages with citations.

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
- repo-local private wiki artifacts under `.wapp-brain/`

Do not build this layer until the archive is trustworthy enough to cite from.
