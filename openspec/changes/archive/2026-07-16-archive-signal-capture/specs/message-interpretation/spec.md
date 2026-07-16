## ADDED Requirements

### Requirement: Defensive Structured Signal Capture
The importer SHALL discover each optional signal table and required join column before reading it, SHALL normalize supported rows into typed archive records keyed by stable message, chat, and identity anchors, and SHALL keep every signal family independently optional. Missing tables, missing optional columns, malformed enrichment rows, legacy Android layouts, and iOS layouts MUST NOT fail ordinary message import. A failure in one optional family MUST NOT discard another family or an otherwise valid message. Warnings MUST identify only the table, safe row identifier, and failing field; they MUST NOT contain message text, vCard content, transcripts, coordinates, receipt payloads, keys, or raw row dumps.

#### Scenario: Modern optional tables are present
- **WHEN** a backup contains supported signal tables and their minimal join columns
- **THEN** the importer captures their valid rows into typed archive records anchored to canonical messages, chats, and JIDs

#### Scenario: Legacy source omits a signal family
- **WHEN** a backup has no location, vCard, participant-history, receipt, or media-interpretation table
- **THEN** ordinary messages and every other supported signal family still import successfully with no fabricated rows

#### Scenario: One malformed companion is isolated
- **WHEN** one optional signal row contains invalid coordinates or an invalid foreign-key reference
- **THEN** only that companion is skipped, a content-free scoped warning is recorded, and the owning message remains imported

### Requirement: System And Group History Capture
The archive SHALL persist structurally verified individual/group phone-number changes, group add/remove/join/leave/invite/accept/promote/demote events, group membership periods, and subject/description/photo/invite-link/announcement/restriction/member-add/join-approval/disappearing-setting history as typed local records when their source semantics are verified. Identity endpoints SHALL be canonical JIDs, group records SHALL be anchored to canonical chat JIDs, and available actor, affected participant, role/admin rank, join/leave bounds, event time, previous/new values, raw type, and bounded raw parameters SHALL be retained without inventing absent values. Named and numeric Baileys stub variants SHALL resolve through one versioned decoder registry. Unknown or unverified system action codes MUST remain generic system events and MUST NOT be decoded by guesswork. In particular, backup `message_system_group.is_me_joined` MUST NOT by itself prove that the archive owner joined, left, or acted.

#### Scenario: Number change retains both identities
- **WHEN** a verified number-change source row resolves an old and new JID
- **THEN** one idempotent number-change record stores both canonical identities, its chat or message anchor, event time, and provenance

#### Scenario: Current and past participants form a timeline
- **WHEN** current and past group participant tables contain join, departure, and admin information
- **THEN** the archive stores membership periods with available bounds and role provenance rather than flattening them into current membership only

#### Scenario: Group system action is verified
- **WHEN** a system message structurally identifies a participant membership or role action
- **THEN** the archive stores a typed membership event linked to the group, participant, source message, actor when known, and event time

#### Scenario: Chat metadata change is retained historically
- **WHEN** a source row records a group subject, description, or photo change
- **THEN** the archive retains the typed field change with its stable chat/message anchor, actor and values when available, and timestamp

#### Scenario: Unknown action is not guessed
- **WHEN** a system action code has no verified structural mapping
- **THEN** it remains an honest generic system event and creates no number-change, membership, or metadata-history record

#### Scenario: Ambiguous self flag is not an identity claim
- **WHEN** a backup system row has `is_me_joined` but no structurally linked affected participant or verified action semantics
- **THEN** the event remains generic or unresolved and does not create a “You joined/left” membership fact

#### Scenario: Live author and affected participant remain distinct
- **WHEN** a Baileys participant or group update supplies an `author` plus one or more affected participant objects
- **THEN** the canonical record retains those roles separately, including phone/LID identity hints, instead of dropping the author or treating the author as every affected participant

### Requirement: Role-Correct System Event Timeline And Detail
The local thread read surface SHALL render each verified, message-anchored number change, membership/role action, and chat-metadata or group-setting history record as a clear semantic system event. Canonical records and owner-facing detail reads SHALL keep actor, affected participant, old identity, new identity, and chat roles distinct. A role SHALL be labelled “You” only when that exact canonical role equals the configured archive owner. Every other role SHALL use the human-readable chain `saved/push name → complete phone number → Unknown`; LIDs, group JIDs, broadcast IDs, and other internal identifiers MUST NOT be shown as identity substitutes. Missing roles MUST NOT fall back to the owner, chat JID, message direction, or another role. Backup `is_me_joined`, sender, or action flags and live message keys MUST be treated only according to structurally verified semantics. A live group update that carries a verified history record but no platform message anchor SHALL create one idempotent local-only system timeline message; a later equivalent backup observation with a real message anchor SHALL merge with and, when safe, replace the synthetic anchor rather than render a duplicate. Unsupported system types SHALL retain their raw local type/parameters in focused details and an honest generic timeline label rather than being guessed.

