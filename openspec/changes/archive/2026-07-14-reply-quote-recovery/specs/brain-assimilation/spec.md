## ADDED Requirements

### Requirement: Quoted Reply Snapshot Capture And Enrichment
The archive SHALL capture a reply's self-contained quoted-message snapshot when a backup or live envelope exposes one, preserving all available text without local truncation, quoted sender JID, quoted source-chat JID, owner/from-me state, quoted key id, nullable timestamp, and message type together with available quoted media metadata/thumbnail, location, vCard, and structured mentions. Capture SHALL be defensive, source-agnostic, and idempotent: optional backup tables/columns or live `quotedMessage` content MAY be absent without failing message ingestion, malformed optional companions SHALL lose only that companion with a scoped warning, later backup or live observations SHALL enrich rather than erase an existing snapshot, and an absent snapshot SHALL retain the existing pointer-only behavior. Snapshot content SHALL remain local under the archive's normal privacy boundary.

#### Scenario: Modern Android text snapshot is captured in full
- **WHEN** a modern Android reply references a `message_quoted` row containing long text and quoted sender/key metadata
- **THEN** the archived reply owns a snapshot containing the complete text and available sender JID, key id, timestamp, and type without a storage-side character cap

#### Scenario: Structured quoted companions are captured
- **WHEN** a quoted snapshot has media, location, vCard, or mention companion rows in the supplied backup
- **THEN** the archive attaches their mapped metadata and embedded thumbnail to that reply's snapshot without creating a standalone citable message

#### Scenario: Live snapshot shares the archive contract
- **WHEN** a real-time or history-sync reply carries Baileys `contextInfo.quotedMessage`
- **THEN** the archive stores its available key, sender/source-chat identity, text/type, structured context, and embedded thumbnail in the same owned snapshot shape used by backup import

#### Scenario: Live timestamp remains honestly unknown
- **WHEN** a live quoted snapshot has no matching archived original and its `ContextInfo` carries no original timestamp
- **THEN** the snapshot timestamp remains null while its other captured content remains usable in evidence and the thread UI

#### Scenario: Missing snapshot schema falls back safely
- **WHEN** a legacy Android or iOS source has a reply pointer but no recognized quoted-snapshot table or required columns
- **THEN** the reply imports successfully with its pointer, no snapshot is fabricated, and existing pointer/generic rendering remains available

#### Scenario: Malformed companion does not lose the reply
- **WHEN** an optional quoted-media or structured companion row cannot be mapped
- **THEN** the importer records a scoped warning, preserves the base reply and any valid snapshot fields, and continues the import

#### Scenario: Re-import enriches an archived reply
- **WHEN** a later idempotent import supplies snapshot fields or companions that were missing from an existing archived reply
- **THEN** the reply gains those fields without duplicating the message or erasing previously captured snapshot content

#### Scenario: Backup and live observations converge
- **WHEN** the same reply is observed through backup import and live/history sync with complementary snapshot fields
- **THEN** one archive message owns one monotonically enriched snapshot rather than source-specific duplicates

#### Scenario: Snapshot enrichment invalidates dependent episodes
- **WHEN** a backup import or live event changes a reply from a missing or less-complete snapshot to a newly captured or enriched snapshot
- **THEN** current episodes whose quoted-reply anchor stamp contains that reply are marked stale and exact-window regeneration is enqueued

#### Scenario: Contract-version upgrade selects old episodes
- **WHEN** quote snapshot rendering ships with a higher extraction version
- **THEN** current episodes committed under the older version are selectable by `brain regenerate` and their watermarks are not advanced during replacement

## MODIFIED Requirements

### Requirement: Evidence Selection Policy

