# brain-assimilation Specification

## Purpose
TBD - created by archiving change build-the-brain. Update Purpose after archive.
## Requirements
### Requirement: Tiered Assimilation Substrate
The brain SHALL organize derived knowledge in tiers built strictly bottom-up — a hot tier (raw indexed messages, no LLM) and an episodic tier (cited per-chat conversation digests generated only from hot-tier messages) — and SHALL provide the durable substrate (queue, watermarks, runs, ledger) on which higher semantic consolidation is later built without reading raw messages directly.

#### Scenario: Episode generated from messages
- **WHEN** an episodic consolidation task runs for a chat window
- **THEN** the evidence pack contains only that window's conversation messages and the output is a cited episode digest

#### Scenario: Substrate is tier-agnostic
- **WHEN** work is enqueued for any tier
- **THEN** it flows through the same durable queue, watermark, run, and ledger machinery regardless of which tier produced it

### Requirement: Watermark Coverage Truth
The brain SHALL track per-chat assimilation watermarks as a compound cursor of timestamp and message rowid that advances only when an episode commits, and SHALL derive all coverage decisions (what to assimilate next, what coverage to report) from that cursor rather than from schedule execution. Coverage and backlog SHALL derive from a single pending predicate so that no visible message is ever both reported covered and never selected: a visible message is covered for its chat only when a watermark row exists and the message is at or before the cursor (its timestamp is before the cursor timestamp, or equal to it with a message rowid at or below the cursor rowid); every other visible message is pending, including any message in a chat with no watermark row. Because the cursor includes the rowid, a genuinely-new message sharing the watermark timestamp is pending regardless of whether the boundary message was cited. Assimilated coverage SHALL be reported as total visible messages minus pending, never from an independent `<=` timestamp predicate.

#### Scenario: Crash before commit
- **WHEN** a run is interrupted after generation but before an episode commits
- **THEN** the chat's watermark is unchanged and the next run re-covers the same window idempotently

#### Scenario: Coverage reported from watermarks
- **WHEN** brain status is requested
- **THEN** it reports assimilated-through timestamps and pending counts per chat derived from watermarks, with assimilated equal to total visible minus pending

#### Scenario: Message tied to the watermark stays visible
- **WHEN** a second visible message arrives with a timestamp exactly equal to a chat's watermark after that chat's episode has committed
- **THEN** it has a higher rowid than the cursor, appears in the backlog, is not counted as assimilated, and is selected into the next evidence pack

#### Scenario: Seen boundary message is not re-opened
- **WHEN** a committed episode's boundary message was not cited by any claim
- **THEN** it remains covered (its rowid is at or below the cursor) and is not re-selected into a new episode

#### Scenario: No phantom coverage without a watermark
- **WHEN** a chat has visible messages but no watermark row (including a message whose timestamp is zero)
- **THEN** every such message is counted pending and none is reported assimilated

### Requirement: Durable Task Queue
All assimilation work SHALL flow through a durable task queue with unique dedupe keys per work unit, bounded retry with backoff, priorities, and per-tick budgets, such that interrupted work resumes without dedicated resume logic and duplicate work units are impossible.

#### Scenario: Interrupted run resumes
- **WHEN** the process restarts while tasks are pending or stuck in running state beyond their claim timeout
- **THEN** the next scheduler tick re-claims and executes them without duplicating committed work

#### Scenario: Duplicate enqueue is a no-op
- **WHEN** a task with an already-known dedupe key is enqueued again
- **THEN** no second task row is created

### Requirement: Cited Episode Extraction
Episodic consolidation SHALL produce structured digests where every claim cites at least one exact source message key present in the evidence pack; revisions with uncited or wrongly-cited claims SHALL be rejected, retried once with the validation error, and on second failure recorded as failed with an extractive fallback digest committed instead.

#### Scenario: Valid episode commits atomically
- **WHEN** a generated episode passes citation validation
- **THEN** the document revision, claims, citations, and watermark advance commit in one transaction

#### Scenario: Hallucinated citation rejected
- **WHEN** a generated claim cites a message key not present in the evidence pack
- **THEN** the revision is rejected, a validation issue is recorded, and coverage proceeds via the extractive fallback

### Requirement: Evidence Selection Policy

Evidence packs SHALL contain only conversation messages per the visible-exchange definition, rendered in resolved identity text with interpretation labels for non-text content, bounded in size, split at long silence gaps, and bounded to a maximum time span; system, reaction, and encrypted-update rows SHALL never consume model budget. Reactions on a pack message SHALL render as non-citable annotations on that message's evidence line, resolving each reactor to the same identity text as senders. A quoted reply SHALL carry a compact referent: the quoted message's citation alias when that message is in the pack, otherwise a non-citable inline snippet. A forwarded message SHALL be labelled as forwarded, with a prompt rule to attribute its content as shared or forwarded rather than said. A sender without a resolved display name SHALL be labelled by its verbatim number rather than the literal text "Unknown", and the prompt SHALL instruct referring to that participant by exactly that number. When two participants in one pack resolve to the same display name, each colliding label SHALL receive a deterministic disambiguating suffix and the prompt SHALL instruct using exactly the labels shown. Aliases SHALL be assigned only to real messages present in the pack; no annotation (reaction, out-of-pack quoted referent) SHALL be citable.

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

