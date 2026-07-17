# Brain Eval Harness

> Proposal-level seed (2026-07-11; premises re-verified against the codebase 2026-07-16). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The single critical finding of the 2026-07-11 architecture review: the design makes at least four commitments that require quantitative quality evidence — episode-quality gates, paraphrase-recall measurement, the "data-gated" embedding-rerank follow-up, and the D13 model-tier policy — yet nothing produces any measurement. The tier policy rests on external MRCR benchmarks never validated against this archive's code-mixed content, even though every episode is already stamped with generator/model (a free A/B substrate nobody reads). Without this harness, "the brain is good" is permanently unfalsifiable, the backfill model choice is vibes, and the embedding decision can never actually be gated. It lands after `episode-contract-v2` and before the backfill spend — measurements must exist before the money moves.

## What Changes

- **Golden query set**: ~30 versioned real queries across classes (paraphrase / person / commitment / temporal / code-mixed) with expected message keys, stored in-repo; extendable as new query classes emerge.
- **`brain:eval` CLI**: runs the golden set against search (and later brain retrieval), writing recall@k per class into a `brain_eval_runs` table; comparable across runs so any retrieval or contract change shows its delta.
- **Citation-precision sampling**: deterministically sample N committed claims, render claim beside its cited messages in the Brain panel for one-click manual grading (zero LLM cost, manual-first), grades persisted keyed on the episode's generator/model/extraction_version — per-model quality on *this* archive becomes queryable. (`EXTRACTION_VERSION` is already at 4 and regeneration marks old episodes `superseded` — sample only `current` episodes, and expect graded claims to age out on regeneration.)
- **Free interim signal**: extractive-fallback rate aggregated per model from existing episode columns and shown in the Brain panel — the panel already surfaces validation-issue counts and media-gap aggregates (2026-07-16), but the per-model fallback aggregation still has no reader; this adds it.
- **Gate criteria rewritten**: downstream phase gates change from "run a paraphrase query" to "golden-set recall@k per class meets or exceeds the recorded baseline"; the embedding-rerank follow-up gets its actual data producer.
- **Checkpoint**: run `brain:eval` on the 2–3 contract-v2 chats; grade ~20 claims for Terra vs Sonnet on the real archive (the wired registry: codex `gpt-5.6-terra/sol/luna`, claude-cli `claude-haiku-4-5`/`claude-sonnet-5`/`claude-opus-4-8`/`claude-fable-5`; defaults terra and sonnet-5; per-call `effort` exists for codex only); see a recall table and a per-model precision/fallback table — then (and only then) choose the backfill model.

## Capabilities

### New Capabilities

- `brain-evaluation`: golden-set retrieval recall measurement, claim-citation precision sampling with manual grading, per-model quality aggregation, versioned eval runs as gate criteria.

## Impact

- **Schema**: `brain_eval_runs`, `brain_claim_grades` (claim_id, grade, graded_at, generator/model/version denormalized).
- **Code**: `src/server/cli.ts` `brain-eval` subcommand, eval runner module, Brain panel grading strip + fallback-rate line, golden set fixture file.
- **Docs**: TESTING.md gains the eval methodology; gate criteria updates in the roadmap.
- **Tests**: eval runner determinism, grade persistence, recall computation against a synthetic fixture with known answers.
- **Depends on**: `episode-contract-v2` (grades key on the final contract's stamps; claims graded under a throwaway contract would be wasted effort). Search-recall classes can run before that lands if useful.
