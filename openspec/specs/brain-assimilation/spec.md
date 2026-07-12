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
The brain SHALL track per-chat assimilation watermarks that advance only when an episode commits, and SHALL derive all coverage decisions (what to assimilate next, what coverage to report) from watermarks rather than from schedule execution.

#### Scenario: Crash before commit
- **WHEN** a run is interrupted after generation but before an episode commits
- **THEN** the chat's watermark is unchanged and the next run re-covers the same window idempotently

#### Scenario: Coverage reported from watermarks
- **WHEN** brain status is requested
- **THEN** it reports assimilated-through timestamps and pending counts per chat derived from watermarks

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
Evidence packs SHALL contain only conversation messages per the visible-exchange definition, rendered in resolved identity text with interpretation labels for non-text content, bounded in size, and split at long silence gaps; system, reaction, and encrypted-update rows SHALL never consume model budget.

#### Scenario: Noise excluded from evidence
- **WHEN** a window contains system events and reactions alongside conversation
- **THEN** only conversation messages enter the evidence pack while reactions still appear as annotations on their target messages

#### Scenario: Oversized window split
- **WHEN** a chat window exceeds the evidence size bound
- **THEN** it is split into sequenced packs at silence gaps and each pack is processed as its own task

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
The brain SHALL record every model call's purpose and token usage in a daily ledger and SHALL enforce configurable daily call and token caps as a hard named block state, never silent degradation; budget-skipped work SHALL be reported in run summaries.

#### Scenario: Budget exhausted
- **WHEN** the daily cap is reached mid-run
- **THEN** remaining tasks stay pending, the run reports a budget-exceeded state, and work resumes when budget is available

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

