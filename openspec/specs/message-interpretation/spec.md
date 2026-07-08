## Purpose

Guarantee that every archived message resolves to honest meaning: one shared type vocabulary across backup and live sources, user-confirmed type-code mappings with retroactive re-import upgrades, content extraction from backup sidecar tables, backup add-on convergence through the live state-update path, message-secret retention with late decryption of secret-encrypted updates, and a server-side interpretation contract every consumer reads. A bare "Unsupported message" is never an acceptable rendering; the truly unreadable states why.

## Requirements

### Requirement: Shared Type Vocabulary Across Sources
The system SHALL classify messages from every source — Android backup import, live history sync, and live delivery — into one shared type vocabulary, so the same real-world message kind carries the same stored type string regardless of how it reached the archive.

#### Scenario: Poll arrives via backup and via live sync
- **WHEN** a poll message is imported from a backup (Android type code) and another poll arrives through live sync (poll-creation payload)
- **THEN** both are stored with the same `poll` type and render identically

#### Scenario: Live payload kinds stop falling through
- **WHEN** a live message arrives whose payload is a poll, event, album, list, list response, button/template variant, group invite, or payment invite
- **THEN** it is stored with its real type instead of an `unknown_<key>` fallback

### Requirement: Identified Legacy Type Codes Map To Real Types
The system SHALL map user-confirmed Android backup type codes to real message types (or truthful typed placeholders), and a normal re-import of a backup SHALL retroactively upgrade previously-unknown historical rows in place — without archive re-initialization and without disturbing message identity. Mappings MUST be grounded in evidence — user confirmation on real examples or structural proof from the backup schema (media types, sidecar-table joins) — never folklore.

#### Scenario: Re-import upgrades historical unknown rows
- **WHEN** a backup is re-imported after a type-code mapping lands
- **THEN** rows previously stored as `unknown_<code>` for mapped codes carry their real types, with no new rows created and no identity change

#### Scenario: Admin-deleted messages read as deletions
- **WHEN** a backup row carries the admin-revoked type code
- **THEN** it renders in the deleted-message style attributed to admin action, never as an unsupported message

#### Scenario: Undelivered ciphertext is stated honestly
- **WHEN** a backup row represents a message the phone itself never received or decrypted ("waiting for this message")
- **THEN** the archive renders an honest placeholder stating the message never became readable, rather than implying the archive failed to interpret it

### Requirement: Unidentified Codes Degrade Honestly And Extend Without Rework
Backup type codes with no confirmed mapping SHALL be stored with their raw code preserved and SHALL render as a quiet generic legacy placeholder — never a bare "Unsupported message". Adding a newly-confirmed mapping MUST require only a mapping-table entry plus re-import; the system MUST NOT guess mappings for unconfirmed codes.

#### Scenario: Unmapped code renders as legacy placeholder
- **WHEN** a message with an unconfirmed type code is displayed
- **THEN** the UI shows a quiet "Legacy message" placeholder and the stored row retains the raw code for later mapping

#### Scenario: Later identification slots in
- **WHEN** the user identifies a previously-unknown code and the mapping table gains that entry
- **THEN** the next re-import upgrades those rows with no other code or schema change

### Requirement: Content Extraction For Mapped Types
For mapped types whose content lives in backup sidecar tables, the importer SHALL extract available content — poll question and options, event name and time, template text and button labels, group-invite group name, call metadata — into the message record, falling back to the typed placeholder when nothing is extractable.

#### Scenario: Poll question becomes searchable text
- **WHEN** a backup poll row is imported and its sidecar tables hold the question and options
- **THEN** the message body carries the question and the options are stored as structured metadata

#### Scenario: Extraction floor is the typed placeholder
- **WHEN** a mapped-type row has no extractable sidecar content
- **THEN** the message renders as its typed placeholder, never as raw fields or a bare unsupported label

### Requirement: Backup Add-On Convergence
The system SHALL parse backup add-on records — reactions, edit history, poll votes, event responses — into the same targeted state updates the live path applies to original messages, keyed by canonical message identity, idempotent across re-imports, with newest-state-wins conflict semantics against live-derived state. Because Android re-keys edited messages in place, edited rows SHALL be keyed by their original message key (the identity live sync archives them under), and rows stored under a superseded edit-key identity SHALL collapse onto the canonical row.

#### Scenario: Backup reaction matches live representation
- **WHEN** a reaction stored in a backup add-on table is imported
- **THEN** it is applied to the original message exactly as an equivalent live reaction event would be, and re-importing the same backup does not duplicate it

