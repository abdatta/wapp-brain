# person-identity-model Specification (delta)

## MODIFIED Requirements

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
- **THEN** each connect, disconnect, union, dissolve, accept, reject, and unreject appears with its time, source, and evidence, without exposing message bodies

#### Scenario: Photos and media never block a decision
- **WHEN** the owner opens a compare view while live sync is disconnected and one identity has no stored media
- **THEN** the view renders immediately with text evidence, placeholders stand in for the missing photo and media, and nothing spins waiting on a fetch

#### Scenario: Background scans surface without reload
- **WHEN** a recurring scan auto-connects a pair while the surface is open
- **THEN** the surface refreshes from the archive-events stream and the change is visible without user action

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
