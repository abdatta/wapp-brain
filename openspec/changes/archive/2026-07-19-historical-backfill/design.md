## Context

Every prerequisite is archived: the contract is final (`episode-contract-v2`), identity repair is deterministic (`identity-late-resolution`), model choice is evidence-based (`brain-eval-harness`: **Terra**, 0% fallback on this archive), and the three capture-before-spend changes (#20/#21/#22) landed, so episodes are born complete. The substrate already does most of the work: `auditCatchup` enqueues one watermark-keyed idempotent `episode` task per uncovered chat (newest-first priority via `newestVisibleMs`), `drainBrainTasks` paces claims against the hourly/daily ledger with cancel hooks and poison-task retirement, `buildEvidencePacks` is oldest-first-from-watermark with week-bounded span caps, the run console (brain-run-console) owns validated budgets including the per-run token budget, and `brain_runs` declares the `backfill` kind with no producer. What is missing is the backfill run itself: a producer+drain wired as a first-class run with turbo pacing, a coverage/spend/quality dashboard, and the user's no-silent-degradation requirement made structural.

Scale reality: ~308k pending messages across 645 chats ≈ 3–4k packs. At the config default (30 calls/hour) that is months of background drain; with the quota weekend it is an attended day. Both modes must be the same machinery.

## Goals / Non-Goals

**Goals:**
- A `backfill` run kind: produce the full uncovered work-list, drain it resumably at a user-set pace, finish or stop in a named state with honest totals.
- Turbo pacing as explicit per-run overrides (calls/hour, calls/day ceiling, token budget) — bounded, visible, never a silent config edit.
- Ordering per resolved D12: chat-level newest-first, within-chat oldest-first from the watermark; low-significance chats sink to the tail and assimilate as week-bounded mini-episodes.
- A backfill dashboard: coverage %, queue depth, drain rate, ETA at current pace, per-model spend, and the extractive-fallback rate as a prominent canary.
- No silent extractive degradation: loud fallback accounting, a first-class post-backfill sweep of fallbacks, and an opt-in strict mode that refuses to advance coverage over placeholders.
- Kill-resume clean by construction (queue + watermarks), verified.

**Non-Goals:**
- No new queue/watermark/run machinery (consumes `brain_tasks`, cursors, ledger, run objects as-is).
- No scheduler behavior change: auto mode keeps its existing nightly/volume semantics; backfill is user-triggered (manual-first).
- No new schema beyond nothing-at-all (payload fields ride existing JSON columns).
- No model-choice logic: the run uses the console's provider/model selection (Terra decided; not hard-coded).

## Decisions

### H1. The backfill run reuses the audit producer and the task drain — one code path

`startBrainRun({ backfill: true, ... })` runs kind `backfill`: first `auditCatchup` (idempotent, watermark-keyed dedupe — a re-run enqueues only genuinely new windows), then `drainBrainTasks` restricted to `episode` tasks with the run's pacing, progress hooks, and cancel wired. *Why*: the catch-up audit IS the historical producer (all coverage starts from watermark zero); a bespoke backfill enumerator would be a second source of coverage truth. A backfill task failing follows the existing backoff/retirement path; a killed process leaves claimed tasks to the stale-claim reclaim. Resume = start another backfill run: the audit no-ops on covered chats and the drain continues from the queue.

### H2. Turbo pacing = per-run ledger overrides, named and bounded

`BrainRunRequest` gains `callsPerHour?` and `callsPerDay?` overrides (clamped: 1–1000/hour, 1–10000/day) consulted by the drain's pacing checks for THIS run only. An absent hourly override imposes NO hourly ceiling on a backfill (the config 30/hour is the auto scheduler's spread-across-the-day pace and would pointlessly stop a turbo drain in minutes — an overnight run leaves the field blank and is bounded by the daily cap, the queue, and the worker pool); an absent daily override falls back to the configured daily cap as the budget guard. The run record stores the overrides in `totals_json` so honesty survives restarts. The existing `maxModelCalls` and `maxTokens` (brain-run-console) remain the per-run ceilings. *Why overrides over env edits*: the quota weekend must not require editing config that silently persists into next week; a run's spend posture should be readable off its own record. Budget stops stay NAMED (`budget_exceeded` with hourly/daily/calls/tokens in the message); provider health degradation still halts model calls via the existing health contract.

### H3. Ordering and significance folding via priority, not new mechanics

