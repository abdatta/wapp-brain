# commitment-tracking Delta Spec

## ADDED Requirements

### Requirement: Cited Lifecycle Transitions
The brain SHALL record commitment and question lifecycle transitions as durable append-only events keyed by the lifecycle claim id — never only in graph tables — where each event carries a target status (`fulfilled`, `dismissed`, `still_open`, or `reopened`), a source (`model` or `user`), optional evidence time and note, and zero or more citations resolving to archived source message keys. The current status of a lifecycle node SHALL be a pure fold of its claim's events (last terminal status not followed by `reopened`, else `open`), and the node's payload status, resolved-at, and last-reviewed stamps SHALL be a mechanical projection of that fold, updated in the same transaction as the event insert. Salience dormancy exemption and due-date boosts SHALL follow the folded status: nodes folding to `fulfilled` or `dismissed` decay and may go dormant like ordinary nodes.

#### Scenario: Model closure applies atomically with citations
- **WHEN** a validated model resolution `{node, status: fulfilled, cites}` is applied to an open commitment node
- **THEN** one transaction inserts the event and its citation rows, re-projects the node payload to `fulfilled` with a resolved-at stamp, and the node no longer folds as open

#### Scenario: Reopen restores open semantics
- **WHEN** a user reopens a commitment that a sweep marked fulfilled
- **THEN** an appended `reopened` event makes the fold `open` again, the node regains dormancy exemption and due boosts, and both the closure and the reopen remain visible in the event history with their sources

#### Scenario: Closed node decays normally
- **WHEN** a salience recompute runs after a commitment node's fold became `fulfilled`
- **THEN** the node receives no open-lifecycle dormancy exemption or due boost and may become dormant under the normal threshold

### Requirement: Postdating Citation Validation
A model-sourced terminal transition (`fulfilled` or `dismissed`) SHALL carry at least one citation; every citation SHALL be a source message key that was offered to the model as candidate evidence for that node in the same call (closed world), and every citation's timestamp SHALL postdate the lifecycle claim's anchor — the maximum citation timestamp of the claim that minted the node. A resolution citing an unknown node, a non-offered message key, or a backdated message SHALL be a collected validation error, never a silent drop or a partial apply. `still_open`, `reopened`, and user-sourced transitions SHALL NOT require citations. The transactional writer SHALL re-check the postdating rule independently of the candidate query so any future caller (including rollup calls) inherits the same guarantee.

#### Scenario: Backdated resolution rejected
- **WHEN** a model resolution cites a message whose timestamp is at or before the commitment claim's anchor
- **THEN** validation rejects it as a collected error and the node stays open

#### Scenario: Hallucinated citation rejected
- **WHEN** a model resolution cites a message key that was not offered as candidate evidence for that node
- **THEN** validation rejects it as a collected error and no event is recorded for that resolution

#### Scenario: User closure needs no citation
- **WHEN** the user closes a commitment from the UI with an optional note and no citation
- **THEN** the transition applies as a `user`-source event and the fold reflects the closure

### Requirement: Deterministic Closure Candidates
The brain SHALL compute closure candidates for open lifecycle nodes with pure SQL and zero model calls, from exactly these producers: reactions targeting the claim's cited messages that postdate the anchor (reactor resolved to identity labels); archived replies whose captured quoted snapshot or legacy pointer resolves to a cited message, postdating the anchor, including cross-chat Reply Privately replies; current model-generated claims in the same chat whose citations postdate the anchor and which share at least one entity with the lifecycle claim (JID match, or normalized-name match when both lack a JID); and due-date passage as non-citable context. Candidates SHALL be bounded per node and recency-ranked. A sweep-due predicate SHALL select only open nodes with at least one candidate newer than the later of the node's anchor and last review, or whose due date passed since the last review — nodes with no new evidence SHALL never consume a model call. Candidate counts SHALL surface per node and in aggregate with no model call.

