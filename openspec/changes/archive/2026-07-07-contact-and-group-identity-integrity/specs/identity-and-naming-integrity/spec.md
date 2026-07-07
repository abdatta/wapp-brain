# Delta Spec: identity-and-naming-integrity (new capability)

## ADDED Requirements

### Requirement: Canonical Message Identity
The system SHALL identify an archived message by its canonical chat JID and WhatsApp message id (`key_id`) regardless of source. Backup import, history sync, and live delivery of the same WhatsApp message MUST converge on a single archive row, and sender-identity variance (LID vs phone form, device suffixes, fromMe perspective) MUST NOT create additional rows for the same message.

#### Scenario: Backup and live copies converge
- **WHEN** a message already imported from an Android backup is later observed by live sync (or vice versa)
- **THEN** the archive contains one row for it, enriched rather than duplicated

#### Scenario: LID and phone deliveries converge
- **WHEN** the same group message is received once attributed to a sender's LID identity and once to their phone identity
- **THEN** the archive contains one row for it

#### Scenario: Messages without a WhatsApp id remain stable
- **WHEN** a backup row has no `key_id` (legacy schema edge)
- **THEN** the message receives a stable source-scoped surrogate identity that stays idempotent across re-imports of the same backup

### Requirement: Identity Mapping Persistence
The system SHALL persist LID-to-phone identity mappings discovered from any source — history-sync mapping batches, live mapping-update events, contact records carrying both forms, and contact databases (`wa.db`) where present — and SHALL canonicalize every JID against the persisted mappings at ingest time.

#### Scenario: Mapping learned from history sync
- **WHEN** a history-sync payload includes LID-to-phone mappings
- **THEN** subsequent ingestion of either form canonicalizes to the phone form, surviving process restarts

#### Scenario: Mapping learned from a contact record
- **WHEN** a contact arrives carrying both a LID and a phone-number identity
- **THEN** the mapping is persisted as if it had arrived from a mapping event

### Requirement: Late Identity Merge
When a mapping is learned for an identity that already has archive records under its LID form, the system SHALL merge those records onto the canonical identity: chats, contacts, messages, participants, live checkpoints, and gap windows. Merges MUST be idempotent, MUST prefer the richer value for each conflicting field, and MUST route memory citations referencing merged rows through the existing staleness machinery rather than leaving them dangling.

#### Scenario: Split DM chats merge
- **WHEN** a DM chat exists under both `<lid>@lid` and `<phone>@s.whatsapp.net` and the mapping between them is learned
- **THEN** the archive presents one chat containing both message histories, and the LID-form record is gone

#### Scenario: Duplicate message rows collapse
- **WHEN** merging re-keys a message onto an identity where the same WhatsApp message id already exists
- **THEN** the two rows collapse into one, keeping the richer content

#### Scenario: Merge is restart-safe
- **WHEN** the process stops mid-merge and the merge re-runs
- **THEN** the outcome is the same as a single uninterrupted merge

### Requirement: Human-Readable Display Identity
Every chat and sender presented by the system SHALL display, in order of preference: a saved contact name, a push name, or a formatted phone number. A raw internal identifier (LID, group id, device-suffixed JID) MUST NOT be the primary label. When none of the preferred forms exist, the system SHALL present an explicit unresolved state rather than the identifier.

#### Scenario: Group sender with only a push name
- **WHEN** a group message's sender has no saved contact name but a push name is known
- **THEN** the message displays the push name

#### Scenario: Sender with only a phone identity
- **WHEN** no name is known for a phone-form sender
- **THEN** the message displays the formatted phone number

#### Scenario: Unresolved LID sender
- **WHEN** a sender is known only by an unmapped LID
- **THEN** the display states the identity is unresolved and the chat/sender is counted in identity health, and the raw LID is not shown as the name

### Requirement: Group Sender Attribution
Group messages SHALL be attributed to the participant identity that sent them, sourced from every field the platform uses to carry it (the message key's participant and the message envelope's top-level participant). The group's own identity MUST NOT be recorded or displayed as a message sender: when no participant identity is available, the sender is stored and shown as unresolved.

