# Brain Correctness Debts

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The 2026-07-11 architecture review confirmed a set of shipped-code defects that are wrong under any future brain design and cheap to fix now: a watermark tie bug that silently hides messages from assimilation while reporting them covered, identity merges that rewrite every archive table but no `brain_*` table (stranding watermarks and producing duplicate re-assimilation), run reporting that cannot distinguish "completed" from "completed, all extractive placeholders", zeroed codex token telemetry, and brain status queries that full-scan the messages table up to once per second during live sync. None of these depend on later design decisions; all of them corrupt trust in the substrate the longer they stand.

## What Changes

- **Watermark tie fix**: pack selection becomes inclusive of the watermark timestamp with dedupe against already-cited `source_message_key`s; backlog/coverage predicates aligned; test where a second message with a timestamp equal to the watermark arrives after commit and must appear in the backlog.
- **Brain rekey on identity merge**: `mergeIdentity` extends its transaction to rewrite `brain_episodes.chat_source_id`, rekey `brain_citations` through the surviving `message_id` rowid anchor, and MAX-merge stranded watermark rows — deterministic UPDATEs, no LLM. In-memory mirror updated to match. Test: commit episode under LID chat, learn link, merge, assert citations resolve and no duplicate episodes on next run.
- **Run honesty**: `fellBackToExtractive` counted into run totals and the completion toast; `latestRun` (including interrupted/failed state and error) rendered in the Brain panel; `budget_exceeded` runs persist their accumulated totals including a `skipped_for_budget` count; fallback reason persisted per episode (nullable column), not just `console.warn`.
- **Startup provider probe**: `probeBrainProvider` fired (non-blocking) at server start when a remote provider is enabled with a session present, so a broken WSL bridge is a visible degraded state per the spec requirement that is currently checked-off but unwired.
- **Codex usage telemetry**: extend the gpt-oauth-client to surface the `response.completed` usage object; until it lands, estimate chars/4 and mark ledger rows `estimated` instead of writing zeros.
- **Status query hygiene**: `getBrainStatus` decoupled from the archive-updated SSE refresh path (or cached with a short TTL); ledger queried via the existing `(day, purpose)` index; `commitBrainEpisode` returns the constructed record instead of re-listing the top 50.
- **D12 ordering resolved in one sentence**: "newest-first" turbo backfill means chat-level priority only; within-chat assimilation is always oldest-first from the watermark (what the code already does), keeping the scalar watermark honest. Recorded in `build-the-brain/design.md` D12.
- **Checkpoint**: run a manual run against a degraded provider — the toast reads "completed, N/M extractive"; restart mid-run — the Brain panel shows the interrupted run; merge an identity with brain history — backlog shows zero phantom pending.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: watermark advance/selection semantics tightened (tie-inclusive, dedupe-by-citation); identity merges become a deterministic brain-side rekey (staleness reserved for content changes); run summaries must report generator breakdown and budget-skipped counts.
- `brain-model-provider`: startup end-to-end probe required when a remote provider is enabled; usage rows must be real or explicitly `estimated`, never silently zero.

## Impact

- **Code**: `src/server/db/sqliteRepository.ts` (mergeIdentity, watermark predicates, commit return path, status caching, ledger query), `src/server/db/memoryRepository.ts` (mirror), `src/server/brain/runJob.ts` (totals, fallback counts), `src/server/brain/provider.ts` + gpt-oauth-client (usage), `src/server/server.ts` (startup probe, SSE decoupling), `src/client/App.tsx` (latestRun, toast).
- **Schema**: nullable `fallback_reason` on `brain_episodes`; `estimated` flag on ledger rows (or convention in `provider` column). Additive only; no wipe needed.
- **Docs**: design.md D12 one-sentence amendment.
- **Tests**: watermark tie, merge-with-brain-history, run-totals honesty, budget-exceeded totals persistence.
