## Context

The 2026-07-11 architecture review, sharpened by empirical findings during build-the-brain on 2026-07-12, confirmed a set of shipped-code defects in the brain substrate that are wrong under any future design and cheap to fix now. They are not design decisions deferred to later waves — they are correctness bugs and honesty gaps in code that already runs, and every day they stand they corrupt trust in the substrate `episode-contract-v2` and everything downstream will build on.

Current state, grounded in the code:

- **Watermark tie.** Three predicates disagree about the watermark boundary. Coverage in `getBrainStatus` counts a message assimilated when `COALESCE(m.timestamp_ms,0) <= COALESCE(w.assimilated_through_ms,0)` ([sqliteRepository.ts:1711](src/server/db/sqliteRepository.ts)); backlog (`getBrainChatBacklog`, `chatsWithBacklog`) uses strict `>` ([sqliteRepository.ts:1479](src/server/db/sqliteRepository.ts), [:1725](src/server/db/sqliteRepository.ts)); the pack builder opens its window at `assimilatedThroughMs + 1` ([runJob.ts:145](src/server/brain/runJob.ts), [scheduler.ts:140](src/server/brain/scheduler.ts)). A message whose timestamp exactly equals the watermark is therefore counted **covered** but is never in the backlog and never enters a pack — silently hidden from assimilation while reported as done. The same `<=`-with-`COALESCE(...,0)` shape produced the `assimilatedVisibleMessages: 1` artifact after the 2026-07-11 reset: a timestamp-0 message counted "covered" against an absent (0-defaulted) watermark.
- **Identity merge strands brain state.** `mergeIdentity` rewrites `messages`, `chats`, `contacts`, `chat_participants`, `message_mentions`, and the `live_*` tables inside one transaction ([sqliteRepository.ts:2082](src/server/db/sqliteRepository.ts)) but touches no `brain_*` table (confirmed empirically, 2026-07-12). After a LID→PN merge the surviving chat has no watermark (its watermark still lives under the dead LID), so the whole chat re-assimilates into duplicate episodes; `brain_citations.source_message_key` still holds the old LID-form key even though the message rows were rekeyed to PN form. Pending `brain_tasks` are stranded too: an `episode`/`regen` task keys its dedupe on `episode:${chatSourceId}:${watermark}` and stores the pre-merge chat and window in its payload ([scheduler.ts:140](src/server/brain/scheduler.ts)), so after a merge the drain claims a task pointing at an orphaned window.
- **Runs cannot tell the truth.** `generateEpisodeForPack` already returns `fellBackToExtractive` ([episodes.ts:266](src/server/brain/episodes.ts)) but neither run path uses it — a run that produced nothing but extractive placeholders reports "completed" identically to a full model run. `completeBrainRun` persists `totals_json`, but `failBrainRun` does not ([sqliteRepository.ts:1684](src/server/db/sqliteRepository.ts)), so `budget_exceeded` and `interrupted` runs discard their accumulated counts. The fallback reason is only `console.warn`'d ([episodes.ts:319](src/server/brain/episodes.ts)), never persisted. And the chat total overcounts: both the auto drain (`chats: result.tasksDone`, [scheduler.ts:345](src/server/brain/scheduler.ts)) and the manual run (`processedChats += 1`, [runJob.ts:175](src/server/brain/runJob.ts)) increment on every window visited, including already-covered/empty windows where `executeEpisodeTask` returns `episodes:0` ([scheduler.ts:197](src/server/brain/scheduler.ts)) — so a run can report "12 chats" for 3 episodes.
- **Interrupted run invisible until restart.** The auto pass creates a `nightly` run then drains ([scheduler.ts:327](src/server/brain/scheduler.ts)); its only `try` wrapper is a `finally` that releases the lock ([scheduler.ts:357](src/server/brain/scheduler.ts)), with no run finalization. A throw from `drainBrainTasks` (e.g. a DB error at `getBrainLlmUsage`/`claimDueBrainTasks`/`completeBrainTask`, outside the per-task catch) leaves the `brain_runs` row `running`; `reconcileBrainRuns` only heals it on the next server start ([sqliteRepository.ts:1628](src/server/db/sqliteRepository.ts)), so `status.activeRun` shows a phantom live run until then. The manual run already finalizes on throw ([runJob.ts:196](src/server/brain/runJob.ts)); the auto pass does not.
- **Startup probe unwired.** `probeBrainProvider` exists ([provider.ts:256](src/server/brain/provider.ts)) and the `brain-model-provider` spec requires a startup end-to-end probe, but nothing fires it at server start — a broken WSL bridge stays invisible until the first run refuses.
- **Zeroed codex telemetry.** The codex/CLI generation path returns `usage: { inputTokens: 0, outputTokens: 0 }` ([provider.ts:404](src/server/brain/provider.ts)); those zeros flow straight into the ledger, so budget accounting silently under-counts real spend.
- **Status query is expensive and hot.** `getBrainStatus` runs a full `messages ⋈ chats ⋈ watermarks` scan under `visibleExchangePredicate`; the client refetches it on every `archive-updated` SSE (throttled to 1/s, [App.tsx:357](src/client/App.tsx)), so a history sync drives one full scan per second. `getBrainLlmUsage` filters `at_ms >= ?` ([sqliteRepository.ts:1701](src/server/db/sqliteRepository.ts)) instead of using the existing `idx_brain_ledger_day (day, purpose)` index. `commitBrainEpisode` re-lists the top 50 episodes to return the one it just wrote ([sqliteRepository.ts:1834](src/server/db/sqliteRepository.ts)).

