## 1. Honest defect count (no model spend, independent of everything else)

- [ ] 1.1 Move `unanchored` to `info` severity at the write site in `src/server/brain/episodes.ts`, and backfill existing `unanchored` rows to `info` in place (re-label, never delete)
- [ ] 1.2 Change the operator-facing defect count to derive from severity plus episode status — actionable severities on `current` episodes only — rather than summing all issue rows
- [ ] 1.3 Add a labelled breakdown behind the headline: current-actionable, current-advisory, by-design notices, superseded, each with its own count
- [ ] 1.4 Update the Brain panel tile and its tooltip so the number's meaning is stated where it is read
- [ ] 1.5 Test that a new advisory code written at `info` does not change the headline count without a logic edit
- [ ] 1.6 Verify against the live archive that the headline drops from ~11,141 to the current-actionable figure (~132 at time of writing) and that the breakdown sums back to the original total

## 2. Grading substrate

- [ ] 2.1 Add grader provenance to `brain_claim_grades` — grader kind (human/model), grading model, grading effort — defaulting existing rows to human
- [ ] 2.2 Extend the grade-writing path and per-model aggregates so model and human grades are never combined into one figure
- [ ] 2.3 Implement grader agreement: the rate at which model grades match human grades on claims graded both ways, with its subset size
- [ ] 2.4 Build the episode-batched grading prompt — one episode's claims plus the full verbatim text of their cited messages — returning a per-claim verdict in the existing four-way vocabulary, with `unclear` a first-class outcome
- [ ] 2.5 Choose the grading model per episode preferring a model different from the claim's writer, and record which arrangement applied
- [ ] 2.6 Unit-test prompt construction and response parsing, including a partial response, an unknown verdict value, and an episode whose claims cite text-less media

## 3. Census run

- [ ] 3.1 Add a grading run kind reusing the existing run machinery: progress, cancellation, resume, per-run and daily budget ceilings, ledger accounting
- [ ] 3.2 Order the queue so anchoring-flagged claims' episodes are graded first
- [ ] 3.3 Make resume skip already-graded claims and report remaining population
- [ ] 3.4 Confirm no grading call occurs on the episode commit path
- [ ] 3.5 Dry-run the census scoped to one chat on a copied archive, verifying batching, resume, and ledger accounting before any full run
- [ ] 3.6 Run the census over all current model episodes; expect roughly one call per episode

## 4. Read the result and decide the lint's fate

- [ ] 4.1 Once the flagged population is covered, compute the lint's precision — rate of non-`supported` grades among flagged claims versus unflagged
- [ ] 4.2 Compute grader agreement against the human-graded subset; if agreement is too low to trust the census, grade a larger human subset before acting on any of it
- [ ] 4.3 Decide from those numbers: demote the lint as specified, or implement the already-measured tuning rules (language-invariant anchors, normalized tokenization, cross-language detection — 53.7% clearance) instead
- [ ] 4.4 Record the decision and its supporting figures in the change folder, so the reasoning survives the archive

## 5. Groundedness reporting

- [ ] 5.1 Serve the groundedness rate per model stamp and extraction version with grade distribution, denominator, and as-of time
- [ ] 5.2 Render it on the quality surface beside grader agreement, replacing the flag-based quality impression
- [ ] 5.3 Exclude grades whose episode has been superseded from current-state figures while keeping them queryable under their recorded stamps
- [ ] 5.4 Keep incremental grading running for newly committed episodes so the figure stays current

## 6. Repair queue

- [ ] 6.1 Expose `unsupported` claims as a queue naming their episodes
- [ ] 6.2 Offer regeneration scoped to that queue, feeding the graded reason into the existing retry-with-errors path as feedback
- [ ] 6.3 Re-grade regenerated episodes and confirm the superseded grades leave the current-state figure while the replacements enter it
- [ ] 6.4 Report the before/after groundedness rate for the repaired population, so the repair's effect is measured rather than assumed

## 7. Close out

- [ ] 7.1 Run the full test suite green
- [ ] 7.2 Sync the delta specs into `openspec/specs/` and reconcile the roadmap board
