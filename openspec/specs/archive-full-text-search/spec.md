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
The search index SHALL index a resolved text form of each message — mention placeholders substituted with canonical display names — in addition to the raw body and caption, so that person-name queries match messages that store only raw identifiers. The sender's display identity SHALL be indexed in a dedicated sender field carrying a lower relevance weight than every content field, rather than co-mingled with message content, so that sent-by matches remain findable but are distinguishable from content matches and do not outrank them. A result that matched only via the sender field SHALL be identifiable as such in the response.

#### Scenario: Mention resolved in index
- **WHEN** a message body contains a mention stored as a raw JID and the mentioned identity resolves to a display name
- **THEN** searching for that display name matches the message

#### Scenario: Citations keep raw text
- **WHEN** a search hit is opened or cited
- **THEN** the stored raw message content is what is displayed and cited, not the resolved index form

#### Scenario: Sender matches are identifiable and low-weight
- **WHEN** a query matches a message only through its sender's display identity
- **THEN** the message is still returned, ranked below content matches of comparable recency, and the result is marked as a sender-only match

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

#### Scenario: Index schema migration rebuilds automatically
- **WHEN** the server boots on an archive whose search index predates the current index schema (missing columns)
- **THEN** the index is recreated on the current schema and a background rebuild starts automatically with the same visible progress and failure reporting as the manual command, without waiting for a user action

### Requirement: Zero-Hit Query Relaxation
When the strict all-terms form of a query returns no rows, the system SHALL escalate through a bounded relaxation ladder — prefix-starring every eligible token, then dropping unmatchable and highest-document-frequency tokens (floor of two surviving tokens), then requiring only the best half of tokens by rarity, then a ranked OR of all tokens — stopping at the first tier that yields results. Every search response SHALL carry a match tier (`exact`, `relaxed`, or `partial`); partial responses SHALL name the dropped terms and report per-result term coverage, so degraded precision is always visible to the consumer rather than silently blended. Explicitly quoted phrases SHALL never be starred or dropped before the final OR tier. Document-frequency statistics used for dropping SHALL be derived from the search index itself (an `fts5vocab` companion) with no separately maintained vocabulary. The relaxation entry point SHALL accept a minimum-hits threshold so future consumers (the brain fast path) can demand more than one hit before accepting a tier.

#### Scenario: Typo'd non-final token recovers with a labelled partial match
- **WHEN** a multi-word query contains one mistyped token that matches nothing in the archive while its remaining tokens match archived messages
- **THEN** the system returns messages matching the remaining terms, labelled `partial`, naming the dropped token, instead of an empty result

#### Scenario: Strict hits are never relaxed
- **WHEN** the strict all-terms form of a query returns at least one row
- **THEN** the response is exactly the strict result set, labelled `exact`, and no relaxation tier executes

#### Scenario: Relaxed totals stay honest
- **WHEN** a relaxation tier produced the results
- **THEN** the reported total-match count is computed from that tier's query — the count always describes the result set actually shown, and the response carries the tier that produced it

#### Scenario: Prefix relaxation before token dropping
- **WHEN** a query token fails strict matching but is a prefix of indexed terms
- **THEN** the prefix tier returns those matches labelled `relaxed`, with all original terms still required, before any token is dropped

### Requirement: Candidate Pool Recency Guarantee
The ranking candidate pool SHALL be the deduplicated union of the top-N best-matching rows by relevance rank and the top-M most-recent rows among all matches of the same query, before recency-blended reranking, so that neither the best-matching nor the most-recent matches can be structurally excluded by the other criterion's cutoff.

#### Scenario: Recent match survives a common-term flood
- **WHEN** a query term matches more rows than the relevance pool size and a recent message matches that query with unexceptional relevance
- **THEN** that recent message is present in the rerank pool and can be returned, rather than being cut before recency scoring runs

### Requirement: Mention-Aware Ranking
A result whose message carries an authoritative structured mention (provenance bit 2 in the mentions relation) resolving to a display label that matches a query term SHALL receive an additive ranking boost over otherwise-equal results. Mentions known only from fallback text-token extraction (bit 1 alone) SHALL NOT receive the boost.

#### Scenario: Structurally mentioned person outranks passing text
- **WHEN** two otherwise equally ranked messages match a person-name query and exactly one carries an authoritative structured mention resolving to that person
- **THEN** the structurally mentioned message ranks above the other

#### Scenario: Fallback-only mentions get no boost
- **WHEN** a message's only mention record for the queried person came from text-token extraction (provenance bit 1 only)
- **THEN** its rank receives no mention boost

### Requirement: Term Alias Expansion
The system SHALL maintain a persistent term-alias table recording `(term, variant, source, weight)` rows, seeded idempotently with a conservative static list of romanized-Hindi spelling variants, and SHALL expand each query token with up to three known co-variants (bidirectional lookup) as an OR-group in the match expression at every tier, with zero model calls at query time. Alias-variant hits SHALL NOT change the reported match tier. The table SHALL accept rows persisted by other producers (the future deep retrieval path) so expansion learnings compound across queries.

#### Scenario: Romanized variant recall
- **WHEN** archived messages contain "nahi" and the user queries "nhi" (a seeded variant of the same word)
- **THEN** those messages are returned by the strict tier and the response is labelled `exact`

#### Scenario: Persisted learnings expand later queries
- **WHEN** an alias row is added to the table by any producer
- **THEN** subsequent queries containing its term or variant expand with the counterpart immediately, with no model call

### Requirement: Contextual Text Indexing
The search index SHALL carry a low-weight context field per message containing (a) link-preview title, description, and canonical URL when the message has a stored link preview, and (b) the quoted-snapshot text of a reply only when the quoted original is absent from the archive — no archived row for the quoted source id in its source chat, or that row deleted — so content not otherwise present becomes searchable without duplicating hits on originals that are present. When a quoted original is ingested after its reply was indexed, the reply's derived context SHALL be re-derived so the redundant snapshot text converges away.

#### Scenario: Reply-Privately quote becomes searchable
- **WHEN** a reply quotes a message whose original is not archived (cross-chat Reply Privately, deleted, or outside the archive window)
- **THEN** searching the quoted text finds the reply via its snapshot context

#### Scenario: In-chat quotes do not double-hit
- **WHEN** a message and a reply quoting it are both archived and live
- **THEN** a search for the quoted text matches the original message, and the reply's quoted snapshot contributes no additional hit

#### Scenario: Link-preview text becomes searchable
- **WHEN** a message carries a stored link preview whose title or description contains a queried term absent from the message body
- **THEN** the message is returned, ranked below primary-content matches of equal recency

#### Scenario: Late-arriving original demotes the snapshot copy
- **WHEN** the original of an indexed reply's quote is ingested later
- **THEN** the reply's context is re-derived without the snapshot text, leaving the original as the match for the quoted content