Evidence packs SHALL contain only conversation messages per the visible-exchange definition, rendered in resolved identity text with interpretation labels for non-text content, bounded in message count, split at long silence gaps, and bounded to a maximum time span; system, reaction, and encrypted-update rows SHALL never consume model budget. Reactions on a pack message SHALL render as non-citable annotations on that message's evidence line, resolving each reactor to the same identity text as senders. A quoted reply SHALL resolve its referent in this order: the real quoted message's citation alias when that message is in the pack; otherwise the captured snapshot's full untruncated text or deterministic structured-content description as non-citable context; otherwise the legacy bounded same-chat pointer lookup; otherwise an honest generic fallback. Quoted snapshot annotations SHALL be exempt from a separate character cap but SHALL remain inside the untrusted-message fence, and thumbnail bytes SHALL never be sent to the model. Captured quoted senders SHALL join pack-local identity resolution and use the same saved-name, push-name, number-token, owner, and collision-disambiguation rules as other participants. A forwarded message SHALL be labelled as forwarded, with a prompt rule to attribute its content as shared or forwarded rather than said. A sender without a resolved display name SHALL be labelled by its verbatim number rather than the literal text "Unknown", and the prompt SHALL instruct referring to that participant by exactly that number. When two participants in one pack resolve to the same display name, each colliding label SHALL receive a deterministic disambiguating suffix and the prompt SHALL instruct using exactly the labels shown. Aliases SHALL be assigned only to real messages present in the pack; no annotation (reaction or out-of-pack quoted snapshot/referent) SHALL be citable.

#### Scenario: Noise excluded from evidence

- **WHEN** a window contains system events and reactions alongside conversation
- **THEN** only conversation messages enter the evidence pack while reactions still appear as annotations on their target messages

#### Scenario: Oversized window split

- **WHEN** a chat window exceeds the evidence size bound
- **THEN** it is split into sequenced packs at silence gaps and each pack is processed as its own task

#### Scenario: Reaction annotated on its target, cited through it

- **WHEN** a pack message has one or more reactions
- **THEN** the reactions render inline on that message's evidence line with each reactor resolved to identity text, the reactions consume no alias and no budget line, and a claim about the acknowledgment cites the target message's alias

#### Scenario: In-pack quoted reply resolves to the referent alias

- **WHEN** a reply's quoted message is present in the same pack
- **THEN** the reply line carries a referent that names the quoted message's citation alias and a truncated snippet of it, so a claim may cite the referent by that alias

#### Scenario: Out-of-pack snapshot is complete non-citable context

- **WHEN** a reply's quoted message is not present in the pack and the reply carries a captured text snapshot
- **THEN** the reply line carries the snapshot's resolved sender and complete quoted text with no citation alias or character truncation, and no claim can cite the snapshot independently

#### Scenario: Reply Privately does not require a cross-chat lookup

- **WHEN** a one-to-one reply carries a snapshot quoted from a group message
- **THEN** the evidence line renders the group antecedent from the reply-owned snapshot without querying or citing the group chat

#### Scenario: Deleted original remains recoverable

- **WHEN** the original quoted message is absent or deleted from the archive but its reply-owned snapshot remains
- **THEN** the evidence line renders the captured antecedent and does not degrade to the generic earlier-message label

#### Scenario: Quoted structured content is interpreted

- **WHEN** an out-of-pack snapshot represents media, a location, or a vCard and has no plain text body
- **THEN** the referent annotation uses its captured caption and deterministic type-specific context rather than an empty or generic media marker

#### Scenario: Pointer-only source retains bounded fallback

- **WHEN** a reply has no captured snapshot but its existing pointer resolves to an archived message in the same chat
- **THEN** the reply line carries the bounded resolved sender/snippet fallback with no citation alias

#### Scenario: Unresolvable pointer stays honest

- **WHEN** a reply has neither a captured snapshot nor a resolvable legacy pointer
- **THEN** the reply line states that it replies to an earlier message without fabricating sender or content

#### Scenario: Quoted sender uses pack-local identity rules

- **WHEN** a captured quoted sender resolves to a saved name, push name, owner identity, phone token, or a colliding label in the pack
- **THEN** the referent uses the same provenance marking and deterministic disambiguation as ordinary senders and that identity is available to claim entity anchoring

#### Scenario: Forwarded message attributed as shared

- **WHEN** a pack contains a message flagged as forwarded
- **THEN** its evidence line is labelled as forwarded and the prompt instructs attributing the content as shared or forwarded rather than as something the forwarder said

#### Scenario: Unresolved sender labelled by number

