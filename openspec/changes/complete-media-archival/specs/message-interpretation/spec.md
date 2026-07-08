## ADDED Requirements

### Requirement: Media Availability Is Interpreted Honestly

Message interpretation SHALL reflect real per-message media availability instead of asserting a fixed claim that media is never kept. When a media message's bytes are stored, interpretation MUST NOT present a "media is not kept" reason; when they are absent, interpretation SHALL state the specific honest reason (downloading, expired/unrecoverable, not captured while offline, or missing from the import folder). This availability MUST be produced from the shared server-side source of truth and exposed through the read APIs, so every consumer — thread view, second-brain evidence, search indexing, and any MCP or agent-facing surface — sees the same media availability without reimplementing the logic.

#### Scenario: Stored media drops the "not kept" reason

- **WHEN** interpretation runs for a view-once or other media message whose bytes are stored
- **THEN** it reports the media as available and does not claim the media is unkept

#### Scenario: Unavailable media carries an honest reason

- **WHEN** interpretation runs for a media message whose bytes are not stored
- **THEN** it carries the specific reason (downloading, expired/unrecoverable, not captured, or import-missing)

#### Scenario: Consumers read availability without their own logic

- **WHEN** a media message is read through the repository APIs by any consumer
- **THEN** the record is self-describing about media availability, requiring no consumer-side reimplementation of availability logic

### Requirement: Deleted Messages Preserve Held Content

Interpretation of a deleted (revoked) message SHALL preserve any content the archive captured before the deletion: held text, caption, and media MUST remain exposed through the read APIs together with the deleted state, rather than being replaced by a content-erasing label. The bare "Deleted message" placeholder SHALL be produced only when no content was ever captured for the deleted message. The deleted state itself MUST always be exposed so consumers can present a deletion indicator.

#### Scenario: Deleted message with captured content keeps it

- **WHEN** a message whose text or media the archive already captured is later deleted by the sender
- **THEN** reads return the captured content together with the deleted state, not a bare "Deleted message" replacement

#### Scenario: Deleted message without captured content stays a placeholder

- **WHEN** a deleted message never had content captured (for example a backup-imported revocation tombstone)
- **THEN** interpretation yields the honest "Deleted message" placeholder

#### Scenario: Deleted state reaches every consumer

- **WHEN** any consumer reads a deleted message through the repository APIs
- **THEN** the record carries the deleted state so the consumer can indicate deletion without losing the held content

### Requirement: Edited State Is Exposed

Interpretation SHALL expose whether a message was edited and whether prior revisions are held, from the shared server-side source of truth, so consumers can show an edited indicator and offer revision history where it exists without client-side inference.

#### Scenario: Edited flag is exposed

- **WHEN** a message that was edited is read through the repository APIs
- **THEN** the record identifies it as edited

#### Scenario: Revision availability is exposed

- **WHEN** an edited message has retained prior revisions
- **THEN** the record indicates revision history is available for retrieval
