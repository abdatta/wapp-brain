## Purpose

Define the two-level person model: immutable identity anchors (one per canonical JID) beneath an editable person grouping — connect and disconnect as reversible metadata with provenance, certainty-grade auto-connect, deterministic suggestion producers with rejection memory, pack-local extraction resolution, and display-level-only hints.

## Requirements

### Requirement: Immutable Identity Anchors
The system SHALL maintain exactly one identity per canonical JID as the anchor for all durable derived knowledge: claims, claim entities, mentions, citations, and signal records SHALL reference identities (canonical JIDs), never persons. No person-layer operation SHALL merge, rewrite, or delete an identity or anything anchored to it. LID↔PN collapses of the same WhatsApp identity SHALL remain exclusively an archive-layer merge concern, distinct from person grouping.

#### Scenario: Person operations never touch identity-anchored data
- **WHEN** identities are connected into a person, disconnected, or their person is dissolved
- **THEN** no row in episodes, claims, claim entities, citations, contacts, chats, or messages is inserted, updated, or deleted

#### Scenario: Number change is a person link, not an identity merge
- **WHEN** a number-change event relates an old JID and a new JID
- **THEN** the two identities are connected at the person level with both identities' archives intact, and no archive-layer merge runs between them

### Requirement: Person Membership With Provenance
The system SHALL represent a person as an editable membership over identities: connecting identities inserts membership rows and disconnecting deletes them. Each membership row SHALL record its source (`google`, `number_change`, or `user`), machine-checkable evidence, and the link time, and this provenance SHALL be visible wherever the membership is presented. An identity SHALL belong to at most one person. A person row SHALL exist only while it has two or more members: the first connect creates it, and a disconnect that leaves fewer than two members dissolves it. When a connect or archive-layer merge reveals that two existing persons share an identity, the system SHALL union them into one surviving person. Dissolved and union-merged person identifiers SHALL remain resolvable through redirect records to their replacement person or surviving identity. Every connect, disconnect, union, and dissolve SHALL be recorded in an append-only audit trail.

#### Scenario: Connect and disconnect are row edits
- **WHEN** a user connects two unaffiliated identities and later disconnects one
- **THEN** the connect creates a person with two provenance-stamped membership rows, the disconnect removes that membership and dissolves the person, and the audit trail records both operations

#### Scenario: Persons sharing an identity union
- **WHEN** a connect (or an archive-layer LID↔PN merge) links an identity in person A to an identity in person B
- **THEN** one surviving person holds both membership sets, the dissolved person id resolves to the survivor via a redirect record, and the union is audited

#### Scenario: Externally-held person id survives dissolution
- **WHEN** a person id previously returned to an API consumer is dissolved back to a single identity
- **THEN** resolving that person id yields a redirect to the surviving identity rather than an error

### Requirement: Membership Edits Are Metadata-Only
Connecting or disconnecting identities SHALL touch only person-layer tables and SHALL then re-derive person-keyed aggregations; it MUST NOT modify episodes, claims, claim entities, citations, or any archive record. Person-level read surfaces SHALL aggregate over membership at read or rollup time, so a disconnect fully restores the pre-connect presentation of each identity.

#### Scenario: Disconnect reverses connect with zero episode changes
- **WHEN** two identities with committed brain history are connected and then disconnected
- **THEN** person-level surfaces show the combined view while connected and the original separate views after disconnect, and the episode, claim, and citation tables are byte-identical throughout

### Requirement: Deterministic Auto-Connect
The system SHALL automatically connect identities, without user confirmation, from exactly two certainty-grade sources: two or more archived identities whose numbers belong to the same persisted Google contact grouping, and the two identities named by a WhatsApp number-change system message. Auto-connect SHALL run continuously — after each Google Contacts sync, after each backup import, and on the recurring maintenance tick — and SHALL be idempotent. Auto-connected memberships SHALL carry their source and evidence (the Google contact reference or the number-change event key). All previously captured number-change records SHALL be consumed by the first pass, so existing archives connect without re-import. An auto source MUST NOT connect a pair covered by a suppression record, and the disappearance of a Google grouping MUST NOT disconnect identities it previously connected.

