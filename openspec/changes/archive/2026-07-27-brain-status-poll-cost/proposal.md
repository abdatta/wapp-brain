## Why

Every brain surface feels slow, and it is not the surface's fault. Measured against the live 327k-message archive on 2026-07-27:

| endpoint | cold | warm |
|---|---|---|
| `/api/brain/status` | **2.5s** | **1.0s** |
| `/api/brain/lifecycle` | **6.5s** | — |
| `/api/status` | 1.0s | — |
| `/api/brain/muted` | 0.30s | — |
| `/api/chats` | 0.10s | — |

`/api/brain/status` is polled by the app shell on **every** page, so its cost is the floor for navigating anywhere in the app. Its TTL cache already works perfectly — `getBrainStatus()` itself returns in **0.0ms** warm — but the route then recomputes five aggregates *outside* the cache on every single request:

```
getBrainModelQualityAggregates   276ms
getBrainResolutionDebt           179ms
countRegenerableBrainEpisodes     87ms
getBrainMediaGapSummary           68ms
getBrainValidationIssueSummary     9ms
                                 ─────
                                 ~620ms per poll, never cached
```

The route's own comment calls these "cheap indexed counts". That was true when it was written; at 327k messages, 9.4k episodes and 2.2k open commitments it no longer is. Nothing here is a regression from a recent change — `mute-chats-from-brain` measured `getBrainStatus` 3% *faster* than its baseline — this is accumulated drift that has never been measured end-to-end.

The deeper problem is structural, and it is why this is worth a change rather than a patch: **one endpoint conflates a hot poll with a cold dashboard.** Coverage, task counts and run state are polled every few seconds and must be fast. Model-quality rollups, resolution debt, regenerable counts, media-gap demand and validation issues are dashboard panels a user reads occasionally — they do not belong on the poll path at all, and no amount of caching makes that conflation correct.

## What Changes

- **Split the hot poll from the cold dashboard.** `/api/brain/status` keeps only what the shell polls: coverage, backlog sample, tasks, usage, run state, scheduler, provider. The five dashboard aggregates move to a separate endpoint the brain page requests on its own cadence, so navigating to `/chats` or `/search` stops paying for them.
- **Every remaining aggregate is measured and given an explicit budget.** A route on the poll path that cannot answer within its budget on the real archive is a defect, not a fact of life — the change establishes the budget as a checked property rather than an aspiration.
- **Cache what stays, on the same invalidation signal that already exists.** The pieces that remain are folded inside the existing TTL cache (or given their own), invalidated by `invalidateBrainStatusCache` so run progress and resets stay immediate — the discipline `getBrainStatus` already follows.
- **Index the queries that deserve it.** Each of the five was profiled; where the cost is a missing index rather than genuine work, add the index instead of caching a slow query.
- **`/api/brain/lifecycle` at 6.5s gets the same treatment.** It is the slowest endpoint in the app and the commitments page's only data source. Its cost is per-item candidate hydration over 2.2k open items; the fix is bulk-first, with the counts and the page separable.
- **A regression guard.** A test asserts the poll-path endpoints stay within budget against a generated archive of realistic scale, so the next accumulation of "cheap counts" is caught by the suite rather than by feel.

Explicit non-goals: no change to what any endpoint *means* or returns as data, no new user-facing surface, and no change to coverage/backlog arithmetic. This is latency only — every number stays exactly as truthful as it is today.

## Capabilities

### New Capabilities
- `brain-read-performance`: the poll-path/dashboard split, per-endpoint latency budgets on the real archive, the caching and invalidation discipline for derived read aggregates, and the regression guard that keeps them honest.

### Modified Capabilities
- `brain-assimilation`: "Non-Blocking Operation" — the existing requirement covers brain *work* (runs, batches, event-loop yields) but says nothing about the cost of brain *reads*. It gains the rule that endpoints on the UI poll path answer within a stated budget at archive scale, and that expensive derived aggregates belong off the poll path.

## Impact

- **Routes**: `/api/brain/status` (narrowed), a new dashboard-aggregates route, `/api/brain/lifecycle` (bulk-first); client wrappers in `api.ts` and the fetch cadence in `BrainPage.tsx` / `CommitmentsPage.tsx`.
- **Repository**: `getBrainModelQualityAggregates`, `getBrainResolutionDebt`, `countRegenerableBrainEpisodes`, `getBrainMediaGapSummary`, `getBrainValidationIssueSummary`, `listBrainLifecycleItems` + `bulkLifecycleCandidatesTx` in `sqliteRepository.ts`, mirrored in `memoryRepository.ts`.
- **Schema**: indexes only — additive, no table or column changes, no wipe.
- **Sequencing**: independent of the roadmap chain; worth landing **before** `brain-retrieval-pipeline` (#12) and `mcp-agent-surface` (#13), which add more read surfaces over the same tables and would inherit the split rather than retrofit it.
- **Risk**: low. Behaviour-preserving by construction — the same DTOs, the same numbers, verified by comparing full responses before and after.
