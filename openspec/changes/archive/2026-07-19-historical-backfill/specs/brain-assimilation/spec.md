# brain-assimilation — historical-backfill delta

## MODIFIED Requirements

### Requirement: Offline Catch-Up
Assimilation correctness SHALL NOT depend on schedules firing: on startup the brain SHALL audit watermarks against archive contents, enqueue tasks for all uncovered windows, and drain them rate-limited under the daily budget with visible progress. The same audit-and-drain machinery SHALL serve historical backfill as a first-class user-triggered run kind: a backfill run SHALL produce the full uncovered work-list through the idempotent watermark-keyed audit and drain it as episode tasks under the run's pacing, so that re-running after any interruption enqueues only genuinely new windows and continues from the queue with no duplicated episodes. Chat-level ordering SHALL be newest-first; within-chat assimilation SHALL always be oldest-first from the watermark cursor. Chats below the significance threshold SHALL drain last at floor priority and SHALL assimilate as week-bounded packs rather than burning per-day calls.

#### Scenario: Two weeks offline
- **WHEN** the server starts after two weeks off
- **THEN** uncovered windows are enqueued and drained at the configured rate without blocking live sync or exceeding budgets

#### Scenario: Catch-up is resumable
- **WHEN** a catch-up drain is interrupted at any point
- **THEN** restarting continues from the queue with no duplicated episodes

#### Scenario: Backfill kill-resume is clean
- **WHEN** the server is killed mid-backfill and restarted and a new backfill run is started
- **THEN** the audit enqueues nothing for already-covered windows, the drain continues from pending tasks, no duplicate episodes are committed, and coverage only moves forward

#### Scenario: Ordering follows resolved D12
- **WHEN** a backfill run drains a queue containing recently-active and long-quiet chats
- **THEN** recently-active chats' windows are claimed first, each chat's own windows are assimilated oldest-first from its watermark, and sub-significance chats drain last as week-bounded packs

## ADDED Requirements