Constraint from the roadmap: all brain-derived data is rebuildable, breaking changes are sanctioned, and the archive layer (`messages`, `chats`, `contacts`, media) must never be lost. Fixes here are additive-schema-only; no wipe is needed.

## Goals / Non-Goals

**Goals:**
- No message is ever both "covered" and "unselected": coverage and backlog derive from one shared predicate, tie-inclusive at the watermark with dedupe by citation.
- An identity merge leaves zero phantom backlog and zero duplicate re-assimilation: brain episodes, citations, watermarks, **and pending tasks** are reconciled deterministically inside the merge transaction, with no model call.
- Every run's outcome is honest: extractive-fallback breakdown is counted and surfaced, the chat total reflects chats that actually produced an episode (not empty windows visited), non-completed terminal runs persist their accumulated totals and a budget-skipped count, and the fallback reason is stored per episode.
- A run that throws mid-pass is marked terminal immediately, so no phantom `running`/`activeRun` survives until the next restart.
- A broken remote provider is a visible degraded state from server start, not first-run.
- Ledger rows carry real token usage or are explicitly marked `estimated` — never silent zeros.
- The status endpoint stops full-scanning the messages table once per second and `commitBrainEpisode` stops re-listing to return one row.

**Non-Goals:**
- No change to what an episode *contains* or how evidence is selected beyond the watermark boundary — the extraction contract itself is `episode-contract-v2` (Wave B).
- No new identity/person semantics — merge here means the existing deterministic LID→PN collapse; two-level person modelling is change #5.
- No migration machinery: derived tables are rebuildable, so we add nullable columns and let coverage/watermarks/tasks self-heal rather than backfilling.
- No retrieval, graph, or rollup work.

## Decisions

### D1 — A compound `(timestamp, id)` watermark cursor, and coverage derived as `total − pending`

The root cause of the tie bug is that the watermark is a scalar timestamp, and three predicates disagree about the boundary. WhatsApp timestamps collide (coarse resolution; bulk history import writes many rows with identical `timestamp_ms`), so a scalar timestamp cannot distinguish a boundary message that was assimilated from a same-timestamp message that arrived after the commit. The fix makes the watermark a **compound cursor** `(assimilated_through_ms, assimilated_through_id)` — timestamp plus the monotonic `messages.id` rowid — and derives coverage as `total_visible − pending` from one shared predicate, so no second `<=` predicate can drift.

A visible message is **covered** for its chat when a watermark row exists and it is at or before the cursor:
`m.timestamp_ms < w.assimilated_through_ms OR (m.timestamp_ms = w.assimilated_through_ms AND m.id <= w.assimilated_through_id)`.
A message is **pending** when it is not covered (including: the chat has no watermark row). Because `messages.id` increases with arrival, a genuinely-new message sharing the watermark's exact timestamp has a higher id than the cursor and is pending (shows in the backlog); the already-assimilated boundary message has `id <= cursor` and stays covered whether or not it was cited — so no seen-but-uncited tail is ever re-opened, and no 1-message fragment episodes are spawned.

On commit, the watermark advances to `(endAtMs, MAX(messages.id) over rows with timestamp_ms <= endAtMs in that chat)` — computed in SQL inside the commit transaction, so it captures every message seen at or below the boundary without threading rowids through the pack. On conflict the cursor advances to the greater `(ts, id)` lexicographically, never regressing. The pack builder's window start moves from `assimilatedThroughMs + 1` to a cursor-aware selection (`ts > wm_ts OR (ts = wm_ts AND id > wm_id)`), so backlog, coverage, and pack selection all use the identical predicate.

Coverage becomes `assimilated = totalVisible − pending`, which also erases the timestamp-0 artifact: a timestamp-0 message under an absent watermark falls into "no watermark row → pending," so it is never counted assimilated.