#### Scenario: History-synced group message carries the sender outside the key
- **WHEN** a history-synced group message provides the sender only in the message envelope's participant field
- **THEN** the archived message is attributed to that participant, identical to a real-time delivery

#### Scenario: Group message with no participant identity
- **WHEN** a group message arrives with no participant identity in any field
- **THEN** the message's sender is stored as unknown and displayed as unresolved — never as the group's own name

#### Scenario: Legacy rows misattributed to the group
- **WHEN** the archive contains group messages whose recorded sender equals the group's own identity
- **THEN** the display layer treats those senders as unresolved instead of labeling them with the group's name

### Requirement: Group Naming
Group chats SHALL display their subject. While a live session is connected, the system SHALL actively fetch group metadata (subject, participants) for group chats without a known subject, bounded and rate-limited. A group whose subject cannot be resolved SHALL be presented in an explicit "unnamed group" state and counted in identity health — never labeled by its raw group id.

#### Scenario: Missing subject is fetched
- **WHEN** a group chat has no subject and the maintainer is connected
- **THEN** the system requests the group's metadata and stores the subject and participant list when returned

#### Scenario: Unresolvable group is flagged
- **WHEN** a group's subject cannot be fetched
- **THEN** the chat list shows an explicit unnamed-group state and identity health counts it

### Requirement: Mention Display Resolution
Mention tokens inside displayed message text (`@<identifier>`) SHALL resolve through the identity model to the mentioned person's display identity (name → push name → phone number) at display time. Stored message content MUST remain byte-identical to what the platform delivered; substitution is a read-path concern. A mention whose identity cannot be resolved SHALL remain unchanged rather than being replaced with a fabricated label. Read paths SHALL report which resolved labels in a message's displayed text are mentions, and the UI SHALL render mention tokens — resolved or not — in an accent style visually distinct from surrounding text (WhatsApp-style highlight).

#### Scenario: Mention of a known contact
- **WHEN** a displayed message contains a mention token whose identifier maps (directly or through an identity link) to a known contact
- **THEN** the rendered text shows the mention as the contact's display identity

#### Scenario: Mention of an unresolved identity
- **WHEN** a mention token's identifier cannot be resolved to any known identity
- **THEN** the rendered text keeps the original token unchanged

#### Scenario: Stored content is never rewritten
- **WHEN** mentions are resolved for display
- **THEN** the archived message body remains exactly as delivered

#### Scenario: Mentions are visually distinguished
- **WHEN** a message whose displayed text contains mention tokens is rendered
- **THEN** the message DTO carries the resolved mention labels and the UI shows each mention token in the accent style rather than as plain text

### Requirement: Identity Health Reporting
The system SHALL report identity health — the counts of unnamed groups and unresolved LID identities — in live status, and the UI SHALL surface a visible attention state when either count is non-zero, consistent with the rule that an unresolvable identity is an alert, not a silent fallback.

#### Scenario: Unnamed groups raise attention
- **WHEN** at least one group chat has no resolvable subject
- **THEN** live status includes the unnamed-group count and the UI shows an identity-health alert naming the affected chats

#### Scenario: Healthy identities are quiet
- **WHEN** every chat and known sender resolves to a name or phone number
- **THEN** no identity-health alert is shown

### Requirement: Visible Contact Enrichment
Contact database enrichment (`wa.db`) SHALL apply retroactively to already-archived chats and senders, and the import summary SHALL report contacts read, contacts matched to archive identities, and display names improved, so the user can tell whether enrichment worked.

#### Scenario: Names improve after the fact
- **WHEN** a `wa.db` with matching contacts is imported after messages already exist
- **THEN** existing chats and senders display the enriched names without re-importing messages

#### Scenario: Enrichment is reported
- **WHEN** an import includes a contacts database
- **THEN** the import summary shows counts for contacts read, matched, and names improved

### Requirement: Legacy Archive Detection
Because message identity changed incompatibly, the system SHALL detect archives created before this capability and refuse to operate on them with a clear instruction to re-initialize and re-import, rather than mixing incompatible identity schemes.

#### Scenario: Old archive is detected
- **WHEN** the server or CLI opens an archive whose schema predates canonical identity
- **THEN** it reports that the archive must be re-initialized and re-imported (fresh backup + re-pair), and does not ingest into it