#### Scenario: Verified backup system history is readable
- **WHEN** an imported system message has a verified number-change, membership, or metadata-history record
- **THEN** its thread card names the semantic action and any locally resolved participant/actor label instead of the generic “System event” fallback

#### Scenario: Missing actor does not become the owner
- **WHEN** a verified add, remove, promotion, metadata change, or number-change event identifies an affected value or participant but no actor
- **THEN** the actor renders as “Unknown,” and no message, chat, or other-role identity is substituted as “You”

#### Scenario: Unnamed phone identity remains distinguishable
- **WHEN** a system-event role has no resolved name but has a verified phone-form JID or stored complete phone number
- **THEN** the summary and detail render that complete phone number rather than “Unknown”

#### Scenario: Internal identifier is not presented as a person
- **WHEN** a role has only a LID, group JID, broadcast ID, or another non-phone internal identifier
- **THEN** the summary and detail render “Unknown” while retaining the raw identifier only in technical source data

#### Scenario: Owner label is role-specific
- **WHEN** the archive owner is the affected participant but another participant is the verified actor
- **THEN** the summary distinguishes “Actor added you” from “You added Actor” and the detail record preserves both canonical roles

#### Scenario: Live group update has no platform message
- **WHEN** live sync receives a verified group-participant or group-subject update without a source message
- **THEN** it creates one stable local system timeline anchor, persists the history against that anchor, and renders the same role-correct action without changing conversation-recency semantics

#### Scenario: Backup and live observations converge
- **WHEN** backup import later supplies a real message anchor for a semantic event first captured through an unanchored live notification
- **THEN** one canonical event retains both source observations and appears once in the timeline at the best available source timestamp

#### Scenario: Owner opens system-event details
- **WHEN** the user opens details for a verified or generic system event
- **THEN** the local detail read exposes every retained role, timestamp, value, source observation, raw type, and bounded raw parameter available for that event without sending it remotely

### Requirement: Structured Message Attachment Capture
The archive SHALL capture authoritative mentioned JIDs, shared locations and live-location observations, ordered lossless vCards with source-resolved JIDs, sender-embedded link previews, and source-provided media interpretation text as message-owned structured data. Location capture SHALL retain every verified field available in either source, including coordinates, name/address, URL/comment/caption, accuracy, speed, heading, live sequence/time offset/share duration/final time, observation time, and embedded-thumbnail availability. VCard capture SHALL retain the complete source card plus ordered parsed properties without discarding unknown extensions. Backup and live observations SHALL converge on the same canonical representation while retaining distinct source observations. Re-import or replay MUST be idempotent, MUST monotonically enrich missing fields, MUST preserve ordered live-location samples, and MUST NOT replace populated fields with null. Capture MUST use only source-embedded or already-local data and MUST NOT automatically fetch URLs, maps, contact photos, or other remote resources.

#### Scenario: Structured mention supersedes text fallback
- **WHEN** a backup mentions table or live envelope identifies a mentioned JID also found by text-token parsing
- **THEN** one canonical mention remains and records authoritative structured provenance without duplicating the identity

#### Scenario: Location retains semantic and numeric context
- **WHEN** a message location row contains coordinates plus an optional place name or address
- **THEN** the owning message exposes every captured structured field, a static/live discriminator, ordered observation metadata, and source provenance without flattening it into message text

#### Scenario: Backup and live location fields complement each other
- **WHEN** backup import and live sync observe the same location message with complementary fields or live-location samples
- **THEN** one message-owned location detail retains all non-conflicting fields and each distinct ordered sample without duplicating the attachment

#### Scenario: Multiple vCards retain order and identity hints
- **WHEN** one message shares multiple vCards and a source join resolves a JID for one card
- **THEN** all complete source cards and parsed properties remain ordered, the resolved card carries its canonical JID, and no unresolved card is speculatively merged to a person

#### Scenario: Backup link preview matches live storage
- **WHEN** backup `message_text` fields contain a URL, title, description, or embedded thumbnail
- **THEN** they upsert through the same message-link-preview contract used by live sync without contacting the link target

