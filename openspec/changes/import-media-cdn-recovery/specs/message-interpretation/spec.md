## MODIFIED Requirements

### Requirement: Media Availability Is Interpreted Honestly

Message interpretation SHALL reflect real per-message media availability instead of asserting a fixed claim that media is never kept. When a media message's bytes are stored, interpretation MUST NOT present a "media is not kept" reason. When they are absent, interpretation SHALL state the specific honest reason: queued or downloading for recovery from the backup's descriptor; expired/unrecoverable; not captured while offline; or no recoverable copy (the phone never saved a local file and the backup holds no recovery keys). Interpretation MUST NOT tell the user the media was missing from the folder they selected when the media was never saved on the device. This availability MUST be produced from the shared server-side source of truth and exposed through the read APIs, so every consumer — thread view, second-brain evidence, search indexing, and any MCP or agent-facing surface — sees the same media availability without reimplementing the logic.

#### Scenario: Stored media drops the "not kept" reason

- **WHEN** interpretation runs for a view-once or other media message whose bytes are stored
- **THEN** it reports the media as available and does not claim the media is unkept

#### Scenario: Recoverable media reads as queued, not missing

- **WHEN** interpretation runs for a media message that is queued or downloading for recovery from its backup descriptor
- **THEN** it carries a "queued/downloading to recover" reason rather than a folder-missing reason

#### Scenario: Never-downloaded media reads honestly

- **WHEN** interpretation runs for a media message the phone never saved locally and for which the backup holds no recovery keys
- **THEN** it carries a "not saved on your phone / no recoverable copy" reason, not "missing from the imported media folder"

#### Scenario: Consumers read availability without their own logic

- **WHEN** a media message is read through the repository APIs by any consumer
- **THEN** the record is self-describing about media availability, requiring no consumer-side reimplementation of availability logic
