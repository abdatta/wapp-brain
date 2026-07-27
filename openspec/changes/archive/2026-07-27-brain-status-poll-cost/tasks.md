## 1. Measure first, and lock the baseline

- [x] 1.1 Capture a consistent copy of the live archive (SQLite backup API, never the live file) and record baseline latency for `/api/brain/status`, `/api/brain/lifecycle`, `/api/status`, `/api/brain/quality` precursors, cold and warm, as the numbers every later task is judged against
- [x] 1.2 Snapshot full JSON responses for every endpoint this change touches — the equivalence oracle for task 5.1
- [x] 1.3 `EXPLAIN QUERY PLAN` each of the five status aggregates plus the lifecycle count pass; record which are index-starved (a `SCAN` where a `SEARCH` belongs) versus genuinely full-population, so task 4 fixes causes rather than symptoms

## 2. Split the hot poll from the cold dashboard

- [x] 2.1 Narrow `/api/brain/status` to the shell's payload: coverage, backlog sample, tasks, usage, run/scheduler/provider state
- [x] 2.2 Add `GET /api/brain/quality` returning the five moved aggregates (model quality, resolution debt, regenerable count, media gaps, validation issues) + client wrapper in `api.ts`
- [x] 2.3 `BrainPage` fetches quality separately on its own cadence; each panel shimmers independently per the AGENTS.md loading-state rule and a slow panel never delays the rest of the page
- [x] 2.4 Confirm no other surface depended on the moved fields (grep every consumer of the status DTO, including the CLI and any doc/overview renderer)

## 3. Make `limit` mean something on the lifecycle list

- [x] 3.1 Replace the fold-everything count pass with set-based aggregate queries for open/overdue/stale/fulfilled/dismissed/sweep-due, keeping full-population semantics
- [x] 3.2 Hydrate fold, anchors, and candidates only for the rows actually returned; keep group facets full-population
- [x] 3.3 Test that set-based counts match the per-item fold exactly across every status and flag combination, on a fixture exercising each fold path (including orphaned events and undated items)
- [x] 3.4 Prove the limit now costs something: assert a one-row request is materially cheaper than a full page (today both cost ~4.2s)

## 4. Index and cache what remains

- [x] 4.1 Add the indexes task 1.3 identified as genuine plan wins; measure each one's effect on import and live-sync insert throughput and drop any that materially slows ingestion
- [x] 4.2 Fold any still-expensive poll-path survivor into the existing TTL cache, invalidated by `invalidateBrainStatusCache` — no second, independently-invalidated cache
- [x] 4.3 Mirror every changed read in `memoryRepository.ts` so the two repositories cannot drift

## 5. Verification

- [x] 5.1 Diff the task 1.2 snapshots field-by-field against the new responses on the same archive copy — identical numbers, or the change is wrong
- [x] 5.2 Latency regression guard: generate a synthetic archive at realistic scale and assert each poll-path endpoint answers within its budget, with headroom over measured cost so it fails on regressions and not on machine variance
- [x] 5.3 `npm test`, `npm run doctor`, `npm run build` green
- [x] 5.4 🧍 Re-measure against the real archive on the isolated-port pattern (`WAPP_WORK_DIR` + `APP_PORT`, copy of the live DB, live writer untouched) and record before/after in this file; verify in the browser that the brain page renders with independent panel shimmers, zero console errors, and no unexpected requests

---

## Measured results (2026-07-27)

All numbers on a **consistent copy of the live archive** (327,257 messages / 4,144 chats / 18,287 episodes /
5,721 lifecycle nodes) taken with SQLite's backup API, served by isolated servers on ports 3620–3622
(`WAPP_WORK_DIR` + `APP_PORT`). The live writer on 3600 was never touched.

### Over HTTP, warm

| endpoint | before | after |
|---|---|---|
| `/api/brain/status` — **the poll path** | 923ms | **8–14ms** |
| `/api/brain/quality` — new, brain page only | — | 420–538ms |
| `/api/brain/lifecycle?limit=200` | ~3,009ms | **929–976ms** |

### In-process, median of 3, before/after run back-to-back in one process on one DB copy

`getBrainStatus` is the control: this change does not touch it, and it moved 533 → 572ms (≈7% run variance).

| operation | before | after |
|---|---|---|
| `getBrainStatus` (uncached) | 533ms | 572ms — *control, unchanged* |
| `getBrainStatus` (TTL hit) | 0ms | 0ms |
| the five aggregates, **paid on every poll** | **583ms** | **0ms** — moved off the poll path |
| lifecycle `limit=1` | 2,837ms | **991ms** |
| lifecycle `limit=200` | 3,032ms | **1,102ms** |
| lifecycle `limit=500` | 3,666ms | **972ms** |
| lifecycle `flag=sweep_due` | 3,510ms | **891ms** |
| lifecycle `sort=evidence_desc` | 3,094ms | **1,513ms** |

### What the cost actually was

