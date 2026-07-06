## Context

Wapp Brain currently imports WhatsApp backups into a local SQLite archive, can maintain a live store through an explicit local linked-device flow, and keeps private generated artifacts under `.wapp-brain/`. The roadmap names a private second-brain layer, but the app does not yet have a memory data model, consolidation runner, cited wiki output, query overlay, or model adapter.

This change adds that layer as a local-first system with an explicit remote-model opt-in. The long-term memory store is private generated data. It can use Codex credentials from the sibling `gpt-oauth-client` package only after the user enables that provider and acknowledges that selected WhatsApp-derived evidence will be sent to the model. Current-day messages remain short-term archive data until a consolidation run commits a completed source window.

## Goals / Non-Goals

**Goals:**
- Generate and maintain a Karpathy-style private second-brain wiki from WhatsApp archive data.
- Support manual runs now and a scheduler-ready job model for interval or end-of-day runs later.
- Keep consolidation idempotent, resumable, and auditable through a source-window ledger.
- Require exact citations from every durable claim back to archive message records.
- Let reads query both committed long-term memory and short-term recent messages.
- Provide a narrow Codex model adapter with high-reasoning generation controls and local OAuth session storage.
- Keep logs metadata-oriented and avoid writing prompt bodies, message bodies, raw model outputs, or credentials to default logs.

**Non-Goals:**
- Building a hosted brain service or hosted vector database.
- Automatically uploading all chats, contacts, media, indexes, or generated memory without explicit opt-in.
- Replacing the raw archive as the source of truth.
- Building a full UI editor for memory pages in the first implementation.
- Guaranteeing perfect biography, ontology, or relationship modeling on the first pass.
- Scheduling through OS-specific background services in the first implementation. The runner will expose commands and state that a scheduler can call later.

## Decisions

### Decision: Use a layered memory model

The system will distinguish:
- Archive: immutable-ish source of truth for imported and live WhatsApp messages.
- Short-term memory: unconsolidated archive messages since the last committed source window, especially current-day chats.
- Long-term memory: generated wiki pages, summaries, indexes, and citation maps under the private workspace.

The long-term layer will never replace the archive. It records derived claims and their citation edges. Query surfaces combine long-term hits with short-term message search so recent conversations are available before the next REM run.

Alternatives considered:
- Generate one full wiki from scratch on every run. This is simpler but expensive, slow, and more likely to destabilize existing pages.
- Store only embeddings and answers, with no wiki files. This is easier for retrieval but does not satisfy the second-brain wiki goal or provide inspectable memory.

### Decision: Track source windows and page revisions

Each consolidation run will claim a deterministic source window such as `start_at_ms`, `end_at_ms`, `chat_source_ids`, and `source_message_key` bounds. A run writes a ledger before generation, marks evidence packs in progress, and commits page revisions only after citation validation passes. Re-running the same window either becomes a no-op or produces a replacement revision with the same source coverage.

The durable state can live in SQLite tables alongside the archive, while generated Markdown/JSON artifacts live under `.wapp-brain/memory/` by default. The repository should expose this behind a `MemoryRepository` style interface rather than scattering direct filesystem and SQLite access through the runner.

Alternatives considered:
- Store everything as Markdown only. This is human-readable but awkward for idempotency, query, and validation.
- Store everything in SQLite only. This is robust for query but loses the wiki artifact shape the user wants.

### Decision: Require structured model output with citation validation

The model will receive evidence packs that assign stable local citation labels to exact archive messages. Model output must be structured enough to validate every durable claim and memory-page change before commit. The validator will reject unsupported claims, unknown citation labels, citation-free assertions, malformed JSON/Markdown front matter, and source references outside the run window.

Generated pages should include human-readable Markdown plus machine-readable front matter or sidecar JSON containing page ID, revision ID, source windows, citations, confidence, and last consolidated timestamp.

Alternatives considered:
- Trust plain Markdown output from the model. This is faster to prototype but makes citations fragile.
- Store only raw model output and validate later. That risks committing unsupported memory.

