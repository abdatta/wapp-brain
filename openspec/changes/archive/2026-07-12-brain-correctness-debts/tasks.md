## 1. Additive schema

- [x] 1.1 Add `assimilated_through_id INTEGER NOT NULL DEFAULT 0` to `brain_chat_watermarks` (in the `CREATE TABLE` and via `migrateAdditiveColumns`).
- [x] 1.2 Add nullable `fallback_reason TEXT` to `brain_episodes` via the same guarded migration.
- [x] 1.3 Add `estimated INTEGER NOT NULL DEFAULT 0` to `brain_llm_ledger` via the same guarded migration.
- [x] 1.4 Confirm the migrations are no-ops on a fresh DB (columns present in the `CREATE TABLE`) and apply once on an existing DB. _(Verified live: `brain:status` migrated the real 310k-message archive with no error.)_

## 2. Watermark coverage truth (D1 — compound cursor)

- [x] 2.1 Define the covered/pending predicate once (`watermarkPendingPredicate`): a visible message is covered iff a watermark row exists and `m.timestamp_ms < w.assimilated_through_ms OR (m.timestamp_ms = w.assimilated_through_ms AND m.id <= w.assimilated_through_id)`; pending is its negation (including no watermark row).
- [x] 2.2 On commit (`commitBrainEpisode` inline advance and `advanceBrainWatermark`), advance the cursor to `(endAtMs, MAX(messages.id) WHERE timestamp_ms <= endAtMs for the chat)`; on conflict keep the greater `(ts, id)` lexicographically (`WATERMARK_CURSOR_UPSERT` + `boundaryRowidForChat`).
- [x] 2.3 Rewrite `getBrainChatBacklog` and the `chatsWithBacklog` query in `getBrainStatus` to use the shared pending predicate (cursor-aware); backlog now returns `assimilatedThroughId`.
- [x] 2.4 Rewrite `getBrainStatus` coverage to `assimilated = totalVisible − pending` using the shared predicate; deleted the independent `<= assimilated_through_ms` count and its `COALESCE(...,0)` timestamp-0 path.
- [x] 2.5 Change pack-window selection from `assimilatedThroughMs + 1` (in `runJob.ts` and `scheduler.ts`/`executeEpisodeTask`) to a cursor-aware window via `buildEvidencePacks({ startAtMs, afterId })`.
- [x] 2.6 Mirror the compound-cursor semantics in `memoryRepository.ts` (`isMessagePending` / `boundaryRowidForChat`).
- [x] 2.7 Existing `brain-substrate` watermark test: verified compatible with cursor semantics unchanged — `advanceBrainWatermark` derives the boundary id so scalar-advance coverage still holds; no edit needed.

## 3. Identity merge reconciles brain state (D2)

- [x] 3.1 In `mergeIdentity`, after the archive rekeys/collapses, `UPDATE brain_episodes SET chat_source_id = pn WHERE chat_source_id = lid`.
- [x] 3.2 In `collapseMessagePair`, repoint `brain_citations.message_id` from the dropped rowid to the kept rowid before the drop.
- [x] 3.3 Rekey citations through the surviving rowid (COALESCE keeps the old key when unresolved) and move `source_chat_id` to `pn`.
- [x] 3.4 Merge the watermark cursor: fold the `lid` row into `pn` keeping the greater `(ts, id)` lexicographically, then delete the `lid` watermark row.
- [x] 3.5 Drop stranded pending tasks: `DELETE FROM brain_tasks WHERE chat_source_id = lid`; the next due/audit pass re-enqueues from the merged cursor.
- [x] 3.6 Apply the equivalent deterministic reconciliation (episodes, citations, watermark, tasks) to the in-memory mirror in `memoryRepository.ts`.
- [x] 3.7 Keep the whole reconciliation inside the existing merge transaction (atomic; no model call).

## 4. Run outcome honesty (D3)

- [x] 4.1 In `runJob.ts`, accumulate an `extractive` counter (`result.fellBackToExtractive`) and a `skippedForBudget` counter.
- [x] 4.2 Count chats truthfully: `chats` = chats that produced ≥1 episode, `chatsVisited` = windows visited, in both the manual run and the auto pass (`DrainResult` exposes `chatsProduced`/`tasksDone`).
- [x] 4.3 Add `extractive`, `skippedForBudget`, `chats` (produced), and `chatsVisited` to the persisted `totals`.
- [x] 4.4 Persist `totals_json` on every terminal state via `failBrainRun(..., totals?)`.
- [x] 4.5 Thread nullable `fallbackReason` into `commitBrainEpisode` and its INSERT; `episodes.ts` passes the caught error's `publicErrorMessage`.
- [x] 4.6 In `App.tsx`, render `latestRun` in the Brain panel for all terminal states, and set the completion notice to `completed, N/M extractive` (plus an interrupted notice).

