## MODIFIED Requirements

### Requirement: Evidence Selection Policy

Evidence packs SHALL contain only conversation messages per the visible-exchange definition, rendered in resolved identity text with interpretation labels for non-text content, bounded in message count, split at long silence gaps, and bounded to a maximum time span; system, reaction, encrypted-update, number-change, membership-history, and chat-metadata-history rows SHALL never consume model budget. Reactions on a pack message SHALL render as non-citable annotations on that message's evidence line, resolving each reactor to the same identity text as senders. Authoritative structured mentions SHALL resolve through pack-local identity labels and join the entity-resolution set. A message-owned location, vCard, link preview, edit/delete state, or source-provided media interpretation SHALL render as a deterministic bounded annotation on that message's evidence line; it SHALL share the owning message's citation alias and SHALL NOT receive an independent alias. Deleted messages with held content SHALL retain that content plus a deletion annotation, while contentless tombstones SHALL render the honest deleted placeholder. Edit annotations SHALL distinguish an observed edit event from held prior revision content. Source-provided accessibility labels and transcriptions SHALL be labelled by provenance and SHALL NOT be described as model-generated interpretation. Owner-facing local detail may expose complete source values, but that SHALL NOT relax evidence bounds or authorize those values for a remote model. Link-preview thumbnails, embedded media bytes, complete transcript overflow, exact location telemetry, and raw vCard boilerplate SHALL never be sent to the model unless a separate explicit remote-use opt-in is introduced.

A quoted reply SHALL resolve its referent in this order: the real quoted message's citation alias when that message is in the pack; otherwise the captured snapshot's full untruncated text or deterministic structured-content description as non-citable context; otherwise the legacy bounded same-chat pointer lookup; otherwise an honest generic fallback. Quoted snapshot annotations SHALL be exempt from a separate character cap but SHALL remain inside the untrusted-message fence, and thumbnail bytes SHALL never be sent to the model. Captured quoted senders SHALL join pack-local identity resolution and use the same saved-name, push-name, number-token, owner, and collision-disambiguation rules as other participants. A forwarded message SHALL be labelled as forwarded, with a prompt rule to attribute its content as shared or forwarded rather than said. A sender without a resolved display name SHALL be labelled by its verbatim number rather than the literal text "Unknown", and the prompt SHALL instruct referring to that participant by exactly that number. When two participants in one pack resolve to the same display name, each colliding label SHALL receive a deterministic disambiguating suffix and the prompt SHALL instruct using exactly the labels shown. Aliases SHALL be assigned only to real messages present in the pack; no annotation, reaction, or out-of-pack quoted snapshot/referent SHALL be independently citable.

#### Scenario: Noise excluded from evidence

- **WHEN** a window contains system events, membership or metadata history, and reactions alongside conversation
- **THEN** only conversation messages enter the evidence pack while reactions still appear as annotations on their target messages and history remains available to non-evidence consumers

#### Scenario: Oversized window split

- **WHEN** a chat window exceeds the evidence size bound
- **THEN** it is split into sequenced packs at silence gaps and each pack is processed as its own task

#### Scenario: Reaction annotated on its target, cited through it

- **WHEN** a pack message has one or more reactions
- **THEN** the reactions render inline on that message's evidence line with each reactor resolved to identity text, the reactions consume no alias and no budget line, and a claim about the acknowledgment cites the target message's alias

#### Scenario: Structured mention resolves authoritatively

- **WHEN** a pack message carries a structured mentioned JID that differs from or supplements text-token parsing
- **THEN** the evidence line uses the pack-local identity label, the JID is available to claim entity anchoring, and the mention receives no independent citation alias

#### Scenario: Location and vCard annotate their owning message

- **WHEN** a visible message owns a captured location or one or more vCards
- **THEN** its evidence line renders bounded type-specific place or shared-contact context and any source-resolved JID without making the attachment independently citable

#### Scenario: Link preview renders without remote or binary content

- **WHEN** a visible message owns a captured link-preview title, description, canonical URL, or thumbnail
- **THEN** its evidence line renders bounded textual preview context, sends no thumbnail bytes, and performs no link-target fetch

#### Scenario: Edited message distinguishes event from held revision

- **WHEN** a visible message has edit-event metadata with or without retained prior content
- **THEN** its evidence line marks the message edited, includes available event time, and states prior content is held only when an actual revision exists

#### Scenario: Deleted message keeps captured context

- **WHEN** a visible message is deleted after text, caption, media, or structured context was captured
- **THEN** its evidence line preserves that context and adds available deletion actor/time metadata instead of replacing it with a bare placeholder

#### Scenario: Contentless deletion stays honest

