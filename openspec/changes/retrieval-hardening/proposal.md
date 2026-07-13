# Retrieval Hardening

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The shipped hot-tier search has recall dead-ends that no later tier can compensate for: implicit-AND FTS makes any multi-word query with one mistyped or differently-romanized non-final token return zero rows — and coverage metadata then endorses the false "no evidence". The top-240-by-BM25 candidate pool structurally excludes recent average-relevance matches before recency reranking ever runs. Sender names co-mingled in `resolved_text` make sent-by hits indistinguishable from about-hits, `message_mentions` sits unused by ranking, contact renames never retrigger derived-text recompute, and code-mixed Hinglish variants ("nhi"/"nahi") have no structural home — only future per-query LLM spend whose learnings evaporate. All fixes here are pure SQL, zero LLM, and benefit the search UI immediately.

## What Changes

- **Zero-hit relaxation ladder** in the shared FTS query layer (inherited by the future brain fast path): tier 1 prefix-star every token ≥3 chars; tier 2 drop highest-document-frequency tokens (via a one-time `fts5vocab` table); tier 3 require the best ⌈n/2⌉ tokens by IDF; tier 4 ranked OR-of-tokens. Executed only when strict AND returns zero (or <k) rows; `matchTier` (`exact|relaxed|partial`, "matched m of n terms") surfaced in the DTO so consumers see precision was degraded rather than silently receiving looser hits.
- **Dual candidate pool**: union top-240-by-BM25 with top-~120-by-recency among FTS matches (one extra indexed query, dedupe by rowid) — "best-matching AND most-recent are always considered" becomes an explicit guarantee.
- **Sender column split + entity boost**: sender label moves to a low-weight fourth FTS column (still satisfying the sender-indexed requirement) so sent-by matches are identifiable; an additive ranking boost for rows with a matching `message_mentions` row implements the specced entity boost early.
- **Rename-triggered recompute**: `upsertContacts` display-name changes enqueue the chunked per-JID `resolved_text` recompute (shared entry point with `identity-late-resolution`).
- **Term-alias layer**: `brain_term_aliases(term, variant, source, weight)` seeded with a small static romanized-Hindi list, OR-ing up to ~3 known variants per token into fast-path queries at zero query-time LLM cost; the future deep path persists its expansion learnings here so the asset compounds across queries.
- **Code-mixed fixtures**: at least one Hinglish test fixture so recall gates exercise transliteration variance, not just ASCII English.
- **Checkpoint**: a typo'd multi-word query returns relaxed-tier results labelled as such instead of nothing; "nhi" finds "nahi" messages; a renamed contact's old messages match the new name; the eval harness (if landed) shows the recall delta per class.

## Capabilities

### Modified Capabilities

- `archive-full-text-search`: gains the relaxation ladder with match-tier labelling, dual-pool candidate guarantee, sender-column separation with entity boost, rename-triggered derived-text maintenance, and the term-alias expansion layer.

## Impact

- **Schema**: fourth FTS column (index rebuild — measured at ~31s for 325k rows), `brain_term_aliases`, `fts5vocab` companion table.
- **Code**: `src/server/db/sqliteRepository.ts` (query builder, ladder, pools, boost) + mirror, seed list fixture, search DTO `matchTier` in `src/shared/types.ts`, client badge for relaxed results.
- **Tests**: ladder tiers, pool union, sent-by vs about ranking, alias OR-in, rename recompute, code-mixed fixture recall.
- **Depends on**: nothing hard; `brain-eval-harness` first is recommended so the delta is measured, and the rename-triggered `resolved_text` recompute hook coordinates with `identity-late-resolution` and `demask-contact-labels` (which lands first and needs the same recompute after its bulk display-name backfill — this change generalizes that one-off into the shared hook).
