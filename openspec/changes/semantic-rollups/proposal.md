# Semantic Rollups

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Fable.**

## Why

The semantic tier — entity/topic/chat pages and the overview, consolidated weekly from episodes — is where the strong-model budget goes and where rot risk concentrates (whole-document LLM rewrites). The review found the original plan's guard both too loose and too strict: the 30%-drop heuristic silently passes stale-claim drops below the threshold while blocking legitimate bulk consolidation, each revision diffs only against its predecessor (so an omission self-ratifies), rollup input selection at the 8k cap is unspecified (busy entities silently truncate), and there is no claim-level supersession — cross-episode consistency rests entirely on the model noticing conflicts. This change builds rollups with those defects designed out.

## What Changes

- **Rollup engine**: entity/topic/chat pages and the overview rewritten from episode claims only (never raw messages), weekly cadence plus on-demand; monthly episode compression into digests with citations preserved.
- **Declared supersession**: nullable `superseded_by_claim_id` on claims; the rollup JSON must carry `{supersedes: [claim_id]}` whenever prior-revision claims are dropped, so the regression guard distinguishes *declared* supersession (allowed, recorded) from *unexplained* shrinkage (rejected) — fixing both failure modes of the quantity-only heuristic.
- **Deterministic conflict candidates**: a pre-rollup query (same entity + same claim kind + overlapping topic across episodes) injects contradiction candidates into the rollup prompt as non-citable context — the model is *shown* likely conflicts instead of being trusted to notice them.
- **Deterministic input selection**: tiered quotas at the input cap (open commitments/questions → conflict candidates → top-salience → most-recent to fill), with the selected claim ids persisted on the doc revision so exclusions are auditable and the guard can distinguish "not fed" from "fed and dropped".
- **Regression guard + rollback**: claim/citation-set diff against prior revision with the declared-supersession channel; refusal raises a visible validation issue; retained revisions; mechanical `brain rollback <doc>`.
- **Extractive quarantine**: claims from extractive-generator episodes never enter rollup input (tagged low-trust at best) — placeholder filler cannot launder into the semantic tier.
- **Rendered claim dating**: the rollup input renderer prefixes each claim with its episode date range (or min citation timestamp) so legacy or deictic claim text arrives dated at the semantic tier.
- **Markdown projection**: pages/overview project to the Obsidian vault with frontmatter, wikilinks, claim anchors, stubs for merged/superseded docs; `brain project --rebuild`.
- **Checkpoint**: after a week of episodes, entity pages read as coherent dossiers with citations resolving to exact messages; a stub-model rollup that drops half its claims without declaring supersession is refused and the prior revision stays current; `brain rollback` restores mechanically.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: Tiered Assimilation and Quality Regression Guard rewritten — declared supersession, conflict-candidate injection, deterministic input quotas with persisted selection, extractive quarantine, dated claim rendering, chunk+yield requirement for batch jobs.

## Impact

- **Schema**: `brain_doc_revisions` (with selected-claim ids), `superseded_by_claim_id` on claims, `brain_validation_issues` consumers.
- **Code**: `src/server/brain/rollups.ts`, projection writer, rollback command, conflict-candidate query.
- **Docs**: design.md D8 rewritten (declared supersession); D1 rollup rules finalized.
- **Tests**: rollup from episodes only, declared vs unexplained shrinkage, conflict-candidate injection, input-quota determinism + audit, rollback, extractive quarantine, projection determinism.
- **Depends on**: `knowledge-graph-foundation` (pages target nodes), `commitment-lifecycle` (closure executes in these rollup calls — schedule adjacently).