#### Scenario: Late reaction becomes a candidate
- **WHEN** a 👍 reaction lands on an already-assimilated promise message days after the promise's episode committed
- **THEN** the candidate query returns it for the commitment node with the reactor's resolved label and its timestamp, and the node becomes sweep-due

#### Scenario: Unchanged node is skipped
- **WHEN** an open commitment has been reviewed by a sweep and no new candidate evidence arrived since
- **THEN** the sweep-due predicate excludes it and the next sweep makes no model call for it

#### Scenario: Cross-chat reply candidate
- **WHEN** a one-to-one reply quotes a group-chat promise message cited by an open commitment node
- **THEN** the reply appears as a candidate for that node through its reply-owned snapshot without querying the group chat

### Requirement: Model Closure Sweep
The brain SHALL provide a manual-first closure sweep as a run kind: the user triggers it (whole archive or one chat) with an explicit provider, model, and reasoning effort; it batches sweep-due nodes per chat into bounded calls whose prompt renders each node's claim, holder, absolute dates, and candidate evidence inside injection-hardened fences; and it requests strict JSON `{resolutions:[{node, status, cites, note?}]}`. Responses SHALL be normalized mechanically, validated with all errors collected into a single retry, and on second failure recorded as error-severity validation issues while every affected node stays open — there SHALL be no extractive or heuristic closure fallback. Offered nodes not terminally resolved SHALL record a `still_open` review event so staleness can distinguish reviewed-open from never-reviewed. Sweep calls SHALL be recorded in the token ledger under a `lifecycle` purpose, enforce the daily caps and per-run call/token budgets as named stops, respect provider health gates identically to episode runs, and report progress and failures through the run progress surfaces.

#### Scenario: Promise closed by reaction evidence
- **WHEN** a sweep runs over a commitment whose candidates include a postdating acknowledgment reaction on the promise message
- **THEN** the model may resolve it `fulfilled` citing that message key, the transition applies with the citation, and the run records the call in the ledger under `lifecycle`

#### Scenario: Failed sweep leaves nodes open
- **WHEN** a sweep call fails validation twice
- **THEN** all collected errors persist as validation issues, no transition is applied, the affected nodes remain open and sweep-due, and the run outcome reports the failure visibly

#### Scenario: Review stamp distinguishes stale from unreviewed
- **WHEN** a sweep offers an open node and the model returns `still_open`
- **THEN** a review event updates the node's last-reviewed stamp without changing its folded status

#### Scenario: Budget stops are named
- **WHEN** a sweep reaches its per-run call or token budget mid-drain
- **THEN** no further model call is made and the run ends budget-exceeded naming the exhausted budget, with applied transitions kept

### Requirement: Open Items Surface
The brain SHALL expose a lifecycle read surface — API route, CLI, and a dedicated commitments page — whose open-items semantics are status-driven and independent of salience and dormancy: every node folding to `open` appears regardless of salience, each item carrying the claim text, chat and holder resolved to read-time labels, opened/due/last-evidence/last-reviewed stamps, a candidate count, and flags `overdue` (open with a due date before the as-of time) and `stale` (open with neither evidence nor review within the configured stale window) rendered distinctly from plain `open`. Responses SHALL carry an as-of stamp. Ordering SHALL be deterministic: overdue first (most overdue first), then due-dated ascending, then undated by last evidence descending. Closed items SHALL be listable with their resolving event, source, citations, and note; citations SHALL click through to the exact archived messages. Manual close, dismiss, and reopen controls SHALL be available on this surface, and every terminal user transition SHALL be revertible via reopen. These semantics are pinned here for downstream retrieval surfaces to reference, not redefine.

#### Scenario: Overdue commitment surfaces despite dormant-tier salience
- **WHEN** a quiet chat's open commitment passes its due date while every other node of that chat has decayed below the dormancy threshold
- **THEN** the open-items list shows it flagged `overdue` with its due date and last-evidence stamp, ordered before non-overdue items