#### Scenario: Out-of-pack quoted reply is a non-citable snippet

- **WHEN** a reply's quoted message is not present in the pack
- **THEN** the reply line carries an inline snippet of the quoted message with its sender label and no citation alias, and no claim can cite the quoted message

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

### Requirement: Manual-First Run Control
Automatic consolidation SHALL be paused by default: the brain SHALL compute when a run is due (pending backlog plus a passed consolidation window) and surface a visible "run due" alert in the UI and status APIs, but SHALL NOT spend model budget until the user triggers a run or explicitly enables automatic scheduling. Every triggered run SHALL carry the user's provider and model selection, controllable entirely from the UI.

#### Scenario: Run due but not auto-executed
- **WHEN** backlog exists and the consolidation window has passed with scheduling paused
- **THEN** the UI shows a run-due alert with the pending scope, and no model call happens until the user starts the run

#### Scenario: User triggers a run with a chosen model
- **WHEN** the user starts a brain run from the UI selecting a provider and model
- **THEN** the run executes with exactly that provider and model, its usage is recorded against them in the ledger, and progress is visible throughout

### Requirement: Scheduled Dueness And Auto Execution
The brain SHALL compute scheduled episodic work — a nightly pass over chats with pending visible messages, a volume trigger for busy chats crossing a pending-count threshold while quiet, and a significance gate that folds low-activity chats into a weekly mini-episode rather than burning a nightly call — surfacing all of it as dueness, and SHALL execute it automatically only when automatic scheduling is enabled, running as the last recovery-tick pass under a `brain` job lock so live sync is never starved.

#### Scenario: Quiet chat folds weekly
- **WHEN** a chat accumulates fewer than the significance threshold of pending messages
- **THEN** no nightly episode is generated for it and its remainder is due as part of a weekly mini-episode

#### Scenario: Auto pass respects the tick order
- **WHEN** automatic scheduling is enabled and a recovery tick runs
- **THEN** the brain pass executes only after the media pass, holding the `brain` job lock, and yields so ingestion latency stays within normal bounds

### Requirement: Staleness Propagation
Message edits, deletions, and interpretation upgrades affecting already-assimilated messages SHALL mark dependent episodes stale and enqueue regeneration tasks; staleness SHALL be visible in brain status.

#### Scenario: Edit invalidates episode
- **WHEN** a live edit changes a message cited by a committed episode
- **THEN** the episode is marked stale and a regeneration task is enqueued

#### Scenario: Deletion invalidates episode
- **WHEN** a message cited by a committed episode is deleted
- **THEN** the episode is marked stale and a regeneration task is enqueued

### Requirement: Offline Catch-Up
Assimilation correctness SHALL NOT depend on schedules firing: on startup the brain SHALL audit watermarks against archive contents, enqueue tasks for all uncovered windows, and drain them rate-limited under the daily budget with visible progress.

#### Scenario: Two weeks offline
- **WHEN** the server starts after two weeks off
- **THEN** uncovered windows are enqueued and drained at the configured rate without blocking live sync or exceeding budgets

#### Scenario: Catch-up is resumable
- **WHEN** a catch-up drain is interrupted at any point
- **THEN** restarting continues from the queue with no duplicated episodes

### Requirement: Token Budget Ledger
The brain SHALL record every model call's purpose and token usage in a daily ledger and SHALL enforce configurable daily call and token caps as a hard named block state, never silent degradation; budget-skipped work SHALL be reported in run summaries. A run that terminates in any non-completed terminal state (interrupted, budget-exceeded, failed) SHALL persist the totals it accumulated before stopping, and a budget-exceeded run SHALL persist a count of work left pending because the budget was reached.

#### Scenario: Budget exhausted
- **WHEN** the daily cap is reached mid-run
- **THEN** remaining tasks stay pending, the run reports a budget-exceeded state, and work resumes when budget is available

#### Scenario: Budget-exceeded run keeps its totals
- **WHEN** a run commits several episodes and then stops because the model-call budget is reached
- **THEN** the persisted run record retains the committed episode, claim, chat, and model-call counts and records how many chats were left pending for budget

### Requirement: Episode Markdown Projection
The brain SHALL project committed episodes and their claims as Obsidian-compatible Markdown (frontmatter, claim anchors) under the private workspace, regenerated deterministically from the database after runs, with files named by immutable slug; projected files SHALL NOT be read back as source, and hand-edits SHALL be overwritten on the next projection (documented behavior).