#### Scenario: Media interpretation retains source provenance
- **WHEN** media sidecars contain an accessibility label, raw transcription, or ordered transcription segments
- **THEN** non-empty source-provided text is stored locally with its kind, order, owning message, and provenance and is not labelled as Wapp Brain model output

### Requirement: Owner-Visible Structured Message Detail
The server SHALL provide a focused loopback-only detail read for one archived message that exposes all locally retained structured fields needed by the owner, including exact coordinates, complete vCards, canonical mention identities, full accessibility/transcription text and segment timing, edit/delete provenance, link-preview metadata, and system-event detail. The ordinary paginated thread payload MAY remain compact for performance, but it MUST advertise which detail families are available and MUST NOT be treated as the privacy boundary for owner data. Full detail MUST remain absent from logs, warnings, status/doctor responses, and any remote-model request unless a separate explicit opt-in authorizes it.

#### Scenario: Owner requests complete local detail
- **WHEN** the local UI requests details for one message carrying structured source data
- **THEN** the response returns the complete retained fields and source observations for that message without redaction or remote transmission

#### Scenario: Thread pagination stays bounded
- **WHEN** a thread page contains many vCards, transcripts, or live-location observations
- **THEN** its list response contains availability/count summaries and loads complete payloads only through focused detail requests

#### Scenario: Diagnostics stay content-free
- **WHEN** status, doctor, logs, warnings, import progress, or failure diagnostics are serialized
- **THEN** they contain no coordinates, vCard bodies, transcript text, raw system parameters, or identity endpoints from focused message details

### Requirement: Lossless VCard Download
Each captured vCard SHALL be downloadable locally as `text/vcard` with a sanitized `.vcf` filename. When a complete source vCard is held, the download MUST preserve that source card's semantic content and ordering. When no source body is held, the system MAY construct a standards-shaped card only from trustworthy retained fields, MUST label the download as constructed in message detail, and MUST NOT turn a LID or unresolved identifier into a phone number. If neither source content nor sufficient trustworthy fields exist, download MUST be unavailable rather than fabricated.

#### Scenario: Source vCard downloads
- **WHEN** a message detail contains a complete source vCard
- **THEN** its download route returns that card with `text/vcard`, attachment disposition, and a sanitized `.vcf` filename

#### Scenario: Minimal card is constructable
- **WHEN** no source body exists but a display name and a verified phone-form identity are retained
- **THEN** the system may construct a valid minimal card, identifies it as constructed, and includes no guessed properties

#### Scenario: Insufficient card data stays unavailable
- **WHEN** a card has neither source content nor sufficient verified fields
- **THEN** the detail view explains that no downloadable card can be constructed and emits no file

### Requirement: Source Interpretation Detail
Accessibility labels, complete source transcriptions, and ordered transcription segments SHALL remain exact local source data. Detail reads SHALL expose the full text, source, observation time, segment index, and available start/end offsets. Evidence rendering MAY remain bounded, but the local owner detail MUST NOT truncate the retained value.

#### Scenario: Full transcript is locally readable
- **WHEN** a message has a source transcription longer than the evidence or thread-summary bound
- **THEN** its local detail returns the complete text while evidence continues to use its documented bounded representation

#### Scenario: Timed segments preserve order
- **WHEN** source transcript segments contain indexes and timing offsets
- **THEN** the detail read returns them in stable order with every available start and end time

### Requirement: Captured Signal Provenance And Repairability
Every captured signal SHALL retain a stable canonical-fact key plus one or more source observations containing source, source event/row key, source message anchor, observed time when available, and capture schema version. Identity merge SHALL rekey every JID-bearing canonical fact and observation in the same transaction as other archive identity state. Canonical facts SHALL prefer a shared source message key when one exists and otherwise use a conservative semantic fingerprint over verified kind, chat, roles/values, and source event time. Re-import and live replay SHALL enrich the canonical fact rather than duplicate it; distinct live-location samples and edit events SHALL remain distinct; older observations MUST NOT erase richer or newer state. A synthetic live message anchor SHALL be replaceable by a later real backup message anchor while preserving all observations and stable UI identity.

#### Scenario: Re-import is idempotent
- **WHEN** the same backup is imported twice
- **THEN** number changes, membership periods, mentions, locations, vCards, previews, edit/delete events, interpretations, and aggregates retain one natural-key record each

#### Scenario: Identity merge repairs signal references
- **WHEN** a LID is merged into its canonical phone JID
- **THEN** all signal endpoints using that LID are rekeyed or deduplicated without changing message anchors or losing provenance