Chat priority stays `newestVisibleMs`-derived (newest chat first). Chats with `pendingVisibleMessages < significanceMin` enqueue at a floor priority (0) so the long tail of trivia drains last; their packs are already week-bounded by the span cap, which IS the weekly mini-episode (per-chat packs cannot fold across chats). *Why*: D12's ordering promise is a priority policy over the existing queue; inventing interval bookkeeping would break the scalar watermark's honesty.

### H4. Dashboard: one status DTO, server-computed

`GET /api/brain/backfill/status` → `{ coveragePercent, pendingMessages, pendingChats, queuedTasks, running (run id/kind/progress incl. tokensUsed), drainRatePerHour, etaHours, spendByModel (ledger, all-time and today), fallback: { totalEpisodes, extractiveEpisodes, ratePercent, currentRunExtractive }, sweepableExtractive }`. Drain rate = episodes committed over the trailing 60 minutes from `brain_episodes.created_at`; ETA = estimated remaining packs (`pendingMessages / avg pack size observed so far`, honest "≈") over the current rate; both null when idle. UI: a backfill strip on the Brain panel (metrics + the canary given warning treatment above a threshold) plus a **Sweep fallbacks** button that starts the existing regenerate run scoped to `generator='extractive'`. All meaning server-side (downstream-consumer principle); the strip subscribes to the same SSE/run-terminal refresh as the graph strip.

### H5. No-silent-fallback, structurally

Three layers, per the checkpoint feedback: (1) **Loud** — the canary on the dashboard, the run completion notice already reporting `N/M extractive` (run-honesty requirement), and a console warning when a backfill run's fallback rate crosses 10%. (2) **Recoverable** — `sweepableExtractive` + the one-click sweep make "coverage with placeholders" visibly different from "done". (3) **Preventable** — opt-in `strict` mode: when a pack's model generation fails twice, the task is failed WITH retry (backoff, then retirement to `failed` — visible in the task summary) and NO extractive episode is committed, so the watermark never advances over a placeholder; coverage honestly stalls instead of silently degrading. Default stays non-strict (coverage-never-blocks), matching the contract's philosophy; strict is the attended-turbo posture.

**(4) Provider-health halt (added 2026-07-19 after the first real overnight run).** The three layers above assumed a *per-pack* failure, but the overnight run exposed a *provider-wide* failure mode they missed: at 12:52 UTC codex hit its ChatGPT-Plus usage limit, the health tracker latched degraded, and — because the drain had no mid-run health check — it kept claiming tasks and turned the entire remaining ~5,600-pack queue into free extractive placeholders in **four minutes** (degraded calls are refused, not billed, so they commit as fast as the CPU writes them). The result read as "94% covered" but was 64.5% placeholder. Fix: the drain's per-claim stop gate now checks `getBrainProviderStatus().degraded` FIRST (before budgets), so a latched provider halts new claims after at most a worker-pool's worth of overshoot; the run ends `interrupted` with a message naming the provider cause and the remaining queue pending. The same guard is mirrored in the manual and regenerate run loops. This is prevention where strict mode is not enough: strict refuses *quality* fallbacks per pack, but only the health halt stops the *outage* flood — and it does so in the default (non-strict) posture the overnight run actually used.

### H6. Run console gains a Backfill mode; CLI gets `brain-backfill`

The console's mode row becomes Assimilate / Backfill / Regenerate. Backfill mode: shows queue/coverage context, exposes rate overrides (calls/hour, calls/day), the existing call/token ceilings, and the strict toggle; validation matrix extends (overrides require model mode; strict requires backfill; extractive backfill allowed but pointless — permitted with a note, zero calls). CLI `brain-backfill [--rate N] [--max-calls N] [--max-tokens N] [--strict] [--extractive]` mirrors it for long attended sessions (delegates over HTTP when the server is up, same as `brain-graph`), because a weekend turbo session should survive a closed browser tab.

### H7. Concurrent generation: chat-level worker pool, verified safe (2026-07-18 spikes 1–3)