**Alternative considered — cited-key dedupe (the original proposal wording).** Rejected: the watermark advances to the last pack message's timestamp, but neither the model nor the extractive fallback is guaranteed to cite that boundary message, so dedupe-by-citation re-opens seen-but-uncited boundary messages and fragments episodes. The `(ts, id)` cursor is exact and citation-independent.
**Alternative considered — keep `+1`/`>` exclusive and switch coverage to strict `<`.** Rejected: an exclusive boundary permanently strands every message tied to a watermark on the wrong side.

### D2 — Identity merge reconciles all derived brain state deterministically, inside the transaction

`mergeIdentity` gains a final block, executed after the archive rekeys and message collapses so it reads post-merge message rows:

1. `UPDATE brain_episodes SET chat_source_id = pn WHERE chat_source_id = lid`.
2. Repoint citations off any collapsed message: when `collapseMessagePair(keepId, dropId)` runs, `UPDATE brain_citations SET message_id = keepId WHERE message_id = dropId` (the dropped rowid is about to vanish).
3. Rekey citations through the surviving rowid anchor: for citations under the merged chat, `UPDATE brain_citations SET source_message_key = (SELECT source_message_key FROM messages WHERE id = brain_citations.message_id), source_chat_id = pn WHERE source_chat_id = lid`. `message_id` is the stable `messages.id` rowid; it survives the merge even though `source_message_key`/`chat_id` change, which is why it is the anchor.
4. Merge the watermark cursor: fold the `lid` row into `pn`, keeping the greater `(assimilated_through_ms, assimilated_through_id)` lexicographically, then `DELETE ... WHERE chat_source_id = lid`. Coverage moves forward, never back.
5. **Drop stranded pending tasks:** `DELETE FROM brain_tasks WHERE chat_source_id = lid` (also any whose `payload_json` chat reference is the lid). Dropping — rather than rekeying — is chosen because a task's `dedupe_key` and payload window both embed the pre-merge chat and watermark; the next `computeDueWork`/`auditCatchup` pass re-enqueues correct tasks from the merged PN watermark, so a drop is self-healing and a rekey would only reconstruct a key we can regenerate for free.

All of this is pure `UPDATE`/`INSERT`/`DELETE` — no LLM, consistent with roadmap principle #5 (deterministic first). The in-memory mirror in `memoryRepository.ts` gets the equivalent reconciliation so test and memory-backed runs match.

**Alternative considered — mark brain state stale and regenerate.** Rejected: regeneration costs model calls and re-reads evidence for a relabel that changed no content. Staleness stays reserved for genuine content changes (edits/deletes), per principle #2/#3.

### D3 — One terminal-run writer that always persists totals; extractive, budget-skip, and produced-chats are counted honestly

Replace the split `completeBrainRun` / `failBrainRun` totals handling with a single persistence path that writes `totals_json` for **every** terminal status (`completed`, `interrupted`, `budget_exceeded`, `failed`). Totals become `{ episodes, claims, chats, chatsVisited, modelCalls, extractive, skippedForBudget }`:

- `extractive` increments when `result.fellBackToExtractive` — surfaced in the completion notice as `completed, N/M extractive` (N = `extractive`, M = `episodes`).
- `chats` counts chats that **produced at least one episode**; `chatsVisited` records windows visited. Both the auto drain and the manual run stop reporting `tasksDone`/`processedChats` as the chat count — an already-covered or empty window (`episodes:0`) increments `chatsVisited` only. This kills the "12 chats for 3 episodes" report.
- `skippedForBudget` counts chats still holding pending backlog when a budget stop fires (`backlog.length − processedChats` in the manual run; the residual pending count in the auto pass).

`commitBrainEpisode` accepts a nullable `fallbackReason`; `episodes.ts` passes the caught error's `publicErrorMessage` there instead of only warning. The client renders `latestRun` (status + finishedAt + error) in the Brain panel for all terminal states.

### D4 — A run that throws mid-pass is finalized immediately, not left phantom-`running`

Wrap the run lifecycle in the auto pass (`runBrainMaintenancePass`) so that once `startBrainRun` has created the row, any throw before a normal completion marks the run terminal (`interrupted` for a cooperative stop, `failed` for an exception) in a `catch`/`finally`, alongside the existing lock release — the run row is never left `running` for `reconcileBrainRuns` to heal only on the next restart. The manual run already does this on `catch` ([runJob.ts:196](src/server/brain/runJob.ts)); this change brings the auto pass to parity and adds a regression test for both. `resetInFlightBrainTasks` at pass start still returns orphaned *tasks* to pending; this decision covers the orphaned *run row*.

### D5 — Fire the startup probe non-blocking when a remote provider is enabled