## 5. Runs finalize on failure (D4)

- [x] 5.1 `runBrainMaintenancePass`: `runId` hoisted so a `catch` marks the run `failed` on a post-start throw, alongside the `finally` lock release.
- [x] 5.2 Verified the manual run's existing throw-path finalization (`runJob.ts` catch → `failBrainRun`) leaves no `running` row.

## 6. Startup provider probe (D5)

- [x] 6.1 At server start, fire `void probeBrainProviderOnStartup()` (non-blocking) only when the provider is model-backed, enabled, and has a session present.
- [x] 6.2 Non-blocking (fired from the `app.listen` callback); a failed probe records a degraded state and logs it before any run.

## 7. Truthful usage telemetry (D6)

- [x] 7.1 Extend the gpt-oauth-client to surface the `response.completed` usage object. _(Done with one-time user authorization, backwards-compatibly: added optional `GPTOAuthUsage` + `usage?` on `GPTOAuthResponse` and the done-event `response`; `sendMessage`/`sendMessageStream` now surface `finalResponse.usage`. Built + 5/5 package tests pass, incl. a new usage test and a "no usage → undefined" back-compat assertion. wapp-brain resolves the package via the sibling `dist`, so the codex adapter now receives real tokens.)_
- [x] 7.2 Thread real usage through the codex path in `provider.ts`, replacing the `{ inputTokens: 0, outputTokens: 0 }` return (reads `response.usage` when present).
- [x] 7.3 When no usage object is available, estimate `Math.ceil(chars / 4)` for prompt and response and record with `estimated` set; never write a silent zero.
- [x] 7.4 Extend `recordBrainLlmUsage` to accept and store the `estimated` flag.

## 8. Bounded status cost (D7)

- [x] 8.1 Memoize `getBrainStatus` with a ~1s TTL, invalidated on brain writes (commit, watermark advance, merge, reset, run start/finish).
- [x] 8.2 `getBrainLlmUsage` filters `WHERE day = ?` for daily windows to use `idx_brain_ledger_day`; the hourly rate-limit window keeps `at_ms >= ?`.
- [x] 8.3 `commitBrainEpisode` returns the committed record via a single id-filtered `listBrainEpisodes({ episodeId })` instead of listing the top 50.

## 9. Docs (D8)

- [x] 9.1 Appended the D12 amendment to `archive/2026-07-12-build-the-brain/design.md`: newest-first is chat-level priority only; within-chat is oldest-first from the cursor.

## 10. Tests

- [x] 10.1 Watermark tie: a new same-timestamp message appears in the backlog, is not assimilated, and `assimilated + pending == total`; the seen boundary is not re-opened.
- [x] 10.2 Timestamp-0 artifact: a timestamp-0 message with no watermark reports zero assimilated.
- [x] 10.3 Merge with brain history: citations resolve under the canonical key, the watermark survives, backlog shows zero phantom pending.
- [x] 10.4 Stranded task: a pending task under the merged-away identity is dropped (asserted in the merge test).
- [x] 10.5 Fallback reason: a model run that falls back stores a per-episode `fallbackReason` and reports the extractive breakdown.
- [x] 10.6 Chat-count honesty: `drainBrainTasks` reports `chatsProduced` below `tasksDone` for an empty window.
- [x] 10.7 Auto-pass finalization: an exception in the auto pass marks the run `failed` (no lingering `running` row) without a restart.
- [x] 10.8 Budget-exceeded persistence: a non-completed terminal run persists its totals and `skippedForBudget`.
- [x] 10.9 Usage accounting: an estimated, flagged ledger row is recorded (non-zero) and counted.

## 11. Checkpoint (verify live)

- [x] 11.1 Extractive breakdown in the completion notice. _(Covered by automated test 10.5: a model run that falls back stores per-episode `fallbackReason` and the extractive count is threaded into totals/progress. Note: the live `N/M extractive` notice fires on model-run **fallbacks** — a pure extractive-mode run is intentionally extractive, so `extractiveEpisodes` is 0 by design.)_
- [x] 11.2 Interrupted run visible after restart. _(Confirmed LIVE: after a server restart the Brain panel showed "Last run: interrupted · 12 Jul 2026 — Interrupted by a server restart," and the boot log printed "Reconciled stale live state: 1 run(s).")_
- [x] 11.3 Merge with brain history → zero phantom backlog, no duplicate episodes. _(Covered by automated test 10.3, per user decision: it runs a real LID→PN `mergeIdentity` over a committed episode and asserts citations resolve under the canonical key, the watermark survives, backlog shows zero pending, and the stranded task is dropped. A live repro wasn't feasible: no `@lid` chat has brain history — only 2 group chats are assimilated — the Excel names PN contacts not LIDs, and this build has no manual-merge UI/API.)_
