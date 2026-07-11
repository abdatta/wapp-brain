## Purpose

Define the canonical identity model for the archive: one person, chat, and message resolves to one record across backup, history-sync, and live sources; LID-to-phone mappings are persisted and merged late; display rules guarantee human-readable names with phone fallback; groups are actively named; and unresolved identities are reported as identity health rather than silently degrading.

## Requirements

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
The system SHALL persist LID-to-phone identity mappings discovered from any source — history-sync mapping batches, live mapping-update events, contact records carrying both forms, contact databases (`wa.db`) where present, and the message-store database's LID mapping table (`jid_map`) where present — and SHALL canonicalize every JID against the persisted mappings at ingest time. Each persisted mapping SHALL record the source it was actually learned from.

#### Scenario: Mapping learned from history sync
- **WHEN** a history-sync payload includes LID-to-phone mappings
- **THEN** subsequent ingestion of either form canonicalizes to the phone form, surviving process restarts

#### Scenario: Mapping learned from a contact record
- **WHEN** a contact arrives carrying both a LID and a phone-number identity
- **THEN** the mapping is persisted as if it had arrived from a mapping event

#### Scenario: Mapping learned from the message-store mapping table
- **WHEN** an imported message-store database contains a LID-to-phone mapping table relating its internal JID rows
- **THEN** every well-formed LID-to-phone pair in it is persisted before messages are ingested, and each persisted link records the message-store table as its source

#### Scenario: Message-store without a mapping table
- **WHEN** an imported message-store database has no LID mapping table (legacy schema)
- **THEN** the import proceeds unchanged with no new links and no errors

### Requirement: Late Identity Merge
When a mapping is learned for an identity that already has archive records under its LID form, the system SHALL merge those records onto the canonical identity: chats, contacts, messages, participants, live checkpoints, and gap windows. Merges MUST be idempotent, MUST prefer the richer value for each conflicting field, and MUST route memory citations referencing merged rows through the existing staleness machinery rather than leaving them dangling. Mappings newly learned during a backup import SHALL be merged by the import itself, with visible progress, before that import ingests messages — the background sweep remains only as a backstop for links learned while no import is running.

#### Scenario: Split DM chats merge
- **WHEN** a DM chat exists under both `<lid>@lid` and `<phone>@s.whatsapp.net` and the mapping between them is learned
- **THEN** the archive presents one chat containing both message histories, and the LID-form record is gone

#### Scenario: Duplicate message rows collapse
- **WHEN** merging re-keys a message onto an identity where the same WhatsApp message id already exists
- **THEN** the two rows collapse into one, keeping the richer content

#### Scenario: Merge is restart-safe
- **WHEN** the process stops mid-merge and the merge re-runs
- **THEN** the outcome is the same as a single uninterrupted merge

#### Scenario: Import-learned links merge within the import
- **WHEN** a backup import learns mappings for identities that already have LID-form archive records
- **THEN** the import merges those identities before ingesting messages, reports the merge as import progress, and the re-imported messages land in the canonical chats without transient duplication

#### Scenario: Already-known links do not re-merge
- **WHEN** the same backup is re-imported and its mappings are already persisted
- **THEN** no merge work runs for them and the import outcome is unchanged

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
Identity enrichment SHALL apply retroactively to already-archived chats and senders. Enrichment sources are the contact database (`wa.db`) where present, explicitly connected Google Contacts, and the message-store database's LID display-name table (`lid_display_name`) where present. A saved WhatsApp contact-database name SHALL take precedence over a Google Contacts name, and both SHALL take precedence over a message-store display-cache or push name for the same identity. Google enrichment SHALL only fill unresolved or weaker phone identities and MUST NOT guess a phone mapping. Each enrichment operation SHALL report source-appropriate counts so the user can tell whether it worked, including when a source contributes nothing.

#### Scenario: Names improve after the fact
- **WHEN** a `wa.db` with matching contacts is imported after messages already exist
- **THEN** existing chats and senders display the enriched names without re-importing messages

#### Scenario: Google contact resolves an archived phone identity
- **WHEN** an explicitly connected Google account contains an unambiguous international phone number for an archived identity whose name is unresolved or weaker
- **THEN** existing chats and senders display the Google contact name without re-importing messages

#### Scenario: Phone display-cache names resolve LID identities
- **WHEN** the message-store database carries a display name for a LID identity that has no saved contact name
- **THEN** chats and senders under that identity (or its merged canonical form) display that name instead of an unresolved state

#### Scenario: Stronger saved names beat Google and display-cache names
- **WHEN** the WhatsApp contact database, Google Contacts, and the message-store display cache carry names for the same identity
- **THEN** the WhatsApp contact database's name is displayed, followed in precedence by Google Contacts and then the display cache

#### Scenario: Enrichment is reported per source
- **WHEN** a database import or Google Contacts sync completes
- **THEN** the operation reports contacts read and names improved plus its source-specific identity-link, match, ambiguity, or skip counts, even when the source contributed nothing

### Requirement: Legacy Archive Detection
Because message identity changed incompatibly, the system SHALL detect archives created before this capability and refuse to operate on them with a clear instruction to re-initialize and re-import, rather than mixing incompatible identity schemes.

#### Scenario: Old archive is detected
- **WHEN** the server or CLI opens an archive whose schema predates canonical identity
- **THEN** it reports that the archive must be re-initialized and re-imported (fresh backup + re-pair), and does not ingest into it