### Requirement: Backfill Run Pacing Overrides
A backfill run MAY carry explicit per-run pacing overrides — calls per hour and calls per day — clamped to sane bounds and applying to that run only. An ABSENT hourly override SHALL impose NO hourly ceiling on a backfill (the configured hourly pace is the auto scheduler's spread-across-the-day concept and MUST NOT throttle a user-initiated turbo drain); the run is then bounded only by the daily ceiling, the worker pool, and the remaining queue. An absent daily override SHALL fall back to the configured daily cap, which remains the run's budget guard. The overrides SHALL be echoed in the run start notice and persisted on the run record so a run's spend posture is readable after the fact. Reaching any budget — an explicit hourly pace, the daily ceiling, the per-run call ceiling, or the per-run token budget — SHALL end the run as a named budget-exceeded state whose message names the exhausted budget, with remaining work left pending and committed coverage kept.

#### Scenario: An unset hourly override imposes no hourly ceiling
- **WHEN** a backfill run starts with no calls-per-hour override
- **THEN** the run drains at the full pool rate without an hourly stop, limited only by the daily ceiling, the queue, and the worker count — the configured hourly pace does not apply

#### Scenario: Turbo override paces one run only
- **WHEN** a backfill run starts with an explicit calls-per-hour override
- **THEN** that run throttles to the override pace, the override is visible on the run record, and reaching it ends the run as a named budget stop while the next run without an override has no hourly ceiling

#### Scenario: Budget stops are named
- **WHEN** a backfill run reaches its daily ceiling, per-run call ceiling, or token budget
- **THEN** the run ends budget-exceeded with a message naming which budget was reached, and remaining tasks stay pending for the next run

#### Scenario: A mid-run provider outage halts the run, not coverage quality
- **WHEN** the model provider becomes unavailable mid-run (usage limit, outage, or auth) and its health tracker latches degraded
- **THEN** the drain SHALL stop claiming new work rather than commit extractive placeholders across the remaining queue — at most a worker-pool's worth of packs fall back before the halt — and the run SHALL end in a named, resumable state whose message identifies the provider cause, with the remaining queue left pending so a resume after recovery (or a provider switch) continues cleanly

### Requirement: Backfill Dashboard And Fallback Canary
The brain SHALL expose a server-computed backfill status: coverage percentage, pending messages and chats, queued task depth, the running backfill's progress including tokens used, trailing drain rate, an approximate ETA at the current pace (absent until enough episodes ground it), per-model spend from the ledger, and the extractive-fallback rate as a prominent quality canary alongside the count of sweepable extractive episodes. The dashboard surface SHALL refresh live with run progress and archive changes. A backfill run whose fallback rate crosses the warning threshold after a minimum attempted-episode denominator SHALL surface a visible warning, never only a log line.

#### Scenario: Dashboard reflects a draining run
- **WHEN** a backfill run is draining
- **THEN** the dashboard shows coverage climbing, queue depth falling, the trailing drain rate, an approximate ETA, and per-model spend without a page reload

#### Scenario: Fallback spike is loud
- **WHEN** a backfill run's extractive-fallback rate crosses the warning threshold after the minimum denominator
- **THEN** a visible warning surfaces on the run surface and dashboard, distinct from the ordinary completion notice

#### Scenario: Sweepable placeholders are one action away
- **WHEN** committed backfill coverage includes extractive placeholder episodes
- **THEN** the dashboard shows their count and offers a sweep that starts the regeneration path scoped to extractive episodes

### Requirement: Concurrent Backfill Generation
Turbo backfill MAY run a bounded pool of generation workers (default 5, clamped 1–6) where each worker owns one whole chat task at a time: parallelism SHALL exist only ACROSS chats, and each chat's windows SHALL remain strictly serial oldest-first from its watermark. The pool SHALL be sliding, never batched: the moment any in-flight call settles, its slot SHALL immediately claim the next due task, with budget, pacing, and cancellation checked before each claim — the drain SHALL NOT barrier-wait for a full batch to finish before starting new work. Provider client connection SHALL be serialized so concurrent token refreshes cannot race the session store. Budget and pacing checks MAY overshoot by at most workers-minus-one calls, every one recorded in the ledger. A provider rate-limit failure SHALL back the affected task off through the normal retry path rather than failing the run.

#### Scenario: Workers parallelize across chats only
- **WHEN** a turbo run executes with five workers over many pending chats
- **THEN** at most five chats generate simultaneously, each chat's own windows commit in oldest-first order, and per-chat watermarks, citations, and continuity are identical to a serial run's

#### Scenario: A freed slot claims the next task immediately
- **WHEN** one of five in-flight generations finishes while the others are still running
- **THEN** the freed slot claims and starts the next due task without waiting for the remaining in-flight calls, keeping five generations in flight whenever the queue and budgets allow

#### Scenario: Concurrency degrades, never corrupts
- **WHEN** the provider rate-limits or a worker's call fails mid-pool
- **THEN** that task backs off and retries under the existing attempt cap while other workers continue, and the run's terminal state reports honest totals

### Requirement: Strict Backfill Mode
Backfill SHALL offer an opt-in strict mode in which a pack whose model generation fails after the single retry commits NO extractive placeholder and does NOT advance the watermark: the task fails into the existing backoff-and-retirement path and remains visible as failed work. In strict mode, coverage counts only model-generated episodes; the default mode keeps the extractive fallback so coverage never blocks on model quality. Strict mode SHALL NOT change validation, retry, or fallback behavior for non-backfill runs.

#### Scenario: Strict mode refuses placeholder coverage
- **WHEN** a strict backfill run's pack fails model generation twice
- **THEN** no episode is committed for that pack, the chat's watermark is unchanged, the task backs off and eventually retires as failed, and the failure is visible in the task summary

#### Scenario: Default mode keeps coverage honest instead
- **WHEN** the same double failure happens in a default (non-strict) backfill run
- **THEN** the extractive fallback commits with its fallback reason and attempted model recorded, coverage advances, and the episode is selectable by the regeneration sweep
