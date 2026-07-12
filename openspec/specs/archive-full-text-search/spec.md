# archive-full-text-search Specification

## Purpose
TBD - created by archiving change build-the-brain. Update Purpose after archive.
## Requirements
### Requirement: Indexed Global Message Search
The system SHALL provide full-text search across all archived messages using an indexed match (word-boundary and prefix matching), never a linear scan, and SHALL return ranked results in under 2 seconds on an archive of at least 325k messages.

#### Scenario: Word search across chats
- **WHEN** the user searches for a word that appears in messages across multiple chats
- **THEN** the system returns ranked hits from all matching chats with chat name, sender display name, timestamp, and a highlighted snippet

#### Scenario: Prefix matching
- **WHEN** the user searches for a term prefix (for example an incomplete word)
- **THEN** messages containing words starting with that prefix match

### Requirement: Resolved-Text Indexing
The search index SHALL index a resolved text form of each message — mention placeholders substituted with canonical display names and sender identity attached — in addition to the raw body and caption, so that person-name queries match messages that store only raw identifiers.

#### Scenario: Mention resolved in index
- **WHEN** a message body contains a mention stored as a raw JID and the mentioned identity resolves to a display name
- **THEN** searching for that display name matches the message

#### Scenario: Citations keep raw text
- **WHEN** a search hit is opened or cited
- **THEN** the stored raw message content is what is displayed and cited, not the resolved index form

### Requirement: Ingest-Time Index Maintenance
The system SHALL keep the search index current as part of message ingestion so a message is searchable as soon as it is archived, and SHALL update index entries when messages are edited, deleted, or re-resolved by identity merges.

#### Scenario: Live message searchable immediately
- **WHEN** a live-sync message is ingested
- **THEN** a search for its content finds it without waiting for any scheduled job

#### Scenario: Edit re-indexed
- **WHEN** an archived message body is overwritten by a live edit
- **THEN** search matches the new body and no longer matches removed content

#### Scenario: Identity merge re-resolves index text
- **WHEN** an identity merge changes the display name resolution for messages already indexed
- **THEN** the affected messages are re-indexed with the corrected resolved text via the staleness machinery

### Requirement: Search Filters
Search SHALL support filtering by chat, sender identity, date range, message type category (text, media, calls), and direction (incoming or outgoing), composable with the text query.

#### Scenario: Person-scoped search
- **WHEN** the user filters a query to one sender identity
- **THEN** only messages from that canonical identity (across its merged JIDs) are returned

#### Scenario: Date-range filter
- **WHEN** the user restricts a query to a date range
- **THEN** only messages whose timestamps fall inside the range are returned

### Requirement: Deep Links Into Threads
Every search hit SHALL open the containing chat positioned at the matched message.

#### Scenario: Open hit in thread view
- **WHEN** the user activates a search result
- **THEN** the thread view opens that chat scrolled to the exact message

### Requirement: Message Mentions Relation
The system SHALL capture mentioned identities per message at ingest (from live mention metadata and backup mention tables), canonicalized through identity links, and expose them for search boosting and entity-scoped queries.

#### Scenario: Mention captured at ingest
- **WHEN** an ingested message carries mention metadata
- **THEN** a mentions record links the message to each mentioned canonical identity

#### Scenario: Mentions survive identity merges
- **WHEN** two identities merge
- **THEN** mentions recorded under either identity resolve to the merged canonical identity

### Requirement: Private Rebuildable Index
All search index data SHALL live under the private workspace, be excluded from version control, and be rebuildable from the archive with a progress-reporting command.

#### Scenario: Index rebuild
- **WHEN** the user runs the search reindex command
- **THEN** the index is rebuilt from archive rows in bounded batches with visible progress and the server stays responsive throughout

#### Scenario: Rebuild progress is visible everywhere
- **WHEN** an index rebuild is running
- **THEN** its progress is visible in the UI regardless of which panel the user is looking at, survives a page reload, and is mirrored as privacy-safe lines (counts and durations only) in the server console

#### Scenario: Rebuild failure is never silent
- **WHEN** an index rebuild fails or is interrupted
- **THEN** the failure and a privacy-safe reason surface in the UI with a retry affordance and are logged to the server console, and the index state remains honestly marked as needing a rebuild

#### Scenario: Noise rows indexed but flagged
- **WHEN** system, reaction, or encrypted-update rows are indexed
- **THEN** they are searchable but excluded by the default conversation-only result filter unless the user opts to include them