> Spike 2 (live, 5 lanes, real pack sizes): 15/15 Terra calls with ~6.8k-token synthetic-conversation prompts — zero cross-talk, zero rate-limit errors, real usage on every call, 4.11× speedup, and every slot-refill gap measured **0ms** (sliding refill is literal). Spike 3 (SQLite, 20 chats through the 5-lane pool into one repository): 4.54× speedup, exactly one episode per chat with isolated citations, all watermarks advanced, graph rebuild-equals-incremental held, and the event loop's worst stall was **89ms** (p99 46ms) under a commit density ~50× heavier than a real run produces — better-sqlite3 cannot contend across async flows (one connection, synchronous serialization); convoy risk is measured negligible.

Turbo MAY run N generation workers where each worker owns ONE whole chat task at a time — parallel across chats, always serial within a chat (preserving oldest-first watermark honesty and episode-continuity prompts). Verified live and on fixture before this was pinned: (1) codex probe — 7/7 concurrent Terra calls, zero response cross-talk (nonce echo), real usage objects, near-linear ×4 speedup, no rate-limit errors (the adapter constructs a fresh stateless client per call, `store:false`); (2) fixture — four chats generated concurrently against one SQLite repository with genuine overlap: per-chat episodes/citations/watermarks isolated, graph correct, rebuild-equals-incremental holds (better-sqlite3's synchronous transactions serialize commits by construction). Defaults: concurrency 5, clamp 1–6, exposed as a turbo option. The pool is SLIDING, never batched: an in-flight set is refilled the moment any call settles (Promise.race-style slot refill), so a finished call immediately claims the next due task — no barrier ever waits for a full batch of five, and all five lanes stay saturated until the queue drains. Budget, pacing, and cancel checks run before EACH claim (per-slot, not per-batch). Guards: client CONNECT serialized behind a small in-process mutex (two in-flight token refreshes racing the session file is the one shared-state hazard; warmup + serialization removes it); budget/pacing checks accept a bounded overshoot of at most workers−1 calls (documented, counted by the ledger); a provider rate-limit error backs the task off through the normal retry path and drops effective concurrency rather than failing the run. At concurrency 5 the ~24–38h serial estimate compresses to roughly 5–8h — an overnight run.

### H8. Progress and interruption surfaces

`BrainRunProgress` gains `queuedTasks` (refreshed per task completion). Kill-resume needs no new code (H1) but gets an explicit test and a verification-gate drill: kill the server mid-turbo, restart, re-start backfill, assert zero duplicate episodes (dedupe keys + watermark clamp already guarantee it) and monotone coverage.

> Drill lesson (2026-07-18, live kill mid-turbo): the cross-process brain lock was the one thing that DID need new code — a killed run left it held for the 30-minute TTL, blocking its own resume. Fixed structurally: the backfill lock is keyed by the RUN id and boot-time run reconciliation (which proves the holder dead when it marks the run interrupted) releases it in the same transaction; a per-pack heartbeat keeps it alive through long chats. The drill then passed end-to-end: zero duplicate windows, honest `interrupted` run row, orphaned claims reclaimed at the next start.

## Risks / Trade-offs

- **[Long-running turbo wedging the live server]** → the drain already yields between packs and tasks; turbo sessions SHOULD run with live sync paused for the heaviest stretches (documented in the runbook line on the dashboard); the wedge-hazard lesson stays encoded as pacing + yields, not hope.
- **[ETA lies early in a run]** → ETA derives from observed pack size and trailing rate, labelled approximate, null under 10 committed episodes.
- **[Strict mode stalling coverage on a poison chat]** → strict failures follow the existing backoff/retirement path and surface in the task summary; the dashboard shows failed-task count; switching strict off and re-running sweeps the remainder.
- **[Override misuse burning quota]** → overrides are per-run, clamped, echoed in the start notice and run record; the daily ledger still records every call.
- **[Fallback-rate canary noise at tiny denominators]** → the warning threshold applies only after 20 attempted model episodes in the run.

## Migration Plan

1. Pure addition: producer wiring, run kind, routes, UI strip, CLI. No schema, no `EXTRACTION_VERSION` change (no evidence-rendering change).
2. First real use is itself gated by the user (manual-first): start a scoped confidence pass (~20–30 chats), check the canary + `brain-eval`, then open the throttle.
3. Rollback: don't start backfill runs; nothing else consumes the new surfaces.

## Open Questions

- Should the volume/nightly auto pass ever drain backfill-priority tasks when auto mode is on? Leaning no for now — backfill stays user-paced until the drain has weeks of quality history.
- Dashboard placement once `graph-explorer` lands (a coverage view may want to live beside the graph) — defer to #23's layout pass.