#### Scenario: Older backup cannot erase live enrichment
- **WHEN** a re-import observes fewer fields or an older edit/delete state than live sync already stored
- **THEN** the richer or newer local state remains and only previously missing fields are filled

#### Scenario: Arrival order does not change the merged fact
- **WHEN** equivalent backup and live observations arrive in either order
- **THEN** the same canonical fact, complete merged fields, retained source observations, and visible timeline identity result

#### Scenario: Similar events are not over-merged
- **WHEN** two events in one chat share a kind and participants but have distinct verified timestamps, source message IDs, sequence numbers, or values
- **THEN** they remain distinct canonical facts rather than being collapsed by a loose time-window heuristic

### Requirement: Privacy-Scoped Engagement Aggregates
Receipt and device tables SHALL be reduced at the import boundary to per-chat and, where an identity is available, per-chat/counterparty aggregates. Durable aggregates SHALL include the numerator, denominator, sample count, time bounds, algorithm version, read rate, and median response latency needed to judge their strength. Raw receipt rows, device identifiers, and individual receipt timestamps MUST NOT be persisted in the archive, copied into general message metadata, logged, warned, exported, or exposed by status and message DTOs. Aggregate computation SHALL stream or execute in source SQLite and MUST NOT load the full receipt population into process memory.

#### Scenario: Read rate keeps its evidence strength
- **WHEN** outgoing messages and receipt rows provide a read-rate sample for a chat or counterparty
- **THEN** the stored aggregate includes read count, eligible count, rate, coverage bounds, and algorithm version without any individual receipt row

#### Scenario: Response latency is bounded and sample-sized
- **WHEN** visible outgoing and subsequent incoming exchanges produce response-latency observations
- **THEN** the archive stores the bounded median and sample count so consumers can discount weak estimates

#### Scenario: Receipt canary cannot escape
- **WHEN** source receipts contain a unique canary value and import status, warnings, logs, DTOs, diagnostics, and exports are inspected
- **THEN** the canary is absent from every output and only aggregate numeric values remain locally

#### Scenario: Large receipt table stays bounded in memory
- **WHEN** a backup contains hundreds of thousands of receipt rows
- **THEN** aggregation completes through streaming or source SQL without materializing the raw population in JavaScript memory

## MODIFIED Requirements

### Requirement: Backup Add-On Convergence
The system SHALL parse backup add-on records — reactions, edit events and held revisions, revoke metadata, poll votes, and event responses — into the same canonical message state the live path applies, keyed by canonical message identity, idempotent across re-imports, with observed-time newest-state-wins semantics and monotonic enrichment against live-derived state. Because Android re-keys edited messages in place, edited rows SHALL be keyed by their original message key, and rows stored under a superseded edit-key identity SHALL collapse onto the canonical row. The archive SHALL distinguish proof that an edit occurred from prior content actually held: metadata-only backup edits MUST NOT fabricate revision text or claim that prior content is retrievable.

#### Scenario: Backup reaction matches live representation
- **WHEN** a reaction stored in a backup add-on table is imported
- **THEN** it is applied to the original message exactly as an equivalent live reaction event would be, and re-importing the same backup does not duplicate it

#### Scenario: Backup edit event is recorded honestly
- **WHEN** a backup carries original-key and edit-time metadata but no prior body or caption
- **THEN** the canonical message is marked edited and the edit event is retained without creating a fabricated prior-content revision

#### Scenario: Held revision remains distinguishable
- **WHEN** live ingestion snapshots content before applying an edit
- **THEN** that held revision remains retrievable and is not confused with a metadata-only backup edit event

#### Scenario: Backup revoke metadata enriches the tombstone
- **WHEN** a backup revoke row identifies an actor or revoke timestamp
- **THEN** the canonical message retains the deletion state plus the available actor, time, and provenance without erasing held content

#### Scenario: Backup state never clobbers newer live state
- **WHEN** a backup add-on targets a message that live sync has since updated with newer or richer state
- **THEN** the newer state wins and the older backup state does not overwrite it

#### Scenario: Backup poll votes attach to the poll
- **WHEN** poll-vote add-ons already decrypted by the phone are imported
- **THEN** the poll message carries the voters and selected options as structured metadata

### Requirement: Interpretation Serves Every Consumer
Message interpretation — the type string, human-readable label, unreadability reason, extracted text, and captured structured message signals — SHALL be produced server-side from one shared source of truth and exposed through documented compact and focused-detail read APIs, so the thread view, second-brain evidence, search indexing, and any MCP or agent-facing surface present the same honest meaning without reimplementing source decoding. Extracted searchable text MUST land in body, caption, resolved text, or a documented indexed field. Structured mentions, locations, vCards, link previews, edit/delete state, source media interpretation, and system-event roles MUST use documented machine-readable fields. The compact DTO SHALL advertise detail availability; the focused owner-local DTO SHALL expose complete retained values. Engagement aggregates and raw aggregation inputs MUST NOT appear in general message or detail DTOs.