#### Scenario: Backup edit history is recorded
- **WHEN** a backup carries edit records for a message
- **THEN** the original message is marked edited with its history retained, matching the live edit representation

#### Scenario: Backup state never clobbers newer live state
- **WHEN** a backup add-on targets a message that live sync has since updated with newer state
- **THEN** the newest state wins and the older backup state does not overwrite it

#### Scenario: Backup poll votes attach to the poll
- **WHEN** poll-vote add-ons (already decrypted by the phone) are imported
- **THEN** the poll message carries the voters and their selected options as structured metadata

### Requirement: Message Secret Retention
The system SHALL persist per-message secrets by default: captured from incoming live message envelopes, and backfilled from the backup's message-secret table during import. Secrets MUST never appear in logs, DTOs, exports, or diagnostics, and the retention decision MUST be documented as a deliberate privacy choice.

#### Scenario: Live capture
- **WHEN** an incoming live message envelope carries a per-message secret
- **THEN** the secret is persisted keyed by that message's canonical identity

#### Scenario: Backup backfill arms historical messages
- **WHEN** a backup containing the message-secret table is imported
- **THEN** secrets are persisted for the matching archived messages, enabling later decryption of updates targeting them

#### Scenario: Secrets stay out of every output surface
- **WHEN** logs, status endpoints, message DTOs, or diagnostics are produced
- **THEN** secret material is never included

### Requirement: Late Decryption Of Retained Payloads
The system SHALL retain secret-encrypted payloads it cannot yet decrypt, keyed to their target message, and SHALL attempt decryption whenever the missing half arrives (secret learned later, or payload arriving for an already-armed message). Successful decryption applies the result as a normal state update; until then the message renders its honest encrypted-update label.

#### Scenario: Poll vote decrypts when the secret is held
- **WHEN** a secret-encrypted poll vote arrives for a poll whose secret the archive holds
- **THEN** the vote is decrypted and attached to the poll like a plaintext vote

#### Scenario: Payload waits for its secret
- **WHEN** a secret-encrypted update arrives for a message whose secret is not yet held, and a later backup import supplies that secret
- **THEN** the retained payload is decrypted retroactively and applied

#### Scenario: Secret-encrypted message edit is applied in place
- **WHEN** a secret-encrypted message edit arrives for a message whose secret the archive holds and whose editor identity is known
- **THEN** the edit is decrypted, the target message updates to the edited text with its prior version retained as history, and no standalone placeholder row is created for the edit envelope

#### Scenario: Undecryptable kinds stay honest
- **WHEN** a retained payload's kind or identity has no available decryption support
- **THEN** the payload is kept for a later attempt, and the archive never fabricates the edited content

### Requirement: Interpretation Serves Every Consumer
Message interpretation — the type string, human-readable label, unreadability reason, and extracted structured content — SHALL be produced server-side from one shared source of truth and exposed through the read APIs, so that any consumer (thread view, second-brain evidence, search indexing, an MCP or agent-facing access surface) presents the same honest meaning without reimplementing interpretation logic. Extracted text MUST land in the message's body/caption fields (the surfaces text search and future embeddings index); structured extras (poll options and votes, button labels, event responses) MUST use documented machine-readable metadata keys.

#### Scenario: Memory evidence describes non-text messages
- **WHEN** the second-brain evidence path includes a message whose meaning is a typed placeholder (poll, event, view-once photo)
- **THEN** the evidence entry carries the message's type and interpretation, allowing derived pages to describe the message honestly instead of presenting an empty row

#### Scenario: A non-UI consumer needs no client logic
- **WHEN** a message is read through the repository APIs by a consumer other than the web client
- **THEN** the returned record is self-describing — type, label or reason, and structured metadata — with no client-side string mapping required to understand it

#### Scenario: Extracted content is indexable
- **WHEN** content is extracted for a mapped type (poll question, event name, template text)
- **THEN** it is stored in the message's body or caption where text search and future semantic indexing operate, not only in display-layer output

### Requirement: Regenerable Mapping Worksheet
The system SHALL provide a local command that regenerates the unknown-type-code worksheet from the archive — per-code counts and example locations — merging previously written user annotations by code so no answer is ever lost. The worksheet SHALL live only in the private workspace and MUST never be committed to version control.

#### Scenario: Regeneration preserves annotations
- **WHEN** the worksheet is regenerated after the user has filled in some codes
- **THEN** the filled answers survive, resolved codes drop off as they gain mappings, and remaining unknowns show fresh counts and examples

#### Scenario: Worksheet stays private
- **WHEN** the worksheet is generated
- **THEN** it is written under the private workspace, excluded from version control

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
