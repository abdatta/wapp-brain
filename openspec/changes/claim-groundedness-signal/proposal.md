## Why

The Brain panel reports **11,141 quality flags**. Broken down against the archive:

| Rows | Code | Episode status |
|---|---|---|
| 6,302 | `validation_failed` | **superseded** — the episode was already replaced by a model version |
| 4,325 | `unanchored` | current |
| 385 | truncation notices | current (benign, by design) |
| **132** | `validation_failed` | **current** — the real backlog |

So 57% of the headline is dead history, and the honest count of actionable defects on current episodes is about **132** — the same extractive placeholders the fallback sweep already drains. The number overstates by roughly 84×, which makes it useless for deciding whether the brain is healthy.

The second-largest component is worse than merely stale: the `unanchored` lint flags 4,325 claims (7.7% of all claims, touching 35.3% of current model episodes), and on this archive it appears to be almost entirely false positives. The lint requires a claim to share a distinctive token with its cited messages, but claims are written in English while the source is largely Bengali/Hindi/Hinglish — `"Bbq chalte hai"` → "suggested going for barbecue", `"Mein aaj a jaunga"` → "would arrive on 2019-01-02". Every one of 24 flagged claims inspected by hand was a faithful cross-language paraphrase.

Tuning does not rescue it. Three candidate improvements — language-invariant anchors (numbers, times, URLs, filenames, emoji), normalized tokenization, and cross-language detection — were implemented and measured against all 4,325 flagged claims: together they clear 53.7%, and the surviving 46.3% are *still* dominated by faithful paraphrase, including pure-English cases token overlap cannot handle (`"birthplace"` vs `"birth place"`, `"GeeksforGeeks"` vs `"geeks for geeks"`) and an irreducible semantic-only core (`"WE MUST GOOOO"` → "strongly advocated that the group attend"). Doubling the precision of a signal that still cannot be trusted is not worth the complexity.

Meanwhile the correct instrument already exists and is idle: `brain_claim_grades` holds model-graded `supported | partial | unsupported | unclear` judgments, currently 50 rows reading 46 supported / 4 partial / 0 unsupported. Critically, **zero of those 50 graded claims are flagged** — so there is no ground truth at all on the population in question, and the lint's real precision has never been measured.

## What Changes

- **Grade the whole current population, not a sample.** Because episodes are cheap to re-derive and grading batches naturally — every claim in an episode shares one set of cited messages, so one call grades the whole episode — a census over all ~9,300 current model episodes is roughly 9,300 calls rather than 56,000. That converts the exercise from "estimate a rate" into "know which claims are ungrounded", which is a strictly better artifact: it yields the lint's true precision *and* a concrete repair queue.
- **Close the loop into repair.** Every claim graded `unsupported` names an episode worth re-deriving, and the existing retry path already enumerates known errors back to the model. Graded failures become targeted regeneration input rather than a number on a dashboard.
- **Count defects honestly.** The operator-facing defect count includes only issues that indicate an actionable problem on a *current* episode. Superseded-episode issues, advisory lints, and by-design truncation notices are excluded from the headline and remain available as separate, labelled breakdowns.
- **Report groundedness as a measured rate, not a boolean flag.** The quality surface shows a sampled, model-graded groundedness rate with its denominator and as-of date, replacing "35% of episodes flagged" with something true.
- **Repurpose the lint as a prioritizer.** The anchoring lint keeps running and keeps recording rows, but its role becomes ordering the grading queue — flagged claims first — so the census surfaces real defects earliest. Once the census exists, the lint's precision is a computed fact and its future is decided by that number rather than by argument.
- **Keep grading incremental afterwards.** After the census, newly committed episodes are graded on an ongoing basis so the groundedness figure stays current instead of decaying into a one-time snapshot.

Assumption, to be confirmed by the census: the lint's precision is low enough to demote. If grading shows otherwise, the demotion steps are dropped and the tuning rules already measured (53.7% clearance) become the change instead.

## Capabilities

### New Capabilities

None. Both surfaces exist; this corrects what they measure and report.

### Modified Capabilities

- `brain-assimilation`: the Lexical Anchoring Lint is reclassified from a quality flag to an advisory sampling signal recorded at `info` severity, and the operator-facing defect count is required to reflect only actionable defects on current episodes.
- `brain-evaluation`: grading gains an automated, resumable, episode-batched census pass over current model episodes (alongside the existing manual grading, which stays as the human check on the grader), sampling gains anchoring-flag prioritization, and per-model aggregates gain a groundedness rate reported with its denominator and as-of date.

## Impact

- `src/server/brain/episodes.ts` — `lintClaimAnchoring` severity and issue code.
- `src/server/db/sqliteRepository.ts` — the status/aggregate queries behind the flag count and per-model quality aggregates.
- `src/client/pages/brain/BrainPage.tsx` — the quality-flag tile and the eval surface.
- `brain_validation_issues` rows are re-labelled, not deleted; existing `unanchored` rows stay queryable.
- A new grading run kind in the run machinery, reusing the existing pacing, resume, and ledger plumbing.
- Model spend on the order of one call per current model episode (~9,300), run as a resumable background pass under the existing budget ceilings — the same shape as a backfill, and re-runnable.
- `brain_claim_grades` gains a provenance column distinguishing a model-graded row from a human-graded one, so the two are never averaged together silently. Otherwise no schema migration: both tables already carry the needed columns.