#### Scenario: Episode projected after commit
- **WHEN** an episode commits
- **THEN** a Markdown file for it is written deterministically from the database, with claim anchors resolving to their citations

#### Scenario: Vault edits are not source
- **WHEN** a user hand-edits a projected Markdown file
- **THEN** the edit does not alter brain state and is overwritten on next projection

### Requirement: Non-Blocking Operation
All brain work SHALL run in bounded batches with event-loop yields, report progress for any operation over one second via job objects and server-sent events, respect the recovery-tick pass ordering so live sync is never starved, and never touch the WhatsApp socket.

#### Scenario: Nightly run during live sync
- **WHEN** a consolidation run executes while live messages are arriving
- **THEN** ingestion latency stays within normal bounds and the run reports progress until completion

#### Scenario: Failures are never silent
- **WHEN** any brain job fails, is interrupted, or is blocked
- **THEN** the state and a privacy-safe reason surface in the brain status UI, remain discoverable after page reloads and server restarts, and are mirrored as counts-and-durations-only lines in the server console

### Requirement: Identity Merge Reconciles Derived Brain State
When an identity merge collapses a chat or sender from one JID form to its canonical form, the merge SHALL reconcile the derived brain state in the same transaction with deterministic statements and no model call: episodes SHALL move to the surviving chat source id, citations SHALL be rekeyed through the stable message rowid anchor (repointing any citation whose message row was collapsed onto the surviving row), the surviving chat's watermark cursor SHALL be the greater of the two chats' `(timestamp, rowid)` cursors, and pending tasks referencing the pre-merge chat SHALL be dropped (or rekeyed) so the drain never re-covers an orphaned window. Merges SHALL NOT strand watermarks or tasks under the dead identity, produce duplicate re-assimilation, or leave citations pointing at stale message keys.

#### Scenario: Merged chat shows no phantom backlog
- **WHEN** a chat with committed brain history is merged from its LID form to its PN form
- **THEN** the surviving chat carries the merged watermark, the backlog shows zero pending for the already-assimilated window, and the next run produces no duplicate episodes

#### Scenario: Citations survive the merge
- **WHEN** an episode's cited messages are rekeyed by the merge
- **THEN** each citation resolves to its message under the canonical key with no lost or dangling citation

#### Scenario: Stranded task does not re-cover an orphaned window
- **WHEN** a pending episode task references a chat that is then merged away
- **THEN** the task no longer points at the dead identity and the next drain covers only the surviving chat's genuinely pending window

### Requirement: Run Outcome Honesty
Every brain run SHALL report its outcome truthfully. The run summary and completion notice SHALL distinguish model-generated episodes from extractive-fallback episodes; the per-episode fallback reason SHALL be persisted, not only logged; the chat total SHALL count chats that actually produced an episode rather than every window visited (windows that commit zero episodes SHALL NOT inflate the chat count); and the latest run SHALL be visible in brain status for every terminal state including interrupted, failed, and budget-exceeded, surviving page reloads and server restarts.

#### Scenario: Extractive fallback is visible in the outcome
- **WHEN** a model run falls back to extractive placeholders for some packs
- **THEN** the completion notice reports the extractive-versus-total episode breakdown and each fallback episode stores its fallback reason

#### Scenario: Empty windows do not inflate the chat count
- **WHEN** a run visits windows that are already covered or produce no episode
- **THEN** the reported chat total reflects only chats that produced at least one episode

#### Scenario: Interrupted run is visible after restart
- **WHEN** a run is interrupted or fails and the server restarts
- **THEN** the brain panel shows the latest run with its terminal status and reason

### Requirement: Runs Finalize On Failure
A run that throws after it has started SHALL be marked terminal immediately rather than left in the running state until a restart heals it. The automatic maintenance pass and the manual run SHALL both finalize their run row (failed or interrupted) when an exception propagates after the run begins, so brain status never reports a phantom active run.

#### Scenario: Exception during the auto pass marks the run
- **WHEN** the automatic pass throws after starting its run (for example a database error inside the drain)
- **THEN** the run row is marked terminal in the same pass and status shows no active run, without waiting for a server restart

### Requirement: Bounded Status Query Cost
Brain status SHALL be servable at UI-poll frequency without a full messages-table scan per request: the status computation SHALL be cached with a short time-to-live invalidated on brain writes, the daily usage summary SHALL be queried via the ledger's day index rather than a timestamp range scan, and committing an episode SHALL return the committed record directly rather than re-listing episodes.

#### Scenario: Status polled during history sync
- **WHEN** archive-updated events drive repeated status refreshes during a live history sync
- **THEN** the underlying coverage scan runs at most once per cache interval and stale status is refreshed immediately after any brain write

#### Scenario: Commit returns without a list scan
- **WHEN** an episode commits
- **THEN** the committed record is returned directly and the daily usage summary is read through the day index

