## ADDED Requirements

### Requirement: Silent Companion Device With Media-Retry Exception

The live client SHALL behave as a silent companion device: it MUST NOT send message sends, read receipts, played receipts, presence, typing indicators, chat modifications, deletes, or group/profile writes. The ONLY outbound WhatsApp traffic the system may originate is a media re-upload request used to recover expired media. This exception MUST be implemented as an explicit, auditable allowance so that every receipt- and presence-related method remains blocked, preserving the property that archiving media never marks a view-once message as opened.

#### Scenario: Receipt and presence methods stay blocked

- **WHEN** any code path attempts to send a read receipt, played receipt, presence, typing, delete, or chat modification through the live client
- **THEN** the attempt is refused, exactly as before this change

#### Scenario: Media re-upload is the only permitted outbound

- **WHEN** the media layer needs to recover expired media
- **THEN** it may send a media re-upload request, and no other outbound WhatsApp method is enabled by that allowance

#### Scenario: Archiving does not mark messages opened

- **WHEN** the maintainer downloads media, including view-once media
- **THEN** no read or played receipt is sent, so the sender's and user's view-once state is unchanged

### Requirement: Live Ingestion Drives Media Download

Live ingestion SHALL, in addition to persisting message records, capture the media descriptor of media-bearing messages and enqueue them for background download through the durable media queue, on both real-time and history-sync event paths. Supporting media download without capturing the descriptor from the live event — where it is available before normalization — does not satisfy this requirement.

#### Scenario: Real-time media is enqueued

- **WHEN** a real-time media message is ingested
- **THEN** its descriptor is captured and enqueued for download

#### Scenario: History-sync media is enqueued

- **WHEN** media-bearing messages arrive through history sync
- **THEN** their descriptors are captured and enqueued for download the same way as real-time media

### Requirement: Edit History Retention

When a live edit is applied to an archived message, the system SHALL first snapshot the message's current content as a retained revision (revision order, content, edit time) keyed to the message's canonical identity, so the pre-edit content is never lost. Applying multiple edits SHALL retain each prior revision in order. Revision retention applies to edits observed live; the system MUST NOT fabricate history for edits that predate observation.

#### Scenario: Edit preserves the prior version

- **WHEN** a live edit arrives for an archived message
- **THEN** the pre-edit content is stored as a revision before the message reflects the edited content

#### Scenario: Multiple edits accumulate revisions

- **WHEN** a message is edited more than once while observed live
- **THEN** each prior version is retained as an ordered revision

#### Scenario: Unobserved edits claim no history

- **WHEN** a message was already edited before the archive ever observed it
- **THEN** the message may carry an edited indication but presents no fabricated prior revisions