#### Scenario: Stale is distinct from open
- **WHEN** an open commitment has had no new evidence and no review for longer than the stale window
- **THEN** it renders flagged `stale`, distinctly from fresh `open` items, while a reviewed item inside the window shows plain `open`

#### Scenario: Closed item shows its resolution trail
- **WHEN** the user opens the closed-items view for a fulfilled commitment
- **THEN** it shows the resolving status, source, date, optional note, and citations that click through to the archived acknowledgment messages

### Requirement: Resolves Edge Projection
Terminal model-sourced transitions SHALL project `resolves` edges into the graph: one edge per distinct resolver person node (the canonical identity behind each cited evidence message — reactor, reply sender, or citing message sender) targeting the lifecycle node, with the cited message keys as edge evidence rows. The durable events remain the truth; edges SHALL be re-derivable from them, idempotent under re-application, and absent for citation-less user transitions. The `resolves` edge kind SHALL thereby have a producer and appear on graph read surfaces like any other evidenced edge.

#### Scenario: Resolution creates an evidenced edge
- **WHEN** a model resolution closes a commitment citing an acknowledgment message from a known sender
- **THEN** a `resolves` edge exists from that sender's person node to the commitment node carrying that message as evidence, visible in the node's neighborhood

#### Scenario: Edge re-derives after rebuild
- **WHEN** the graph is wiped and rebuilt after resolutions were recorded
- **THEN** the same `resolves` edges re-derive from the durable events with zero model calls

### Requirement: Lifecycle State Survives Rebuild And Regeneration
Lifecycle events SHALL persist outside graph tables and survive graph wipes: rebuild SHALL re-project folded statuses onto re-minted lifecycle nodes and re-derive `resolves` edges with zero model calls, and brain derived-data resets SHALL wipe lifecycle events alongside episodes. When regeneration supersedes an episode whose lifecycle claim carries events, the same transaction SHALL re-key those events onto the replacement claim when exactly one same-kind lifecycle claim among the replacement episodes shares at least one citation message key with the superseded claim; otherwise the events SHALL be marked orphaned — retained for audit, excluded from folds, and counted on the lifecycle surface as visible debt — leaving the replacement node honestly open.

#### Scenario: Closure survives a graph rebuild
- **WHEN** a commitment is closed with citations and the graph is later wiped and rebuilt
- **THEN** the rebuilt commitment node folds to its closed status with its resolved-at stamp, without any model call

#### Scenario: Regeneration re-keys the resolution
- **WHEN** regeneration supersedes an episode whose commitment claim was closed, and exactly one commitment claim in the replacement cites one of the same promise messages
- **THEN** the events re-key to the replacement claim in the same transaction and the new node folds closed

#### Scenario: Ambiguous replacement orphans honestly
- **WHEN** regeneration produces no same-kind replacement claim sharing a citation with a closed superseded claim
- **THEN** the events are marked orphaned, the replacement node (if any) is open, and the orphaned count is visible on the lifecycle surface

### Requirement: Single Resolution Contract
The resolutions schema fragment, its closed-world postdating validation, and the transactional transition writer SHALL be the single contract for every closure executor. Semantic consolidation calls that later execute closure SHALL embed the same fragment, restrict citations to message keys present in their own input, and apply transitions through the same writer in their own transaction — no consolidation path may write lifecycle state through any other mechanism.

#### Scenario: Rollup closure reuses the writer
- **WHEN** a future consolidation call returns a resolutions array alongside its page rewrite
- **THEN** the resolutions validate under the same closed-world postdating rules and apply through the same transactional writer as the sweep's

#### Scenario: No second write path exists
- **WHEN** any surface (sweep, rollup, UI, CLI) records a lifecycle transition
- **THEN** the durable event, payload projection, and edge projection are produced by the one shared writer, keeping fold semantics identical everywhere