#### Scenario: Same Google contact auto-connects with provenance
- **WHEN** a Google Contacts sync persists a contact grouping whose numbers match two archived identities
- **THEN** the identities become members of one person with source `google` and the contact reference as evidence, with no confirmation step

#### Scenario: Number-change message auto-connects continuously
- **WHEN** a number-change event is captured by live sync while auto-connect is enabled
- **THEN** a subsequent maintenance pass connects the old and new identities with source `number_change` and the event key as evidence

#### Scenario: Existing number-change backlog connects on first pass
- **WHEN** the first auto-connect pass runs over an archive with previously captured number-change records
- **THEN** every JID-resolvable number-change pair not suppressed is connected, and re-running the pass changes nothing

#### Scenario: Google grouping removal does not disconnect
- **WHEN** a later sync no longer contains the grouping that connected two identities
- **THEN** the membership persists unchanged until a user disconnects it

### Requirement: Disconnect Suppression Memory
Disconnecting an identity SHALL record a suppression for each pair the disconnect severed, and auto-connect sources MUST NOT reconnect a suppressed pair. A user-initiated connect of a suppressed pair SHALL clear its suppression and proceed.

#### Scenario: Severed google link is not re-applied by the next sync
- **WHEN** a user disconnects an identity that was auto-connected from a Google contact grouping and the next sync still contains that grouping
- **THEN** the pair remains disconnected and the sync's auto-connect pass skips it

#### Scenario: Explicit user connect overrides suppression
- **WHEN** a user connects a pair that carries a suppression record
- **THEN** the connect succeeds, the suppression is cleared, and the membership carries source `user`

### Requirement: Suggestion Producers Never Apply
The system SHALL generate ranked person-link suggestions with attached machine-checkable evidence from deterministic detectors — same resolved display name, claim-entity co-citation, number succession (one identity's activity ending where another's begins in the same chats, informed by the group-membership timeline), and shared resolved vCards — and any future model-based producer SHALL write into the same suggestion store. Group co-presence SHALL serve only as corroborating evidence within other detectors (notably succession) and MUST NOT produce standalone suggestions: simultaneous co-presence pairs proved to be mostly false positives on real data. A suggestion MUST NOT modify membership: only an explicit user acceptance connects, and the resulting membership carries source `user` with the suggestion as evidence. Rejected suggestions SHALL be persisted such that the same pair is never re-suggested for the same detector kind; only a human-initiated undo MAY return a rejected pair to pending, after which normal pending behavior applies. Detectors SHALL skip pairs that are already co-members or suppressed. A pair with no unifiable history — neither identity has ever sent a message — SHALL NOT be presented: detectors skip producing it and prune it if pending, and because detectors recompute from state, the pair SHALL surface on its own once either identity speaks (superseded rows resurrect; rejected and accepted rows never do without a human undo). Detector passes SHALL be bounded and interruption-safe. Presented suggestions SHALL carry human-decidable context resolved at read time — complete numbers, each identity's chat reference, and display labels for evidence-referenced chats — with raw evidence payloads available but never the primary presentation. Multiple signals for the same pair SHALL present as one combined card whose confidence fuses the independent signals (each corroborating signal reduces remaining doubt; no fused score reaches certainty), and the human decision SHALL operate on the pair: acceptance connects it once, and dismissal persists rejection for every signal so none of them re-suggests the pair.

#### Scenario: Same-name identities are suggested, never connected
- **WHEN** two identities resolve to the same display name
- **THEN** a ranked suggestion with the colliding name as evidence is produced, and the identities remain separate persons unless a user accepts it

#### Scenario: Rejection is remembered
- **WHEN** a user rejects a suggestion and the detector pass later re-runs over unchanged or strengthened evidence
- **THEN** no new suggestion for that pair and kind is produced

#### Scenario: Only a human undo revives a rejection
- **WHEN** a rejected pair is undone by the user and a detector pass later re-runs
- **THEN** the pair is pending again and detectors update or prune it by normal rules, while a pair without an undo stays silenced forever