At server start, after the provider module loads, `void probeBrainProvider().catch(() => {})` when the configured provider is model-backed, enabled, and has a session present. It updates provider health so a broken bridge is `degraded` before any run. Non-blocking: startup never waits on a WSL round-trip.

### D6 — Real usage or explicitly `estimated`, never zero

Extend the gpt-oauth-client to surface the `response.completed` usage object and thread `{ inputTokens, outputTokens }` through the codex path. Until that lands, estimate `Math.ceil(chars / 4)` for prompt and response and record the row with an `estimated` flag set. Add `estimated INTEGER NOT NULL DEFAULT 0` to `brain_llm_ledger` (additive); `recordBrainLlmUsage` accepts `estimated`. The daily cap still enforces a ceiling regardless.

### D7 — Bound status cost: TTL-cache the scan, index the ledger, return the committed row directly

- Memoize `getBrainStatus` with a ~1s TTL, invalidated on brain writes (commit, watermark advance, merge, reset). This bounds the full scan to at most once per second no matter how many SSE-driven refetches arrive, and the invalidation keeps post-run status immediate. The client keeps its existing 1s throttle as a second line of defense.
- `getBrainLlmUsage` queries `WHERE day = ?` (UTC day string derived from `sinceMs`) to hit `idx_brain_ledger_day`, replacing the `at_ms >= ?` scan. This matches the ledger's own UTC-day write convention.
- `commitBrainEpisode` returns the committed record via a single id-filtered fetch (`WHERE e.id = ?`) rather than listing the top 50.

### D8 — Resolve the D12 ordering ambiguity in one sentence

Append to `build-the-brain/design.md` D12: newest-first turbo backfill is a **chat-level priority only**; within-chat assimilation is always oldest-first from the watermark (what the code already does), which is what keeps the scalar watermark honest.

## Risks / Trade-offs

- **Reported coverage numbers shift on existing installs** → This is a correction, not a regression: the timestamp-0 artifact and any tie-"covered" messages move from assimilated to pending; the chat total drops to produced-chats. Derived data, no migration; the numbers become true. Note it in the run/status UI as expected.
- **Merge reconciliation touches many citation/task rows for a heavy chat** → Bounded by that one chat's citations and pending tasks, run inside the already-chunked merge transaction, which stays atomic. Merge is a rare, user-initiated action, so the cost is acceptable in exchange for correctness.
- **Dropping stranded tasks loses queued priority** → A merged chat's pending tasks are deleted and re-enqueued by the next due/audit pass from the merged watermark; the only loss is transient queue position, which the priority formula reconstructs. No coverage is lost because watermarks are the source of truth.
- **TTL-cached status is up to ~1s stale** → Acceptable for an operator dashboard; write-invalidation makes post-run and post-merge status immediate, which is when freshness matters.
- **`chars/4` token estimates mis-price budget** → The `estimated` flag keeps the ledger honest, the daily cap still enforces a hard ceiling, and real `response.completed` usage overwrites the estimate path once the client lands. Never a silent zero.
- **Coverage-by-subtraction depends on the pending predicate being exactly the pack-selection predicate** → Mitigate by defining the predicate once (a shared SQL fragment / helper) used by backlog, coverage, and the pack window, with a test asserting `assimilated + pending == totalVisible` per chat.

## Migration Plan

- **Schema (additive only):** `ALTER TABLE brain_chat_watermarks ADD COLUMN assimilated_through_id INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE brain_episodes ADD COLUMN fallback_reason TEXT` (nullable), and `ALTER TABLE brain_llm_ledger ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0`, guarded by the existing column-probe migration pattern (`migrateAdditiveColumns`). Existing rows default to 0 / null.
- **No data backfill:** existing watermarks default `assimilated_through_id` to 0, which is conservative — a chat's boundary-tie messages count pending until the next commit advances the cursor with a real id, never falsely covered. Coverage recomputes on the next status read; stranded watermarks self-heal on the next merge; stranded tasks are re-enqueued by the next due/audit pass; the ledger's historical zeros stay as-is (clearly a pre-fix artifact).
- **Rollback:** revert the code; the two nullable columns are inert if unused, so no down-migration is required.
- **Deploy note:** no wipe. The 2026-07-11 clean slate already emptied derived data, so the first post-deploy run starts from honest zero coverage.

## Open Questions

- The watermark cursor and citation rekey both lean on `messages.id` (rowid) being stable. It is, across merges and edits in this codebase; if a future change ever rewrites rowids, both the cursor and the citation anchor would need a durable key instead. Noted for `episode-contract-v2`.
- Should `chats` (produced) or `chatsVisited` be the headline number in the toast? Starting with produced as the headline and visited as a secondary detail; revisit once the eval harness reports per-run breakdowns.