- **WHEN** a pack contains a message from a sender with no resolved display name
- **THEN** its evidence line labels the sender by its verbatim number, the prompt instructs referring to that participant by exactly that number, and two unresolved senders with different numbers are distinguishable

#### Scenario: Same-name participants disambiguated

- **WHEN** two participants in one pack resolve to the same display name
- **THEN** each colliding label receives a deterministic number-derived suffix that makes the labels distinct and the prompt instructs using exactly the labels shown

#### Scenario: Quiet chat produces span-bounded episodes

- **WHEN** a chat's unassimilated backlog spans more than the maximum episode span with no long silence gap
- **THEN** `buildEvidencePacks` splits it into multiple packs each within the span cap, and neither the segmentation nor the greedy merge produces a pack exceeding the cap

### Requirement: Late-Binding Commit Stamps
Every episode SHALL record at commit, computed mechanically from its evidence pack: the source JIDs of message or quoted-snapshot participants whose label fell through to a number token (`unresolved_participants`), the source JIDs of message or quoted-snapshot participants whose label was derived from a self-set push name rather than a saved contact name (`push_name_participants`), the count of pack messages contributing neither text nor an interpretation label (`uninterpreted_media_count`), and a quoted-reply anchor entry for each reply containing its source message key, quoted source-chat/key identity when known, and snapshot-present state (`quoted_reply_anchors`). These stamps SHALL apply to extractive episodes as well and SHALL be queryable as the debt/reverse-link surface for later repair (identity late-resolution, regeneration on saved-name binding or quote enrichment, and media interpretation upgrades).

#### Scenario: Unresolved participant stamped
- **WHEN** a pack contains a sender labelled by a verbatim number token
- **THEN** the committed episode's unresolved-participants stamp contains that sender's source JID

#### Scenario: Quoted-only unresolved participant stamped
- **WHEN** a person appears only as a captured quoted sender and is labelled by a verbatim number token
- **THEN** the committed episode's unresolved-participants stamp contains that quoted sender's source JID and later deterministic identity repair can select the episode

#### Scenario: Push-name participant stamped
- **WHEN** a pack contains a sender whose label came from a push name because no saved contact name exists
- **THEN** the committed episode's push-name-participants stamp contains that sender's source JID, and a later saved-name binding can select the episode for regeneration

#### Scenario: Quoted reply anchor stamped
- **WHEN** a pack contains a reply with or without a captured quoted snapshot
- **THEN** the committed episode records that reply's source message key, known quoted source chat/key identity, and snapshot-present state even when no resulting claim cites the reply

#### Scenario: Uninterpreted media counted
- **WHEN** a pack contains messages with no text and no interpretation label
- **THEN** the committed episode records their count

### Requirement: Push-Name Label Provenance
Evidence-pack labels derived from a self-set push name (no saved contact name exists) SHALL be visually distinguished on evidence lines with a leading tilde (`~name`), for senders, reactors, and captured quoted senders alike, with collision-disambiguation suffixes applied after the tilde. The prompt SHALL explain that a `~name` is self-reported and unverified, SHALL instruct referring to the person by the name without the tilde in prose, and SHALL require `hedged` confidence on claims that hinge on that person's identity rather than on what they said. Entity junction rows for push-name-labelled participants SHALL still carry their canonical JID.

#### Scenario: Push-name label marked on evidence lines
- **WHEN** a pack sender has a push name but no saved contact name
- **THEN** their evidence lines label them `~<pushname>` and the prompt legend explains the marker

#### Scenario: Quoted push-name label is marked
- **WHEN** a captured quoted sender has a push name but no saved contact name
- **THEN** the quote annotation labels them `~<pushname>`, the episode stamps their JID as push-name-derived, and the prompt legend applies to that label

#### Scenario: Prose drops the tilde, identity stays anchored
- **WHEN** a claim mentions a push-name-labelled participant
- **THEN** the claim text uses the name without the tilde and the claim's entity row carries that participant's canonical JID

#### Scenario: Saved-name label is unmarked
- **WHEN** a pack sender has a saved contact name
- **THEN** their label carries no tilde regardless of whether a push name also exists
