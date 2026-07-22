# semantic-consolidation — Delta Spec (semantic-rollups)

## ADDED Requirements

### Requirement: Structured Consolidation Output
A doc revision SHALL be produced as structured statements — sections of `{text, claims:[claim refs]}` — from which the markdown page is deterministically rendered; the model SHALL never author the document text directly. Every statement SHALL reference at least one fed claim by prompt-local alias, resolved to claim ids before commit (closed world: aliases from this call's input only). Consolidation input SHALL be current model-generated claims — never raw messages, never prior page prose (the prior revision contributes only its claim-ref accounting), never extractive-generator claims, never superseded claims. Validation SHALL follow the house pattern: mechanical salvage without consuming the retry, collect-all errors into one retry, and on second failure the doc's prior revision stays current with an error-severity validation issue — there SHALL be no extractive fallback for pages.

#### Scenario: Statement citing an unknown alias is refused after one retry
- **WHEN** a rollup response references a claim alias not present in the call's input, and the single retry (enumerating every collected error) repeats the violation
- **THEN** no revision commits, the prior revision stays current, a rejected revision is retained with its errors, and an error-severity validation issue is recorded

#### Scenario: Extractive and superseded claims never enter input
- **WHEN** the input selector assembles claims for a doc whose scope contains extractive-generator claims and claims with `superseded_by_claim_id` set
- **THEN** neither appears in the rendered input, and the persisted fed-claim audit confirms their absence

#### Scenario: No placeholder page on model failure
- **WHEN** the provider fails or is degraded during a doc's rollup call
- **THEN** the doc is skipped or the run stops as named-interrupted — no extractive or partial page is ever written

### Requirement: Deterministic Input Selection With Persisted Audit
The input selector SHALL feed the doc's full eligible claim set whenever it fits the configured input budget; tiered quotas SHALL engage only on overflow, in pinned order: open lifecycle items for the doc scope, conflict co-location pairs, then remaining claims by salience-weighted recency with per-time-bucket coverage floors. Each claim SHALL render dated (episode date range or min citation timestamp), with kind and confidence, inside injection-hardened fences, oldest-first, carrying its citation message keys. Every revision SHALL persist the exact fed-claim id set and input stats (counts, overflow flag, tiers engaged) so exclusions are auditable and "not fed" is distinguishable from "fed and dropped".

#### Scenario: Doc under budget feeds everything
- **WHEN** a doc's eligible claims fit the input budget
- **THEN** all of them are fed with no tier logic engaged, and the audit records overflow=false with the full fed set

#### Scenario: Overflow engages tiers without losing lifecycle items
- **WHEN** a doc's eligible claims exceed the input budget
- **THEN** open lifecycle items and detected conflict pairs survive selection, remaining slots fill by coverage-preserving recency, and the audit records the engaged tiers and the exact fed set

#### Scenario: Deictic claim text arrives dated
- **WHEN** a fed claim's text contains relative time ("tomorrow") from a 2014 episode
- **THEN** its rendered input line carries the episode's absolute date range, so the semantic tier never re-interprets stale deixis as current

### Requirement: Conflict Recall And Post-Write Verification
The deterministic conflict detector (cross-episode claim pairs in the doc scope with same kind, shared entity, and topic or time overlap; bounded, set-based SQL) SHALL be used exactly two ways: to co-locate both members of a detected pair in the input as ordinary unlabelled dated claims, and to re-run post-commit over the revision's referenced claims, recording residual contradictions as warning-severity validation issues on the doc. The detector's output SHALL never be presented to the model as a conflict, a pairing, or an instruction to resolve.

#### Scenario: Conflicts are co-located but never labelled
- **WHEN** the detector pairs two claims and the doc overflows the input budget
- **THEN** both claims are fed as ordinary dated claim lines, and the rendered prompt contains no conflict marker, pair reference, or resolution instruction

#### Scenario: Residual contradiction is flagged, not respun
- **WHEN** a committed revision references both members of a detected pair with neither superseding the other
- **THEN** a warning-severity `rollup_contradiction` issue records both claim ids against the doc, visible on the run console and doc surface, and no automatic re-roll occurs

### Requirement: Exact Regression Guard
Before commit, the guard SHALL compute dropped = prior revision's referenced claims − new referenced claims − claims no longer current in storage (the last annotated mechanically as deleted, never charged to the model), and SHALL refuse the revision unless every dropped claim appears in the declared drops with a machine-readable reason (`superseded` with a newer fed claim, `stale`, or `out_of_scope`). A refused revision SHALL be retained as rejected with its errors, the prior revision SHALL stay current, and a visible validation issue SHALL be recorded. Quantity thresholds SHALL NOT be used. When stale-reason drops exceed the configured share of prior refs, an info-severity issue SHALL record the mass-shed.

#### Scenario: Undeclared claim drop is refused
- **WHEN** a rollup response omits claims the prior revision represented without declaring them in drops (a stub model dropping half its claims)
- **THEN** the revision is refused, the prior revision stays current, the rejected revision is retained for audit, and a validation issue is visible

#### Scenario: Declared supersession is accepted and recorded
- **WHEN** a response drops a prior claim declaring `{reason: superseded, by: <newer fed claim>}`
- **THEN** the revision commits and the drop is durably recorded in the revision

#### Scenario: Upstream claim deletion is not the model's fault
- **WHEN** episode regeneration deleted claims the prior revision referenced, and the next rollup response neither references nor declares them
- **THEN** the guard auto-annotates them as deleted and the revision commits without requiring model declarations for them

### Requirement: Claim Supersession Projection
Declared supersession SHALL be projected to `brain_claims.superseded_by_claim_id` (nullable, set-null on upstream deletion), with the revision record as the durable truth from which the projection is re-derivable. Superseded claims SHALL be excluded from future consolidation input and SHALL be filterable by downstream readers.

#### Scenario: Superseding claim dies upstream
- **WHEN** the episode of a superseding claim is regenerated, cascading its claims away
- **THEN** pointers to it null out, the revision's drop record survives as history, and the affected doc becomes due so the next rollup re-derives dispositions from current claims

### Requirement: Embedded Lifecycle Resolutions
Rollup calls SHALL embed the commitment-tracking resolutions contract verbatim — shipped vocabulary `fulfilled|dismissed|still_open`, cites as message keys — and apply accepted resolutions via the single lifecycle writer inside the same transaction as the revision commit. The closed world for cites SHALL be the message keys actually present in this call's input; the writer's independent re-validation applies unchanged. The standalone closure sweep SHALL remain the page-free closure path.

#### Scenario: Resolution applies atomically with the page
- **WHEN** a rollup response resolves an open commitment citing a message key from a fed claim's citations
- **THEN** the lifecycle transition and the revision commit in one transaction, and the closed item shows the rollup's run id in its event trail

#### Scenario: Out-of-input cite is rejected
- **WHEN** a resolution cites a message key not present in the call's input
- **THEN** the resolution fails validation (collected into the single retry; refused on repeat) and no partial lifecycle state is written

### Requirement: Manual-First Rollup Runs
Rollups SHALL execute as a run kind `rollup`: user-triggered (console/CLI), scoped to one doc, a doc list, or the top-K due docs by salience; one model call per doc at per-run model and effort (defaulting to the run's persisted selection at high effort); honoring per-run call/token ceilings and the daily ledger; checking provider degradation between docs and stopping as a named resumable interruption; yielding between docs so the event loop is never blocked. Docs SHALL become due only through deterministic conditions (eligibility floor, new-claims threshold, referenced-claim deletion, lifecycle change, node/person merge), computed by set-based bulk queries; dueness counts SHALL be visible without triggering spend.

#### Scenario: Budget stop is named, not silent
- **WHEN** a rollup run reaches its call ceiling or the daily ledger cap mid-run
- **THEN** the run finalizes as budget-exceeded with completed docs committed, remaining docs still due, and the console showing the named stop

#### Scenario: Degradation interrupts cleanly
- **WHEN** the provider latches degraded between docs in a run
- **THEN** the run stops as named-interrupted with no placeholder output, and re-running after recovery resumes from the recomputed due set

#### Scenario: Dueness is visible for free
- **WHEN** the user opens the brain surface after new episodes commit
- **THEN** the docs-due count reflects the deterministic conditions without any model call

### Requirement: Deterministic Markdown Projection
Pages SHALL project to the vault as a pure function of stored state: entity/topic/chat files keyed by immutable node slug, frontmatter with doc/node/revision identity and aliases, statements with per-statement anchors and structural citation links (episode-file wikilinks with claim anchors plus raw message keys), and a deterministic Related footer from graph edges. Wikilinks SHALL only ever be structural — prose is never parsed for linking. Docs whose node merges SHALL become redirect stubs to the survivor's doc. A rebuild command SHALL re-render all current docs and the overview from storage, idempotently, with zero model calls.

#### Scenario: Rebuild is idempotent
- **WHEN** the projection rebuild runs twice with no storage changes between
- **THEN** the second pass produces byte-identical files

#### Scenario: Merged node's doc becomes a stub
- **WHEN** a node with a doc merges into a survivor
- **THEN** the doc's file renders as a redirect stub to the survivor's doc and held links resolve without dangling

### Requirement: Identity Repair Reaches Statements
Identity rename/merge prose repair SHALL extend to statement text in doc revisions using the same substitutable-label discipline as episodes, followed by deterministic re-render of affected files — zero model calls.

#### Scenario: Renamed contact re-labels pages without regeneration
- **WHEN** a contact rename triggers identity prose repair
- **THEN** affected docs' statement text re-labels deterministically, files re-render, and no rollup call is spent

### Requirement: Deterministic Overview
The overview (file and API) SHALL render entirely from existing deterministic reads — top-salience active nodes with doc links, lifecycle open/overdue/stale counts and soonest-due items, docs-due count, coverage/freshness stamps, and visible debts (orphaned resolutions, validation issues) — refreshed after runs and on rebuild, with zero model calls.

#### Scenario: Overview is fresh without spend
- **WHEN** a rollup or lifecycle run completes, or the rebuild command runs
- **THEN** the overview reflects current state with no model call in the render path

### Requirement: Readable, Stable Vault File Names
Projected file names SHALL be readable in Obsidian, where the file name is the note title. Every name SHALL carry a stable machine id — episodes their short episode id, pages their immutable slug — because display names collide (one archive has seven chats named the same) and may be absent entirely. Labels SHALL be sanitized for the filesystem while preserving non-ASCII, which carries the readability. One definition SHALL produce both the projected file name and the wikilinks that target it. A projection pass SHALL remove files for the same entity written under a different label, so a rename leaves no duplicate.

#### Scenario: Names read as titles
- **WHEN** episodes and pages project to the vault
- **THEN** episode files lead with the date and the chat's name, page files lead with the entity's name, and each ends with the stable id that makes it unique

#### Scenario: A rename leaves no duplicate and no dangling link
- **WHEN** a chat or contact is renamed and the projection re-runs
- **THEN** affected files are rewritten under the new label, the files under the old label are removed, the total file count is unchanged, and every wikilink still resolves

#### Scenario: Hostile names stay findable
- **WHEN** a name contains characters the filesystem forbids, is empty, or is a reserved device name
- **THEN** the projected name is sanitized deterministically and remains matchable by its stable id

### Requirement: Revision History And Rollback
Every revision (current, superseded, rejected) SHALL be retained with its statements, drops, fed-claim audit, input stats, model/effort/run stamps, and errors. A mechanical rollback SHALL flip a doc's current revision to a prior one, re-render its file, and record the action visibly — no model calls.

#### Scenario: Rollback restores mechanically
- **WHEN** the user rolls a doc back to its prior revision
- **THEN** the prior revision becomes current, the file re-renders to match, the action is recorded, and the doc's subsequent dueness reflects the restored state

### Requirement: Run Effect Audit
Every durable change a run makes SHALL be attributable to that run and readable back. Run history SHALL carry per-run effect counts — page revisions written and refused, lifecycle transitions, claim supersessions, episodes committed, issues raised — so an effect is visible in the list without opening the run. History SHALL be scopable to one doc, returning the runs that wrote or were refused a revision of it, or raised an issue against it, each with what that run did to that page. The per-run audit SHALL resolve each lifecycle change to its item text, evidence, and the item's status NOW, and SHALL offer that item's actions — including reversing the change — in place, without leaving the audit. Reversing SHALL NOT rewrite history: the run's record of what it did is permanent, and the audit reports the item's current status alongside it. Reading the audit is a pure read of existing `run_id` stamps — no new write path — and every effect lookup SHALL be an index walk.

#### Scenario: A page's own run history
- **WHEN** the user opens the run history of a page
- **THEN** only the runs that touched that page are listed, each showing what it did to the page (including refusals) and what else it changed durably

#### Scenario: Side effects are visible without drilling in
- **WHEN** a rollup run closed a commitment while writing a page
- **THEN** the run's history entry states the commitment change alongside the page write, and the audit resolves it to the item, its evidence, and its current status

#### Scenario: Undoing a model's closure from the audit
- **WHEN** the user opens a closed item from the audit and reopens it
- **THEN** it reopens without leaving the audit, the run still records that it closed the item, and the audit now shows the item's current status as open

### Requirement: Docs Read Surface
The server SHALL expose list and per-doc DTOs carrying meaning server-side: read-time-resolved titles, dueness and issue chips, rendered content plus structured sections, revision history with per-revision drop/supersession detail, and the input-audit summary. Consumers (UI, CLI, and later retrieval/MCP) SHALL receive the same shapes.

#### Scenario: Doc DTO is self-describing
- **WHEN** a client requests a doc
- **THEN** the response carries rendered content, sections with claim refs, history, issues, and audit summary — with display strings and flags computed server-side, no raw storage JSON
