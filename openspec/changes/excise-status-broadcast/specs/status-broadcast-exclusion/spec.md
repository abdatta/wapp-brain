## ADDED Requirements

### Requirement: Status Is Never Ingested
The system SHALL treat `status@broadcast` as not-a-chat on every ingestion path. Live sync SHALL drop all events addressed to `status@broadcast` at the platform event boundary, before normalization and persistence: no message rows, no chat row, no participants, no checkpoints, no stats, and no receipts derived from them. The backup importer SHALL equally skip status rows so a future backup import cannot reintroduce status data. Dropping SHALL be keyed on the chat identity (the `status@broadcast` JID / chat type `status`), never on `message_type`, because live status posts carry ordinary content types.

#### Scenario: Live status post is dropped before persistence
- **WHEN** a `messages.upsert` or history-sync event arrives whose chat is `status@broadcast`
- **THEN** nothing is written to the archive — no message, no chat row, no checkpoint — and the event is not counted as an ingestion failure

#### Scenario: Backup import skips status rows
- **WHEN** a backup import encounters messages whose chat resolves to `status@broadcast`
- **THEN** those rows are skipped without error and reported only as a skipped-count diagnostic

#### Scenario: Identity-keyed, not type-keyed
- **WHEN** a status post arrives as an ordinary `image`, `video`, or `text` message (as live status posts do)
- **THEN** it is still dropped, because exclusion keys on the chat identity rather than the message type

### Requirement: Status Media Is Never Downloaded
The system SHALL never capture, enqueue, download, or store media belonging to `status@broadcast`. No status media descriptor SHALL enter the download queue, and no status blob SHALL enter the content-addressed media store.

#### Scenario: Status media descriptor is not captured
- **WHEN** a live status post carrying downloadable media arrives
- **THEN** no media descriptor is persisted, nothing is enqueued for download, and no bytes are fetched

### Requirement: Status Is Never Brain-Processed
Brain evidence and chat selection SHALL exclude the status chat by identity (`chat_type = 'status'` / the `status@broadcast` JID) as defense in depth, independent of ingestion-layer dropping, so that status content can never produce episodes, claims, graph contributions, or any other derived artifact even if status rows exist in the archive through some past or future path.

#### Scenario: Residual status rows never become evidence
- **WHEN** status message rows exist in the archive (for example, ingested before this change) and a brain run sweeps for backlog
- **THEN** the status chat is not selected, its messages are not counted as pending or visible evidence, and no brain artifact derives from them

### Requirement: One-Time Excision Of Stored Status Data
The system SHALL provide an idempotent one-time excision that permanently removes all previously stored `status@broadcast` data: message rows, media asset records and their blob files on disk, the chat row, live checkpoints, full-text-search index entries, and all brain artifacts derived from the status chat (episodes, claims, citations, graph contributions, watermark, queued tasks) via the existing chat-scoped brain reset. The excision SHALL report what it deleted (row counts and bytes reclaimed) and SHALL be safe to re-run, deleting nothing the second time. This deletion is a deliberate, explicitly requested exception to the rule that chat data is never destroyed.

#### Scenario: Excision removes all stored status data
- **WHEN** the excision runs against an archive holding status messages, media blobs, and status-derived brain artifacts
- **THEN** afterwards no table and no on-disk media path contains `status@broadcast` data, the reclaimed byte count is reported, and unrelated chats are untouched

#### Scenario: Excision is idempotent
- **WHEN** the excision runs a second time
- **THEN** it deletes nothing, reports zero rows removed, and exits successfully

### Requirement: No Status Surfaces In The UI
No user-facing surface SHALL present WhatsApp Status as a chat: the chat list SHALL NOT offer a `status` filter, the status chat SHALL NOT appear in chat lists or search results, and no brain UI SHALL reference status-derived artifacts (which no longer exist after excision).

#### Scenario: Chat list has no status filter
- **WHEN** the user opens the chat list after this change
- **THEN** the chat-type filter control offers no `status` option and no status chat row is rendered
