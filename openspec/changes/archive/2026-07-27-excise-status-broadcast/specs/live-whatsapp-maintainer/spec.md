## MODIFIED Requirements

### Requirement: Idempotent Live Event Ingestion
The system SHALL normalize live WhatsApp contacts, chats, participants, messages, and message state updates into the archive using canonical identity keys: chats by canonical JID, messages by canonical chat JID plus WhatsApp message id. Source- or sender-form variance MUST NOT fork identity. Events addressed to `status@broadcast` are the one deliberate exception to ingestion: they SHALL be dropped at the platform event boundary before normalization, persisting nothing — WhatsApp Status is not a chat.

#### Scenario: Duplicate live message event
- **WHEN** the same WhatsApp message is received through real-time sync and later through history sync
- **THEN** the archive contains one message record updated with the best available metadata rather than duplicate messages

#### Scenario: Backup and live source overlap
- **WHEN** a message already imported from backup is later observed by live sync with the same WhatsApp message id in the same canonical chat
- **THEN** the system upserts the existing archive message instead of creating a second copy

#### Scenario: Sender-form variance does not duplicate
- **WHEN** the same message arrives once under a sender's LID form and once under their phone form
- **THEN** the archive contains one message record

#### Scenario: Status events are dropped, not ingested
- **WHEN** any live event addressed to `status@broadcast` arrives (real-time or history sync)
- **THEN** no archive row of any kind is written for it and ingestion continues normally for other chats in the same batch
