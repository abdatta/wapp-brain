## Context

Measured on the live archive (327,257 messages, 4,144 chats, 9,400 episodes, 5,721 lifecycle nodes) on 2026-07-27, with a consistent copy served by an isolated server so the live writer was untouched.

**`/api/brain/status` — 2.5s cold, 1.0s warm.** The TTL cache is not the problem: `getBrainStatus()` returns in 0.0ms warm. The route then adds ~620ms of *uncached* work on every request — `getBrainModelQualityAggregates` 276ms, `getBrainResolutionDebt` 179ms, `countRegenerableBrainEpisodes` 87ms, `getBrainMediaGapSummary` 68ms, `getBrainValidationIssueSummary` 9ms. The shell polls this endpoint on every page, so it is the floor for navigating anywhere.

**`/api/brain/lifecycle` — 6.5s over HTTP, 4.2s in-process.** The decisive measurement: `limit: 1` costs **4,164ms** and `limit: 200` costs **4,175ms**. The limit is free. All of the cost is the pre-limit pass that folds events, resolves anchors, and hydrates closure candidates for **all 5,721** nodes in order to produce the count chips, before a single row is dropped. This archive has 0 lifecycle events, so the cost is not event folding — it is the per-node candidate and anchor work.

Two prior lessons bound the solution space. The 15s TTL on `getBrainStatus` exists because a 1s TTL made every UI poll a cache miss and queued every other request seconds deep — caching alone was not enough, and the *cadence* had to change. And the lifecycle sweep already taught the bulk-query-or-wedge lesson once: a surface issuing one query per node dies on the real archive.

## Goals / Non-Goals

**Goals:**
- Navigating to any page costs no more than the data that page actually shows.
- Every endpoint the shell polls answers within a stated budget at real archive scale, and that budget is checked, not hoped for.
- Counts stay full-population and truthful while the page hydrates only what it renders.
- Byte-identical responses: a latency change that alters a number is a bug.

**Non-Goals:**
- Changing what any endpoint means, returns, or how coverage is computed.
- New user-facing surfaces, pagination UX, or data model changes.
- Optimizing endpoints that are already fast (`/api/chats` at 0.10s, `/api/brain/muted` at 0.30s) — this is not a general performance sweep.
- Removing any panel from the brain page; the dashboard aggregates keep their surface, they just stop riding the poll.

## Decisions

1. **Split by cadence, not by cost.** `/api/brain/status` keeps exactly what the shell needs to render its chrome — coverage, backlog sample, tasks, usage, run/scheduler/provider state. The five dashboard aggregates move to `GET /api/brain/quality`, fetched by the brain page alone. Rationale: caching an expensive aggregate on a hot path still pays for it on every miss, and its miss rate is set by the poll interval, not by how often anyone reads it. The honest fix is that a value nobody is looking at should not be computed. Alternative rejected — one endpoint with a longer TTL: it makes the first navigation after any brain mutation pay the full 620ms, which is exactly when the user is watching.

2. **Lifecycle counts move into SQL; hydration stays per-page.** The count chips need a full-population answer, but they do not need 5,721 folded objects to produce it. Counts become set-based aggregate queries; fold/anchor/candidate hydration runs only for the rows the page will actually return. Rationale: this is what makes `limit` mean something — today it is free because everything is computed before it applies. Alternative rejected — cache the whole computation: it would still cost 4.2s on the first load after every transition, and the sweep mutates lifecycle state constantly.

3. **Candidate hydration becomes lazy, not eliminated.** `candidateCount` drives the `sweep_due` chip, so it cannot simply be dropped. It is computed set-based for the counts and hydrated in full only for returned rows. Rationale: keeps the chip honest without paying detail cost for items nobody sees.

4. **Cache the survivors on the existing invalidation signal.** Whatever remains on the poll path rides `invalidateBrainStatusCache`, already called by every brain mutation. Rationale: a second, independently-invalidated cache is how status and backlog drift apart; the codebase already has exactly one brain-mutation signal and it should stay that way.

5. **Index before caching.** Each remaining aggregate is checked with `EXPLAIN QUERY PLAN` first. Where the cost is a missing index (a `SCAN` where a `SEARCH` belongs), add the index; only genuine full-population work gets cached. Rationale: the mute change just demonstrated that a query plan, not the row count, was the difference between 90ms and 626ms — and that measuring variants beats reasoning about them.

6. **Budgets are asserted, not documented.** A test generates a synthetic archive at realistic scale and asserts each poll-path endpoint answers within its budget. Rationale: "cheap indexed counts" was true when written and silently stopped being true; a comment cannot catch that, and this drift was found by accident rather than by the suite. Budgets are set with headroom over measured cost so the test fails on regressions, not on machine variance.

7. **Equivalence is proven by diffing whole responses.** Before/after JSON for every touched endpoint is compared field-by-field on a copy of the live archive. Rationale: the only acceptable outcome is the same numbers, sooner.

## Risks / Trade-offs

- [The brain page makes two requests instead of one] → accepted and correct: they have genuinely different cadences, and the page already issues several parallel reads. The dashboard panels shimmer independently per the loading-state rule.
- [Set-based counts could disagree with the folded ones] → the fold is the definition of an item's status, so the SQL must reproduce it exactly. Guarded by a test asserting counts match the current implementation on a fixture exercising every fold path (open/fulfilled/dismissed, overdue, stale, sweep-due), plus a whole-response diff on real data.
- [A latency test is machine-dependent and could flake] → budgets carry generous headroom over measured cost, and the assertion is on a fixed synthetic archive rather than the user's live one. If it proves flaky it becomes a reported metric with a much looser ceiling rather than being deleted.
- [Splitting the DTO is a client/server contract change] → they ship in lockstep from the same build, and the client renders defensively for the skew window during development.
- [Indexes add write cost on a 327k-row archive] → each candidate index is measured for its effect on import and live-sync insert throughput before being kept; a read win that slows ingestion is not a win.

## Open Questions

None blocking. Whether `/api/status` (1.0s, non-brain) shares a root cause is worth checking during implementation, but it is not in scope unless the fix turns out to be the same index.
