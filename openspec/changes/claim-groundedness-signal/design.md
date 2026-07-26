## Context

Two separate defects share one surface. The **aggregation** defect is that the operator-facing flag count sums every row in `brain_validation_issues` regardless of whether the episode still exists as current, so 6,302 rows describing episodes that were already replaced dominate the number. That is straightforwardly wrong and cheap to fix. The **signal** defect is that `unanchored` — 4,325 rows, 39% of the total — measures token overlap between an English claim and predominantly Bengali/Hindi/Hinglish source text, which is a property of translation rather than of groundedness.

The lint's own source comment already anticipates this ("paraphrase and code-mixed text will false-positive"), and it was deliberately built to flag rather than block. The problem is not the lint's behavior but its promotion into an operator-facing quality number it was never designed to support.

The replacement instrument is already built: `brain-evaluation` specifies deterministic per-model claim sampling, a four-way grading vocabulary (`supported | partial | unsupported | unclear`) persisted with denormalized stamps, and per-model aggregates rendered in the Brain panel. Fifty claims are graded. The gap is that sampling has never covered the flagged population — zero of those 50 carry a flag — so the lint has never been evaluated against ground truth.

The economics also changed. Episodes are a pure projection and re-derivable, and the archive owner has confirmed a willingness to re-run generation broadly. That removes the constraint that made sampling the only sensible option.

## Goals / Non-Goals

**Goals:**

- The operator-facing defect count reflects actionable defects on current episodes.
- Claim groundedness is known for the current archive, not estimated — and reported as a rate with its denominator.
- Ungrounded claims become an actionable repair queue, not just a statistic.
- The lint's precision becomes a computed fact, deciding its own future.
- Grading stays current as new episodes commit.

**Non-Goals:**

- Deleting or rewriting historical issue rows. They are an accurate record of what happened; only their interpretation changes.
- Grading superseded episodes. Only current episodes describe the archive as it now reads.
- A groundedness check inside the commit path — see the decision below.
- Improving what the generation model produces. This change measures, and routes failures to the existing regeneration path; changing the extraction contract is separate work.
- Anything touching prompt construction or the provider seam (see `well-formed-prompt-truncation`).

## Decisions

**Census over sample, batched by episode.** Grading one claim at a time would be ~56,000 calls, but every claim in an episode cites messages from that episode's single evidence window — so one call can present the cited text once and grade all of that episode's claims together. That makes the census ~9,300 calls over current model episodes: the same order as a backfill pass, on infrastructure that already exists for exactly this shape of work. The payoff over a sample is qualitative, not just tighter error bars — a census produces a per-claim verdict, which is a repair queue. *Alternative considered:* the 150-claim sample originally scoped here. Rejected now that re-running is cheap: it would answer only "roughly how bad" and leave every individual bad claim unidentified.

**Grade with a strong model; this is verification, not suggestion.** Grading is a bounded judgment against supplied evidence with a fixed four-way output — precisely the shape this project reserves the strong tier for, and the opposite of open-ended generation. `gpt-5.6-sol` at elevated effort is the right default, and the census is a one-off plus a small ongoing trickle, so the per-call cost barely matters. The grader must also be a *different* model from the one that wrote the claim wherever possible, so the census is not a model marking its own homework — with two providers enabled this is arrangeable for the bulk of episodes and should be recorded per grade row.

**An LLM is the right tool here specifically because the failure is cross-language.** The lexical lint fails on exactly the cases a language model handles natively — judging whether an English claim is established by Bengali or Hinglish source text. This is not reaching for a model because one is available; it is the one instrument that can do the job at all.

**No grader in the commit path.** A tempting bolder move is to verify groundedness inline before committing an episode. Rejected: it doubles model calls on the write path, puts a second model between evidence and storage, and slows every run for a check that is equally useful asynchronously. An async census plus incremental grading yields the same signal and the same repair queue without making generation depend on a judge. Recorded here as considered-and-declined so it is not relitigated.

**Separate "actionable defect" from "advisory observation" in the data model, not just in the UI.** Advisory rows move to `info` severity with the count deriving from severity plus episode status, rather than the UI special-casing particular codes. A UI-side exclusion list would drift the moment a new code is added; severity is the field that already means this.

**Model-graded and human-graded rows stay distinguishable.** `brain_claim_grades` gains a grader-provenance column. The census makes model grades vastly outnumber human ones, and silently averaging them would destroy the ability to audit the grader. The existing manual grading strip becomes the check on the census: a human-graded subset measures grader agreement, which is the number that tells us whether to trust the census at all.

**Report a rate with its denominator, never a bare percentage.** The existing spec already insists sample sizes are shown "so thin data is never mistaken for signal". Post-census the denominator is large, but the same discipline applies to per-model slices, which can still be thin.

**Keep writing lint rows, and use them to order the queue.** Grading flagged claims first means the census surfaces genuine defects earliest and yields the lint's precision as soon as the flagged population is covered — before the run even finishes. Demoting the lint costs nothing and preserves that ordering value; deleting it would forfeit both.

## Risks / Trade-offs

- **The grader is itself a model and can be wrong** → The human grading strip stays, and a human-graded subset measures grader agreement. Report that agreement alongside the groundedness rate; a census with unmeasured grader accuracy is a number with no error term. `unclear` must be a first-class outcome so hard cross-language cases are not forced into a verdict.
- **A model grading claims written by the same model may be biased toward `supported`** → Record the grader model per row and prefer a different model from the writer; compare the agreement rate on the overlap where both arrangements exist.
- **~9,300 calls is a long-running pass that could wedge the machine** → Reuse the existing backfill run machinery: resumable, budget-capped, concurrency-limited, cancellable, with progress on the run surface. This is a known-shape workload, not new operational risk.
- **A census is a snapshot that decays as episodes are added or re-derived** → Incremental grading of newly committed episodes, plus invalidation of grades whose episode was superseded. Grades already denormalize their stamps, so historical rows stay meaningful.
- **Lowering the headline flag number could read as hiding problems** → The full breakdown stays one click away, and the change is a net increase in visible truth: today the real backlog of 132 is invisible inside 11,141. After the census the headline is a measured groundedness rate, which is strictly more informative than a flag count ever was.
- **The census could reveal a genuinely high ungrounded rate** → That is the change working. The repair queue and the existing regeneration path are the response, and re-derivation is cheap.

## Migration Plan

1. Land the aggregation fix first. It is independent of everything else, is the larger numerical correction, and needs no model spend.
2. Add the grader-provenance column and the census run kind.
3. Run the census flagged-first. Read the lint's precision as soon as the flagged population is covered.
4. Branch on that number: demote the lint, or implement the already-measured tuning rules instead.
5. Surface the groundedness rate, grader agreement, and the repair queue.
6. Re-derive episodes carrying `unsupported` claims, feeding the graded reason into the existing retry-with-errors path, then re-grade those episodes.

No data migration beyond the added column. Existing rows are re-labelled in place and every historical grade stays valid under its recorded stamps.

## Open Questions

- Does `partial` belong in the headline groundedness figure, or only `supported` (matching the existing strict-precision definition)? Leaning strict for the headline with the full distribution beside it.
- How large should the human-graded agreement subset be to make the census trustworthy — and should a low agreement rate block the demotion decision?
- Should re-derivation triggered by an `unsupported` grade bump `EXTRACTION_VERSION`, or is a targeted regeneration under the current version sufficient? Leaning targeted, since the contract is not changing.
- Should the census also cover extractive episodes as a control on the extractive path, or is the model-episode population the only meaningful target?
