## 1. Grapheme-safe truncation

- [x] 1.1 Add a shared exported truncation helper (grapheme-cluster boundaries via `Intl.Segmenter`, optional ellipsis marker, result never exceeds the bound) beside the existing prompt builders, segmenting only the leading `limit + margin` characters so cost is independent of input length
- [x] 1.2 Unit-test the helper: astral emoji at the bound, emoji ZWJ sequence, skin-tone modifier, Devanagari/Bengali base + matra, ASCII-only text unchanged, text shorter than the bound returned verbatim, and output length never exceeding the bound
- [x] 1.3 Route `boundedSignalText` in `src/server/brain/episodes.ts` through the helper (link previews at 160, transcripts at 320); bounds unchanged
- [x] 1.4 Route the in-pack quoted-reply snippet in `packPromptLines` (`src/server/brain/episodes.ts`, limit 80) through the helper
- [x] 1.5 Route the out-of-pack snippet in `resolveQuotedReferents` (`src/server/db/sqliteRepository.ts`, limit 80) through the helper
- [x] 1.6 Sweep for remaining `slice`-based truncations of archive-derived text that can reach a prompt (rollup, lifecycle, graph label paths) and route or explicitly exempt each with a comment

## 2. Provider-boundary well-formedness guard

- [x] 2.1 Confirm the Node baseline provides `String.prototype.toWellFormed()`; add a minimal fallback if not — runtime has it (Node 22) but the project's TS `lib` is ES2022, so `toWellFormedText` is implemented directly as the single always-tested path, with a test asserting parity against the native method
- [x] 2.2 Normalize system and user text in `generateStructured` (`src/server/brain/provider.ts`) before adapter dispatch, so no unpaired surrogate can reach any adapter — placed in `generateWithHealthTracking` so the health probe is covered too
- [x] 2.3 Record when the guard actually changes the text — call purpose and counts only, never prompt content — so a non-zero rate reads as the defect signal it is
- [x] 2.4 Test that a prompt with an unpaired surrogate is repaired and dispatched, and that correctly paired astral text is dispatched unchanged

## 3. Failure classification and pack quarantine

- [x] 3.1 Classify provider failures as deterministic-in-request (HTTP 400-class rejection) vs transient (timeout, transport, auth, usage limit) in `src/server/brain/provider.ts`, exposing the class on the thrown error — `BrainProviderRejection` for 400/413/422; 401/403/429/5xx/unknown stay transient
- [x] 3.2 Stop counting deterministic-in-request failures toward the consecutive-failure counter that latches degradation
- [x] 3.3 Stop the second generation attempt in `generateEpisodeForPack` when the first failed deterministically on byte-identical input
- [x] 3.4 Quarantine a deterministically-rejected pack in the drain (`src/server/brain/scheduler.ts`): record the reason, leave the rest of the queue claimable, do not halt
- [x] 3.5 Report quarantined count and reason in the run outcome (`src/server/brain/runJob.ts`) so a systematic rejection is visible rather than hidden behind an apparently successful run — count in run totals (the same channel the fallback canary uses), reason per pack on `fallback_reason`, plus a server-console warning at run end
- [x] 3.6 Test that a mixed queue of acceptable and deterministically-rejected packs drains fully, quarantines only the rejected ones, and leaves provider health undegraded

## 4. Verify against the real archive

- [x] 4.1 In an isolated environment (copied archive, scratch work dir, live codex session), rebuild the prompt for a known-400 window and assert it now contains zero unpaired surrogates
- [x] 4.2 Send that window's prompt to the codex provider and confirm it returns 200 and commits a model episode where it previously returned `400 {"detail":"Bad Request"}` — 200 OK, `generator=model`, one call, no retry
- [x] 4.3 Re-scan all previously-failing windows and confirm none produce an unpaired surrogate, and that a control sample of previously-succeeding windows is unchanged — failing windows went 38/38 → 0/38; control unchanged at 0/60

## 5. Repair affected episodes

- [x] 5.1 Run the fallback sweep on the live archive and confirm it drains past the point where it previously halted — ran to `completed`, 144 episodes, `quarantined: 0`; previously halted after 5-7
- [x] 5.2 Confirm the extractive backlog reaches zero — including the 38 windows that were stuck in the 400 loop — **partially met, by design.** All 38 cleared (0 remain with 400 history) and no other failure class remains. 67 episodes stay extractive for an unrelated pre-existing cause: `The episode contains no claims` on genuinely contentless windows (min 1, median 10 msgs — e.g. a lone `"😂"`). Tracked as its own change; not a regression of this one
- [x] 5.3 Regenerate the 2 `claude-sonnet-5` episodes whose prompt carried a lone surrogate in a quoted-reply snippet, and confirm their replacements are model-generated — both superseded, replacements are `model`
- [x] 5.4 Regenerate the 9 episodes whose annotations were split mid-grapheme-cluster (cheap, and their annotations genuinely improve) — all 12 marked-stale episodes regenerated, 0 remain below v5
- [x] 5.5 Confirm no run in the repair pass reports a provider outage, and that provider health ends clean — run `completed` with no outage message; health `consecutiveFailures: 0`, `degradedSince: null`
- [x] 5.6 Evaluate making sweeps strict by default — no extractive placeholder committed, unbuildable packs left pending — now that re-derivation is cheap and quarantine handles the deterministic-rejection case; decide and record, since it changes what a coverage number means

  **Decision: not yet — revisit immediately after `zero-claim-episodes` (#27).** Strict mode refuses the placeholder and leaves the window pending. Today 67 windows legitimately yield no claims (repeated morning greetings, lone reactions), so under strict they would never commit: coverage would fall below 100% and they would sit in a pending queue that re-attempts them every run and never drains — the same wasted calls as now, plus a permanently incomplete coverage number. After #27 those windows commit as valid claimless model episodes, leaving placeholders to arise only from genuine failures, which is exactly the population strict mode exists to protect. The blocker is sequencing, not the idea.

## 6. Close out

- [x] 6.1 Run the full test suite green — 583 tests across 51 files, including 26 added here (21 text-safety, 5 rejection/quarantine)
- [x] 6.2 Sync the delta specs into `openspec/specs/` and reconcile the roadmap board — roadmap reconciled (#25 `active`). Spec sync is performed by `openspec archive`, which is this project's only mechanism for it, so it lands with `/opsx:archive` rather than as a separate step here