#### Scenario: Succession pattern produces evidence-backed suggestion
- **WHEN** one identity's messages cease across the chats where a second identity subsequently appears, consistent with the group-membership timeline
- **THEN** a succession suggestion is produced whose evidence names the shared chats and the silence/appearance windows

#### Scenario: Acceptance is a user connect
- **WHEN** a user accepts a pending suggestion
- **THEN** the identities are connected with source `user` and evidence referencing the accepted suggestion, and the suggestion status becomes accepted

### Requirement: Nothing Groups By Name
No system component SHALL group, merge, or aggregate identities or persons by display name. A name collision SHALL only ever produce a suggestion. Person display labels SHALL derive at read time from member identities' resolved labels; the system SHALL NOT store an authoritative person name.

#### Scenario: Two same-name contacts stay separate everywhere
- **WHEN** two distinct identities share the display name "Rohit" with no connecting evidence accepted
- **THEN** every surface — search, chat lists, person lists, brain status — presents them as two persons, with at most a pending suggestion relating them

### Requirement: Pack-Local Person Resolution
Extraction-time entity resolution SHALL remain strictly pack-local: entity names SHALL resolve only against the evidence pack's participants and mentioned JIDs, never through a global name lookup and never through person membership. A name that does not match a pack participant SHALL commit as an unresolved text entity with no identity anchor, eligible for suggestion machinery but never silently attached.

#### Scenario: Non-participant name commits unresolved
- **WHEN** a claim mentions a person name that matches no pack participant label, even though an identity elsewhere in the archive has that exact name
- **THEN** the claim entity commits with the name and a NULL identity anchor, and no person-level linkage is created by extraction

### Requirement: Unconfirmed Hints Stay Display-Level
A high-confidence pending suggestion MAY surface as a display-level annotation ("possibly the same as … — unconfirmed") on owner-facing surfaces. Hints MUST NOT influence claims, evidence packs, prompts, rollup synthesis, or search ranking, and MUST disappear when the suggestion is accepted, rejected, or superseded.

#### Scenario: Hint never reaches the model
- **WHEN** an identity carries an unconfirmed-hint annotation and its messages are assimilated
- **THEN** the evidence pack and prompt contain no trace of the hint and committed claims are identical to what an unhinted run produces

### Requirement: Identity Merge Reconciles The Person Layer
When an archive-layer merge collapses a LID onto its canonical phone identity, the merge SHALL rewrite person memberships, suggestions, and suppressions onto the canonical JID in the same transaction: duplicate pair rows collapse, pairs that become self-referential are deleted, and persons revealed to share an identity union per the membership requirement.

#### Scenario: Merged identity keeps its person membership
- **WHEN** a LID that is a person member merges onto its phone identity
- **THEN** the membership row carries the canonical JID afterward, and no duplicate or dangling person-layer row remains

### Requirement: Person Management Surface
The system SHALL expose the person model to consumers and the owner as a complete management surface: listing persons with member provenance, pending suggestions with their evidence and ranking, and operations to connect, disconnect, accept, and reject — each taking effect immediately and visibly. Passes and scans exceeding roughly one second SHALL report progress through the existing job machinery.

The surface SHALL present both actionable hygiene kinds, each as its own focused view: unresolved-name debt items ("name this contact", ranked by the message volume and episode count a name would repair) and pending pair suggestions ("confirm this pair", ranked by fused confidence and merge value). A debt item SHALL be fixable in place: naming an identity from the surface SHALL persist the name with user provenance and route through the identity-repair entry point so episodes, search, and labels update deterministically with no model call, and the outcome (episodes repaired) SHALL be reported to the user.

The dismissed-pair review SHALL support a human-initiated undo that returns the pair to pending. Blocked pairs (suppressions written by disconnects and dismissals) SHALL be reviewable with their reason and display context, and SHALL support a release action that lifts the block WITHOUT connecting — the pair simply becomes eligible for auto-connect and detectors again, and the release is audited. The surface SHALL also allow manually connecting any two identities the user names (numbers or ids), whether or not any detector suggested them — a user-source connect with the standing semantics (clears blocks, unions persons that share an identity). The append-only membership audit trail (connect, disconnect, union, dissolve, suggest, accept, reject, unreject, release) SHALL be reviewable on the surface with each action's source and evidence.