### Decision: Build a narrow Codex adapter around the sibling OAuth client

The model boundary will be a local interface such as `MemoryModelClient.generateStructuredMemoryUpdate()`. The first remote provider can wrap the sibling `gpt-oauth-client` package, using a session path under the private workspace, token refresh, `store: false`, and high-reasoning request options where supported. Wapp Brain should not depend directly on broad ChatGPT concepts throughout the consolidation code.

The adapter must be opt-in because prompts contain WhatsApp-derived evidence. `doctor` should report whether the optional package is present and whether a session exists, but must not print tokens, account IDs in sensitive detail, prompts, or message bodies.

Alternatives considered:
- Call OpenAI APIs directly with an API key. That is simpler for hosted API workflows but does not match the user's Codex credentials request.
- Implement consolidation with local-only heuristics first. This preserves privacy but does not satisfy the requested smart high-reasoning wiki generation.

### Decision: Commit completed windows and leave current-day messages short-term by default

The REM run will default to consolidating messages older than a cutoff, such as the end of the previous local day. Messages after that cutoff remain queryable as short-term archive context and are not treated as stable long-term memory until a later run. Manual runs can override the window when the user wants immediate consolidation.

Alternatives considered:
- Consolidate continuously after every new message. This increases churn and model calls, and makes page history noisy.
- Consolidate only on explicit user command. This is safe but does not prepare the system for scheduled long-term memory.

### Decision: Query long-term memory and short-term archive separately, then merge

Read queries will retrieve candidate memory pages and citations from the long-term index, plus recent unconsolidated messages from the archive. Answers must label whether evidence came from committed memory or short-term messages, and every answer citation must resolve to a local archive message or a memory page that itself has message citations.

Alternatives considered:
- Query only the wiki. This misses today's conversations.
- Query only raw messages. This ignores compressed long-term context and makes broad questions expensive.

## Risks / Trade-offs

- Remote reasoning can leak private message content if enabled -> Require explicit provider opt-in, keep local-only default, show privacy warnings, and offer dry-run evidence previews before sending.
- Model output may invent claims -> Require structured output, citation coverage, source-window validation, and rejection of unsupported claims.
- Citations may become stale after archive re-import or replace -> Use stable `source_message_key`, `source_chat_id`, source table/row metadata, timestamps, and local message IDs where available; mark memory pages stale if cited messages disappear.
- Large archives may exceed model context limits -> Chunk by chat, time, topic, and evidence pack size; summarize in stages while preserving source citations at each stage.
- Incremental updates can cause wiki drift -> Keep page revisions, source-window ledgers, and periodic audit/rebuild commands that compare pages against citations.
- Scheduler runs could overlap with live ingestion -> Use a single memory job lock, fixed consolidation cutoff, and archive snapshot watermarks for each run.
- Generated files are sensitive -> Store under ignored private paths, include doctor checks, and update docs to warn about OS backups and manual exports.

## Migration Plan

1. Add memory configuration defaults for private storage paths, consolidation cutoff, model provider disabled state, and chunk sizes.
2. Add memory repository tables and/or sidecar schema for runs, source windows, page revisions, citations, and query indexes.
3. Implement a manual CLI runner with dry-run, run, status, resume, and validate commands.
4. Add the Codex adapter behind an optional dependency check and explicit setup command.
5. Add query APIs and CLI commands that combine long-term memory and short-term archive messages.
6. Update docs and doctor checks for generated memory data, OAuth session storage, and privacy opt-in.

Rollback is to disable memory generation, leave generated private artifacts untouched, and keep the archive unchanged. Since memory is derived data, the app can rebuild it from the archive after deleting the private memory store.

## Open Questions

- Should the default private artifact root be `.wapp-brain/memory/`, or should users be able to point it at another local Markdown folder?
- Which page taxonomy should ship first: people, topics, commitments, timelines, or a blended second-brain graph?
- Should page revisions be editable by humans before the system supports reconciling manual edits?
- How should MCP servers expose memory reads while preserving local-only defaults and exact citation links?
