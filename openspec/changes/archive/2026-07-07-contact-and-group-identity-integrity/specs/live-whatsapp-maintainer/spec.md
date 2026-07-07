# Delta Spec: live-whatsapp-maintainer (contact-and-group-identity-integrity)

## MODIFIED Requirements

### Requirement: Idempotent Live Event Ingestion
The system SHALL normalize live WhatsApp contacts, chats, participants, messages, and message state updates into the archive using canonical identity keys: chats by canonical JID, messages by canonical chat JID plus WhatsApp message id. Source- or sender-form variance MUST NOT fork identity.

#### Scenario: Duplicate live message event
- **WHEN** the same WhatsApp message is received through real-time sync and later through history sync
- **THEN** the archive contains one message record updated with the best available metadata rather than duplicate messages

#### Scenario: Backup and live source overlap
- **WHEN** a message already imported from backup is later observed by live sync with the same WhatsApp message id in the same canonical chat
- **THEN** the system upserts the existing archive message instead of creating a second copy

#### Scenario: Sender-form variance does not duplicate
- **WHEN** the same message arrives once under a sender's LID form and once under their phone form
- **THEN** the archive contains one message record

### Requirement: Per-Chat Checkpoints
The system SHALL maintain per-chat checkpoints for latest archived message, earliest verified covered message, latest live evidence, audit status, retry count, and next recovery attempt, keyed by canonical chat identity. When chats merge through a late identity mapping, their checkpoints and gap windows SHALL follow the merge instead of orphaning under the stale identity.

#### Scenario: Chats have different recovery windows
- **WHEN** one chat is missing ten hours of possible messages and another chat is missing one hour
- **THEN** the system records separate checkpoint and recovery windows for each chat

#### Scenario: Checkpoints survive restart
- **WHEN** the maintainer restarts after processing some chats
- **THEN** it resumes auditing from persisted per-chat checkpoints instead of starting from only a global timestamp

#### Scenario: Checkpoints follow identity merges
- **WHEN** a LID-form chat with checkpoints and open gaps merges into its canonical chat
- **THEN** auditing and recovery continue under the canonical chat without losing retry state or reopening resolved windows