- **WHEN** a deletion tombstone has no captured content
- **THEN** its evidence line renders an honest deleted placeholder plus only the deletion metadata actually held

#### Scenario: Source media interpretation is provenance-labelled

- **WHEN** a visible media message carries a source accessibility label or transcription
- **THEN** the evidence line renders bounded text explicitly labelled as source-provided interpretation and sends no media bytes

#### Scenario: Full local detail does not expand model evidence

- **WHEN** the owner can open an untruncated transcript, raw vCard, exact location telemetry, or raw system parameters in the local UI
- **THEN** evidence rendering continues to use only its bounded documented annotations and does not include that additional detail by implication

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

### Requirement: Staleness Propagation
Message edits, deletions, and captured signal enrichments affecting already-assimilated messages SHALL select dependent episodes by stable source message key, mark them stale, and enqueue regeneration tasks; staleness SHALL be visible in brain status. Signal enrichment includes newly captured or materially changed structured mentions, locations, vCards, link previews, edit/delete provenance, and source media interpretation. Name resolution SHALL also be a staleness source, but with a deterministic-repair-first policy: when an identity that appears as an unresolved participant in committed episodes gains a resolved name or known number replacing a LID token, the affected episodes SHALL first be repaired deterministically with no model call rather than being marked stale. Optional low-priority regeneration after identity repair MUST NOT be required to clear resolution debt.

#### Scenario: Edit invalidates episode
- **WHEN** a backup or live edit changes a message cited by a committed episode
- **THEN** the episode is marked stale and a regeneration task is enqueued

#### Scenario: Deletion invalidates episode
- **WHEN** a message cited by a committed episode is deleted or gains material revoke metadata
- **THEN** the episode is marked stale and a regeneration task is enqueued

#### Scenario: Captured signal enrichment invalidates episode
- **WHEN** re-import adds or materially enriches a mention, location, vCard, preview, or source media interpretation on an assimilated message
- **THEN** episodes anchored to that message are marked stale and receive deduplicated regeneration work

#### Scenario: Name resolution repairs deterministically, not by staleness
- **WHEN** an identity that appears as an unresolved participant in committed episodes gains a resolved name
- **THEN** the affected episodes are repaired deterministically with no model call and are not marked stale merely because of the name resolution

#### Scenario: Regeneration after resolution is an optional upgrade
- **WHEN** name resolution enqueues optional low-priority regeneration for repaired episodes and regeneration is disabled or unbudgeted
- **THEN** the episodes remain correctly repaired and the resolution debt is already cleared for the resolved identity

### Requirement: Extraction Versioning
Every episode SHALL be stamped at commit with the extraction version from a single named constant, for model-generated and extractive episodes alike. The constant SHALL be bumped on any change to the prompt, JSON contract, validation semantics, or evidence rendering that alters episode content, including the addition or semantic change of captured-signal annotations. Episodes with a stale version SHALL be selectable for regeneration.

#### Scenario: Episode stamped with the current version
- **WHEN** any episode commits
- **THEN** its `extraction_version` equals the named constant compiled into the extraction code

#### Scenario: Stale version is a regeneration predicate
- **WHEN** the constant is bumped after episodes were committed under the previous version
- **THEN** those episodes are selected by the regeneration path

#### Scenario: Signal rendering bumps the version
- **WHEN** mention, location, vCard, preview, edit/delete, or media-interpretation evidence rendering lands
- **THEN** `EXTRACTION_VERSION` increases and episodes created without those annotations become regenerable

### Requirement: Late-Binding Commit Stamps
Every episode SHALL record at commit, computed mechanically from its evidence pack: the source JIDs of message or quoted-snapshot participants whose label fell through to a number token (`unresolved_participants`); the source JIDs whose label came from a self-set push name (`push_name_participants`); the count of pack messages contributing neither text nor an interpretation label (`uninterpreted_media_count`); a quoted-reply anchor for each reply; and an `archive_signal_anchors` entry for each evidence message carrying captured structured signals. Each signal anchor SHALL contain the owning source message key, signal kinds, and capture schema version, without duplicating sensitive payload content. These stamps SHALL apply to extractive episodes and SHALL be queryable as debt and reverse-link surfaces for deterministic repair, stale selection, and regeneration.

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

#### Scenario: Captured signal dependencies are stamped
- **WHEN** a pack message carries one or more structured mentions, locations, vCards, previews, edit/delete records, or source media interpretations
- **THEN** the episode records that message key, the distinct signal kinds, and capture version without copying their payload text into the stamp

#### Scenario: Signal enrichment uses the reverse link
- **WHEN** re-import enriches a signal on an already-assimilated source message key
- **THEN** the signal-anchor index selects affected episodes for deduplicated stale marking and regeneration