The compare view SHALL present decision evidence beyond text: each identity's recent already-stored media as thumbnails, the shared-group membership timeline (joined/left windows per side, group labels resolved), and — only while a live session is connected — profile photos fetched on demand, cached locally with a bounded lifetime and negative caching. Evidence enrichment MUST NOT block the view: missing media, an unavailable photo, or a disconnected live session degrade to text-only evidence. Fetched photos SHALL remain local, outside the archive database, and never appear in logs.

The surface SHALL refresh from the archive-events stream so background auto-connects, detector runs, and syncs become visible without a manual reload.

#### Scenario: Provenance is visible at the point of control
- **WHEN** the owner views a person whose members were connected from a Google contact and a number-change event
- **THEN** each membership shows its source and evidence, and a one-click disconnect is available beside it

#### Scenario: Both hygiene kinds are actionable in their own views
- **WHEN** the archive has bare-number identities in episode debt and pending pair suggestions
- **THEN** the surface presents a ranked naming view and a ranked confirmation view, each item actionable in place with its payoff visible

#### Scenario: Naming from the queue repairs the brain deterministically
- **WHEN** the owner names a bare-number identity from a debt item
- **THEN** the name persists with user provenance, affected episodes and search repair with zero model calls, and the item reports how many episodes were repaired

#### Scenario: Undo restores a dismissed pair
- **WHEN** the owner undoes a dismissal from the review surface
- **THEN** the pair's rejected rows return to pending, the undo is audited, and the pair re-ranks in the queue under normal pending rules

#### Scenario: Releasing a block re-enables automation without connecting
- **WHEN** the owner releases a blocked pair that a disconnect created
- **THEN** nothing connects at that moment, the release is audited, and the next sync or scan may auto-connect or re-suggest the pair under normal rules

#### Scenario: Manual connect needs no suggestion
- **WHEN** the owner enters two numbers no detector ever paired and confirms
- **THEN** the identities connect with source `user`, any block on the pair is cleared, and persons revealed to share an identity union

#### Scenario: Audit trail is reviewable
- **WHEN** the owner opens the membership history
- **THEN** each connect, disconnect, union, dissolve, accept, reject, unreject, and release appears with its time, source, and evidence, without exposing message bodies

#### Scenario: Photos and media never block a decision
- **WHEN** the owner opens a compare view while live sync is disconnected and one identity has no stored media
- **THEN** the view renders immediately with text evidence, placeholders stand in for the missing photo and media, and nothing spins waiting on a fetch

#### Scenario: Background scans surface without reload
- **WHEN** a recurring scan auto-connects a pair while the surface is open
- **THEN** the surface refreshes from the archive-events stream and the change is visible without user action

### Requirement: Graph-Facing Person Aggregation Contract
Person-level graph reads SHALL resolve membership at read time: an entity query for any member identity SHALL aggregate identity-anchored graph state (nodes, node-claim junctions, edges, and salience inputs) across all current members of that identity's person, and a lone identity SHALL answer as its own single-member aggregate. Person membership edits SHALL require zero graph writes: no brain graph table row SHALL key on a person id, and connect or disconnect SHALL change subsequent aggregated reads only. Graph surfaces SHALL render person labels resolved through the person/identity layer at read time — a rename or membership change re-labels and re-scopes reads with no node, edge, or episode regeneration.

#### Scenario: Connect widens the graph aggregate immediately
- **WHEN** two identities whose person nodes each carry claims are connected into one person
- **THEN** the next entity query for either JID aggregates both identities' nodes, claims, and edges, and no graph rows were inserted, updated, or deleted by the connect

#### Scenario: Disconnect narrows the aggregate with zero graph writes
- **WHEN** an identity is disconnected from a person after aggregated graph reads were served
- **THEN** subsequent entity queries exclude that identity's graph state, again with zero graph table writes

#### Scenario: No durable graph state keys on a person id
- **WHEN** the graph schema and its write paths are inspected
- **THEN** nodes, edges, evidence, junctions, and aliases key on identity JIDs, natural keys, or claim ids — never on a person id
