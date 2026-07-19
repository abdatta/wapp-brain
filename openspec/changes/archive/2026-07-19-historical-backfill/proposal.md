# Historical Backfill

> Proposal-level seed (2026-07-11; premises re-verified against the codebase 2026-07-16). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

Assimilating the pre-brain archive (~325k messages ≈ 3–4k chat-window packs) is the single largest token spend in the project's life, which is why it is gated behind three prerequisites: the extraction contract must be final (`episode-contract-v2` — re-extraction is the only expensive do-over), late name resolution must be repair-safe (`identity-late-resolution` — backfilling unresolved chats is then safe because repair is deterministic), and the model choice must be evidence-based (`brain-eval-harness` — the wired registry: codex `gpt-5.6-terra/sol/luna`, claude-cli `claude-haiku-4-5`/`claude-sonnet-5`/`claude-opus-4-8`/`claude-fable-5` — decided by measured recall/precision on this archive, not external benchmarks). Three evidence-completeness captures must also land first so episodes are born complete rather than re-extracted for them later: `demask-contact-labels` (20, clean substitutable `+E.164` labels), `reply-quote-recovery` (21, WhatsApp's chat-local quoted-message snapshots so replies to out-of-window / deleted / cross-chat originals carry their antecedent), and `archive-signal-capture` (22, the dropped source signals — structured mentions, shared locations/vCards, link previews, message edits/deletions, plus the identity signals number-changes and group-membership timeline) — all capture-before-spend for the same reason the contract is. Once those hold, backfill runs as a months-long background drain or attended turbo sessions, with coverage metadata keeping every answer honest meanwhile.

## What Changes

- **Queue-backed backfill**: uncovered (chat, window) work enqueued through `brain_tasks` (episode/regenerate producers exist; the historical producer is greenfield, and `brain_runs` already declares the `backfill` run kind with no producer), resumable by construction, dedupe-keyed, rate-limited under the daily ledger.
- **Ordering per resolved D12**: chat-level priority newest-first (recent history assimilates first); within-chat always oldest-first from the watermark — the scalar watermark stays honest, no interval bookkeeping.
- **`brain backfill --turbo`**: attended accelerated mode — user-set call rate, live progress, resumable, stoppable; respects provider health and budget stops (named `BUDGET_EXCEEDED`, never silent).
- **Backfill dashboard**: coverage percentage, drain rate, ETA at current pace, per-model spend so far, extractive-fallback rate as an ongoing quality canary (feeding the eval harness's per-model tables).
- **Weekly mini-episode folding**: `WAPP_BRAIN_SIGNIFICANCE_MIN` is already consumed by nightly dueness (`scheduler.ts` `isNightlyDue`, default 5); the missing piece is the folding itself — low-activity chats fold into weekly mini-episodes instead of burning per-day calls (essential at 3.7k chats).
- **Checkpoint**: start turbo backfill, kill the server mid-run, restart — it resumes with no duplicated episodes; the dashboard shows coverage climbing and honest per-model quality; a budget stop is a named state with remaining work pending.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: Offline Catch-Up requirement implemented for historical scope — queue-produced backfill tasks, resolved ordering semantics, turbo mode, significance-gate folding, spend/quality dashboard.

## Impact

- **Code**: backfill producer + drain in `src/server/brain/` (scheduler-adjacent), CLI `brain backfill [--turbo]`, dashboard section in the Brain panel.
- **Schema**: none new (consumes `brain_tasks`, watermarks, ledger).
- **Tests**: resume-after-kill, dedupe idempotency, ordering (newest chat first, oldest window first within chat), significance folding, budget-stop honesty.
- **Depends on**: `episode-contract-v2`, `identity-late-resolution`, `brain-eval-harness` (all three are hard gates before the spend); `build-the-brain`'s narrowed operational spine (run jobs/scheduler) for the drain loop.

## Checkpoint feedback — backfill model decided, no-silent-fallback required (2026-07-16)

The `brain-eval-harness` gate ran on the real archive. **Decision: backfill with codex `gpt-5.6-terra`.** Evidence (thin — 7–8 episodes/model, so weighted on reliability not the noisy precision gap): Terra **0% extractive-fallback** with 86.7% graded precision (4 partials = the garbled-referent issue); `claude-sonnet-5` **12.5% fallback** with 100% precision on what it produced. Sonnet's fallbacks trace to it emitting year-month `event_at` (`"2022-05"`) that contract-v2 validation rejects → double-fail → extractive. Baseline eval run `7ca7c08a-87e0-4789-81ec-c515eb8f9dbc` (golden v1 `2e789432de43be23`, overall r@10 60%).

**User requirement for this change:** backfill must not let episode generation *silently* degrade via extractive fallback. Design inputs (fallback is already tracked, never a silent model-switch — a model failure only ever falls back to extractive, stamped `generator='extractive'` + `fallback_reason` + `attempted_model`, with the errors in `brain_validation_issues` and the count in run progress):
- **Loud, not silent**: the turbo/backfill dashboard surfaces per-model fallback rate prominently and a run's completion is explicit about `N/M` extractive (not just a buried canary). A sustained fallback-rate spike is an alert-worthy state, not a footnote.
- **Recoverable by design**: extractive fallbacks are already in the regenerate selection set (`generator='extractive'` ⇒ `listRegenerableBrainEpisodes`), so a post-backfill `brain regenerate` sweep re-derives them under the current contract/model — spec a first-class "sweep the fallbacks" step so coverage-with-fallbacks is never mistaken for final quality.
- **Prevention beats cure**: Terra's ~0% fallback is the primary mitigation (choosing the reliable model). Consider optionally a *strict* backfill mode that leaves a twice-failed pack pending (does not advance the watermark over an extractive placeholder) so coverage counts only real model episodes — decide during `/opsx:propose`. The `event_at`-accepts-`YYYY-MM` validator loosening (per [[wapp-brain-model-selection-gpt56]]) would also cut fallbacks if a claude model is ever used.