#### Scenario: Brain evidence describes structured non-text context
- **WHEN** the second-brain evidence path includes a location, shared contact, link preview, edited/deleted message, or source-interpreted media item
- **THEN** the evidence record carries its documented structured meaning and provenance rather than an empty row or client-derived guess

#### Scenario: A non-UI consumer needs no client logic
- **WHEN** a message is read through repository APIs by a consumer other than the web client
- **THEN** the returned record is self-describing about its type, interpretation, attachments, and edit/delete state with no client-side mapping required

#### Scenario: Extracted content is indexable
- **WHEN** content is extracted for a mapped type or sender-embedded preview
- **THEN** its documented searchable fields are available to indexing rather than existing only in display-layer output

#### Scenario: Private aggregates stay off message reads
- **WHEN** any general chat, message, search, status, or diagnostic response is serialized
- **THEN** it contains neither engagement aggregates nor any raw receipt input

### Requirement: Deleted Messages Preserve Held Content
Interpretation of a deleted or revoked message SHALL preserve any content the archive captured before deletion: held text, caption, media, and structured attachments MUST remain exposed through local read APIs together with the deleted state. Focused detail SHALL expose original send time, available revoke/delete time, verified actor/admin identity, deletion kind, target message identity, all source observations, and whether content was retained or never captured. The bare "Deleted message" placeholder SHALL be produced only when no content was ever captured, and consumers MUST NOT infer unavailable actor, kind, or time values.

#### Scenario: Deleted message with captured content keeps it
- **WHEN** a message whose text, media, or structured attachment was captured is later deleted
- **THEN** reads return the captured content together with deletion state and available revoke metadata, not a content-erasing replacement

#### Scenario: Deleted message without captured content stays a placeholder
- **WHEN** a deleted message never had content captured
- **THEN** interpretation yields the honest "Deleted message" placeholder plus only the revoke metadata actually held

#### Scenario: Backup and live revoke metadata converge
- **WHEN** backup and live sources observe the same deletion with complementary actor or timestamp fields
- **THEN** one deletion record monotonically enriches the canonical message without duplication or loss of held content

#### Scenario: Deleted state reaches every consumer
- **WHEN** any consumer reads a deleted message through repository APIs
- **THEN** the record carries deletion state and available provenance so the consumer can indicate deletion honestly

#### Scenario: Deletion timeline keeps both times
- **WHEN** original send time and revoke/delete time are both available
- **THEN** focused detail exposes both exact times as distinct fields and may derive a duration without replacing either source timestamp

#### Scenario: Unknown deletion metadata stays explicit
- **WHEN** the source proves deletion but does not identify the actor, admin status, or delete time
- **THEN** focused detail marks those fields unavailable instead of substituting the sender, owner, import time, or message time

### Requirement: Edited State Is Exposed
Interpretation SHALL expose whether a message was edited, the original send timestamp, every available edit timestamp and source key, the current content, and whether each prior body or caption revision is actually held, from the shared server-side source of truth. Live and backup edit events SHALL use one ordered timeline representation. A metadata-only event SHALL remain viewable in that timeline with an explicit “Original text unavailable” placeholder and MUST NOT be presented as held revision content. Consumers SHALL be able to show both send and edit times without client inference or timestamp substitution.

#### Scenario: Edited flag is exposed
- **WHEN** a backup or live source proves that a message was edited
- **THEN** the message read identifies it as edited and exposes the available event metadata

#### Scenario: Held revision availability is exposed
- **WHEN** an edited message has retained prior body or caption content
- **THEN** the record identifies revision content as available for retrieval

#### Scenario: Metadata-only edit stays honest
- **WHEN** an edit event is retained without any prior body or caption
- **THEN** the message is marked edited, the event remains openable in edit history with its available timestamps, and the missing original content is labelled “Original text unavailable”

#### Scenario: Send and edit times remain distinct
- **WHEN** the source provides both the original message timestamp and an edit timestamp
- **THEN** the edit timeline exposes both values in chronological order and never overwrites the send time with the edit time

#### Scenario: Missing edit time is not fabricated
- **WHEN** an edit is proven but its edit timestamp is absent
- **THEN** the timeline identifies the edit time as unavailable and does not substitute import time, current time, or the original send time
