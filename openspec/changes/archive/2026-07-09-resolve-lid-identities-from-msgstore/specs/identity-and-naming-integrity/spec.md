# Delta Spec: identity-and-naming-integrity (resolve-lid-identities-from-msgstore)

## MODIFIED Requirements

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

### Requirement: Visible Contact Enrichment
Identity enrichment from imported databases SHALL apply retroactively to already-archived chats and senders. Enrichment sources are the contact database (`wa.db`) where present and the message-store database's LID display-name table (`lid_display_name`) where present; a saved contact-database name SHALL take precedence over a message-store display-cache name for the same identity. The import summary SHALL report contacts read, identity links learned per source, LID display names read, and display names improved, so the user can tell whether enrichment worked — including when the contact database is missing or empty.

#### Scenario: Names improve after the fact
- **WHEN** a `wa.db` with matching contacts is imported after messages already exist
- **THEN** existing chats and senders display the enriched names without re-importing messages

#### Scenario: Phone display-cache names resolve LID identities
- **WHEN** the message-store database carries a display name for a LID identity that has no saved contact name
- **THEN** chats and senders under that identity (or its merged canonical form) display that name instead of an unresolved state

#### Scenario: Saved names beat display-cache names
- **WHEN** both the contact database and the message-store display cache carry a name for the same identity
- **THEN** the contact database's name is the one displayed

#### Scenario: Enrichment is reported per source
- **WHEN** an import completes
- **THEN** the import summary shows contacts read, identity links learned (per source), LID display names read, and names improved — even when the contact database contributed nothing