- **The poll path.** `getBrainStatus()` was already cached and returned in 0ms warm; the route then added
  **583ms of uncached aggregates to every single request**. Moving them is the whole win — there was no
  caching fix available, because the miss rate was set by the poll interval, not by anyone reading them.
- **A query-plan regression, found by benchmark.** The closure-candidate reaction query drove from
  `live_message_updates` on `applied = 1` (44,623 of 44,651 rows) once per id-batch: 137ms × 11 batches.
  Pinning `INDEXED BY` on **both** sides restores `SEARCH c (claim_id=?) → SEARCH lmu (source_message_key=?)`
  against the partial reaction index that already existed for it: **137ms → 7ms** per batch, same 1,065 rows.
  Pinning only the citations side is far worse (**20s**) — the half-measure keeps the bad drive order.
- **The sweep_due chip never needed most of its work.** It is
  `candidateCount > 0 || duePassedSinceReview`, and the right-hand side is decided by the fold and the due
  date already in hand: on this archive that settles **5,022 of 5,721** open nodes for free, leaving 699 to
  query — and the cheap producers settle most of those before the expensive one runs.
- **Per-row detail followed the population, not the page.** Claim texts were an N+1 over everything in
  scope (5,673 point reads to render 200). Now one keyed batch for the page.

### Task 1.3 — index-starved versus genuinely full-population

| query | verdict | action |
|---|---|---|
| candidate reactions | **plan regression** — drove from the wrong table | `INDEXED BY` both sides (above) |
| recent-claims pool | genuine full-population work; forcing `idx_brain_episodes_chat` made it *worse* (270 → 457ms) | no index; stopped selecting `c.text` for 21,734 rows it discards |
| coverage / backlog (`getBrainStatus`) | genuine — a full count over 327k messages | left inside the existing 15s TTL cache |
| validation issues (41ms), media gaps (40ms), regenerable (54ms) | already indexed and cheap | moved off the poll path, not indexed |

**No index was added**, so task 4.1's write-throughput check has nothing to weigh: the one plan defect was
fixed with hints against indexes the schema already carried. Task 4.2 likewise found no survivor needing new
caching — `getBrainStatus` is the only poll-path read left and it already rides `invalidateBrainStatusCache`
(which, verified, fires on chat upsert only when a *new* channel appears, so the TTL genuinely holds during
live sync). Task 4.3 has nothing to mirror: the repository interface and every read's semantics are
unchanged — the changes are plan hints and work-scoping inside the SQLite implementation — and
`tests/brain-read-performance.test.ts` runs its correctness assertions against **both** repositories so they
cannot drift.

### Equivalence (task 5.1)

**35 responses** compared field-by-field between the before-code and after-code servers, hit at the same
instant on byte-identical copies — including **29 lifecycle cases** covering every status, flag, hide,
`dueUpcoming`, kind, muted, sort and limit combination. **All 34 brain/lifecycle responses identical.** The
only two differences were harness artifacts: `memory.rootDir` (the two servers have different work dirs) and
`live.session.updatedAt` (each reconciled stale live state at its own boot).

### Limit sensitivity (task 3.4) — stated precisely

Measured deterministically by counting rows materialized by every SQLite statement, on a generated
250-node archive:

| | `limit=1` | full page | delta |
|---|---|---|---|
| before | 1,506 rows | 1,506 rows | **0 — the limit was free** |
| after | 1,642 rows | 2,182 rows | **540** |

Honest caveat: in **wall clock** the one-row request is ~10% cheaper than the default page (991ms vs
1,102ms), not dramatically so. The limit-dependent work is now genuinely proportional to rows returned, but
the remaining floor is the full-population count pass, which the contract requires — the chips must describe
the whole population no matter how few rows are shown. The large win is absolute, not differential:
every lifecycle request got ~3× faster.

### Browser (task 5.4)

Verified through `javascript_tool` against the built app on the isolated server (screenshot/click tools time
out in this repo regardless of load):

- **Independent shimmer**: with `/api/brain/quality` held for 5s, the four shell metrics (Coverage, Backlog
  chats, Pending msgs, Calls today) render immediately with real values while Quality flags / Media gaps /
  Unresolved people shimmer on their own clock, plus a line skeleton for the detail hint. They resolve to
  11,532 / 4,640 / 781 when the request lands. No panel waits for another.
- **Navigation costs only what the page shows**: visiting `/chats`, `/search` and `/contacts` issued
  **zero** `/api/brain/quality` calls.
- **Run console** reads the split payload correctly: "6,940 episode(s) below v6", matching
  `/api/brain/quality`, and while it is loading the mode is disabled with "Counting episodes below the
  current contract…" rather than the false "Nothing to regenerate".
- **Commitments page** renders its chips from the real archive: 5,673 open / 4,999 overdue / 5,650 stale /
  5,633 sweep-due / 0 fulfilled / 0 dismissed.
- **Zero console errors** throughout; no unexpected requests.

### Gates

`npm test` — 59 files, **661 tests** passing. `npm run build` — clean. `npm run doctor` — clean (the
import-staging WARN is pre-existing and unrelated).
