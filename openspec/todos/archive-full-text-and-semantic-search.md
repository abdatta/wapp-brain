# Archive Full-Text And Semantic Search

## Type

Feature

## Status

Needs specification

## User Goal

Search the whole archive the way a second brain deserves: fast global full-text search across all chats with useful filters, and eventually meaning-based (semantic) search — all local.

## Expected Behavior

- A global search surface finds messages across every chat, not just inside the currently open chat.
- Search supports filters: sender, chat, date range, message type (text, media, calls), and direction.
- Results show enough context (chat, sender, time, snippet) to recognize the moment, and clicking a result opens that chat positioned at the message.
- Full-text matching is fast on large archives (indexed, not linear scans) and handles word-boundary and prefix matching better than substring matching.
- A later semantic layer lets the user find messages by meaning ("that conversation about renting in Lisbon") using locally computed embeddings; enabling any remote embedding/LLM service remains an explicit opt-in after privacy review.
- The second-brain memory query uses the same improved retrieval so cited answers draw from better evidence.

## Behavior Questions

- Should full-text search cover message bodies and captions only, or also contact names, group subjects, and memory pages in one unified search?
- How should semantic results be presented alongside exact-match results — merged ranking or separate sections?
- Which local embedding model/runtime is acceptable for the privacy posture and typical laptop hardware?
- Should search index updates happen at ingestion time or on a schedule?

## Privacy Notes

All indexes (full-text and vector) live under the private workspace, are gitignored, and are derived data that can be rebuilt from the archive. No search queries or content leave the machine by default.

## Acceptance Sketch

- **WHEN** the user searches a phrase globally
- **THEN** matching messages from all chats appear with chat, sender, time, and snippet, and open in place.

- **WHEN** the archive is large
- **THEN** search returns interactively fast via a local index rather than scanning every row.

- **WHEN** semantic search is enabled locally
- **THEN** meaning-based matches appear without any data leaving the machine.
