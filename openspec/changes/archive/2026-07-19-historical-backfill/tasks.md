## 1. Backfill run (server)

- [x] 1.1 Wire `startBrainRun({ backfill: true })` as run kind `backfill`: `auditCatchup` producer → `drainBrainTasks` (episode tasks only) with progress, cancel, and named terminal states; `queuedTasks` on `BrainRunProgress`
- [x] 1.2 Per-run pacing overrides `callsPerHour`/`callsPerDay` (clamped) consulted by the drain for this run only; overrides echoed in the start notice and persisted in the run record's totals
- [x] 1.3 Significance floor: sub-threshold chats enqueue at priority 0 so the trivia tail drains last (week-bounded packs already cap their spend)
- [x] 1.4 Strict mode: thread `strict` through run → drain → episode generation so a twice-failed pack commits nothing and fails the task into backoff/retirement (default behavior unchanged)
- [x] 1.5 Concurrency (per H7): SLIDING worker pool over chat tasks in the drain (default 5, clamp 1–6, run option) — settled call refills its slot immediately, no batch barriers, per-claim budget/pacing/cancel checks; serial within chat, serialized codex client connect (mutex), bounded budget-check overshoot, rate-limit backoff without failing the run

## 2. Dashboard (server + client)

- [x] 2.1 `GET /api/brain/backfill/status`: coverage, pending, queue depth, running progress incl. tokens, trailing drain rate, approximate ETA (null under the denominator), per-model ledger spend, fallback canary + sweepable count
- [x] 2.2 Brain-panel backfill strip: live metrics (SSE + run-terminal refresh, loading shimmers), canary warning treatment past 10% after 20 attempts, and a Sweep-fallbacks action starting the extractive-scoped regenerate run
- [x] 2.3 Fallback-rate console warning when a backfill run crosses the threshold mid-run

## 3. Surfaces

- [x] 3.1 Run console Backfill mode: queue/coverage context, rate overrides, existing call/token ceilings, strict toggle; validation matrix extended (overrides need model mode; strict needs backfill; extractive backfill permitted with a zero-calls note)
- [x] 3.2 CLI `brain-backfill [--rate N] [--max-calls N] [--max-tokens N] [--strict] [--extractive]`, HTTP-delegating when the server is up; usage help updated

## 4. Tests

- [x] 4.1 Resume-after-kill: interrupted drain resumes with zero duplicate episodes and monotone coverage; audit re-run enqueues nothing covered
- [x] 4.2 Ordering: newest chat first, oldest window first within chat, significance floor drains last
- [x] 4.3 Pacing: hourly override paces, daily ceiling stops named, token budget still honored; overrides persisted on the run record
- [x] 4.4 Strict mode: no placeholder, no watermark advance, task retires visibly; default mode unchanged; sweep selects the fallbacks
- [x] 4.5 Dashboard DTO: rates/ETA math, canary thresholds and denominators, sweepable count (both repos)
- [x] 4.6 Concurrency: N-worker drain equals serial outcome (episodes/watermarks/citations/graph), overlap actually happens (wall-clock bound), rate-limit path degrades without run failure; sliding refill proven with staggered stub latencies (wall ≈ critical path, not batch sums — a fast slot starts the next task while slow calls run)

## 5. Verification gate (real archive, attended)

- [~] 5.1 🧍 Scoped confidence pass: turbo over ~20–30 chats with Terra, then check the canary (~0% fallback) and run `brain-eval` before opening the throttle — confidence pass + canary DONE (2026-07-18/19 scoped Terra & Sonnet passes; canary live on the dashboard); formal `brain-eval` on the new episodes deferred to the quality-follow-up bucket
- [x] 5.2 Kill the server mid-turbo, restart, re-start backfill: resumes clean, no duplicates, dashboard shows coverage climbing with honest ETA
- [x] 5.3 🧍 A budget stop (calls or tokens) ends the run as named budget_exceeded with remaining work pending; overrides visible on the run record — witnessed live 2026-07-19 (overnight hourly-cap stop, per-run call-ceiling stops, and the provider-limit guard stop; overrides visible on the run record's totals)
- [x] 5.4 Fallback sweep: after a stretch with any extractive episodes, one click regenerates them; dashboard's sweepable count returns to zero

## 6. Post-first-run hardening (surfaced by the 2026-07-19 overnight run)

The first real overnight backfill (codex/Terra) ran clean for 2.5h, then hit the ChatGPT-Plus usage limit; with no mid-run health check the drain turned the remaining ~5,600-pack queue into free extractive placeholders in 4 minutes ("94% covered", 64.5% placeholder). These fixes closed that gap and enabled the claude-sonnet-5 fallback so the drain could continue on a second provider.

- [x] 6.1 Mid-run provider-degradation guard: `drainBrainTasks` and the manual/regenerate loops check provider health per-claim and STOP as a named `interrupted` (resumable) the moment it latches degraded — overshoot ≤ pool width, never a placeholder flood. Guard regression test + spec scenario added.
- [x] 6.2 Turbo fallback sweep: the regenerate/sweep path now runs the sliding worker pool (default 5), no-hourly-cap-when-unset, with live per-episode progress — the Sweep button drains thousands of placeholders at full tilt and stops cleanly on the guard. (routes + client + CLI parity)
- [x] 6.3 Sonnet (claude-cli) enablement: `--max-turns 1 → 8` (agentic tool-detours were erroring `error_max_turns` → ~40% fallback on large packs; now ~0%) and `parseContractDate` accepts `YYYY-MM` (→ month-start) so month-granularity `event_at` no longer drops to fallback. Concurrency 5 verified safe for the WSL-per-call path (12/12, zero stdin-relay drops). Tests added.
