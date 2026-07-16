# Retrieval Hardening

> Proposal-level seed (2026-07-11; premises re-verified against the codebase 2026-07-16). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The shipped hot-tier search has recall dead-ends that no later tier can compensate for: implicit-AND FTS makes any multi-word query with one mistyped or differently-romanized non-final token return zero rows — and coverage metadata then endorses the false "no evidence". The top-240-by-BM25 candidate pool structurally excludes recent average-relevance matches before recency reranking ever runs. Sender names co-mingled in `resolved_text` make sent-by hits indistinguishable from about-hits, `message_mentions` sits unused by ranking, contact renames never retrigger derived-text recompute, and code-mixed Hinglish variants ("nhi"/"nahi") have no structural home — only future per-query LLM spend whose learnings evaporate. All fixes here are pure SQL, zero LLM, and benefit the search UI immediately.

## What Changes

- **Zero-hit relaxation ladder** in the shared FTS query layer (inherited by the future brain fast path): tier 1 prefix-star every token ≥3 chars; tier 2 drop highest-document-frequency tokens (via a one-time `fts5vocab` table); tier 3 require the best ⌈n/2⌉ tokens by IDF; tier 4 ranked OR-of-tokens. Executed only when strict AND returns zero (or <k) rows; `matchTier` (`exact|relaxed|partial`, "matched m of n terms") surfaced in the DTO so consumers see precision was degraded rather than silently receiving looser hits.
- **Dual candidate pool**: union top-240-by-BM25 with top-~120-by-recency among FTS matches (one extra indexed query, dedupe by rowid) — "best-matching AND most-recent are always considered" becomes an explicit guarantee.
- **Sender column split + entity boost**: sender label moves to a low-weight fourth FTS column (still satisfying the sender-indexed requirement) so sent-by matches are identifiable; an additive ranking boost for rows with a matching `message_mentions` row implements the specced entity boost early — `archive-signal-capture` (22) has landed since: `message_mentions` now carries `source_mask` provenance (bit 2 = authoritative structured source, bit 1 = @digit fallback), so the boost can key on `source_mask & 2` from day one.
- **Rename-triggered recompute (mostly shipped by #4 — close the remaining gap)**: `identity-late-resolution` built the shared entry point (`repairIdentityResolution` → chunked `recomputeFtsForIdentities`, wired into `upsertContacts`, Google enrichment, merges, and the startup backfill), but the trigger fires only on unnamed→named transitions — a rename from one genuine name to another never recomputes old messages' `resolved_text`. Remaining work: extend the `upsertContacts` predicate to display-name *changes* and call the existing entry point.
- **Term-alias layer**: `brain_term_aliases(term, variant, source, weight)` seeded with a small static romanized-Hindi list, OR-ing up to ~3 known variants per token into fast-path queries at zero query-time LLM cost; the future deep path persists its expansion learnings here so the asset compounds across queries.
- **Code-mixed fixtures**: at least one Hinglish test fixture so recall gates exercise transliteration variance, not just ASCII English.
- **Recovered quoted text (consideration, decide here)**: `reply-quote-recovery` (21) captures WhatsApp's quoted-message snapshots — for cross-chat (*Reply Privately*), deleted, or out-of-window originals this is content not otherwise present in that chat and arguably worth indexing; for in-chat quotes it would duplicate hits on the original. Whether/how to index quoted text (and dedupe against originals) is a decision for this change, not #21.
- **Link-preview text (consideration, decide here)**: `archive-signal-capture` (22) landed `message_link_previews` (title/description/canonical URL — 3,121 in the archive), candidate index text the roadmap's #22→#8 edge anticipated; decide alongside the quoted-snapshot question whether previews join `resolved_text` (or a low-weight column).
- **Checkpoint**: a typo'd multi-word query returns relaxed-tier results labelled as such instead of nothing; "nhi" finds "nahi" messages; a renamed contact's old messages match the new name; the eval harness (if landed) shows the recall delta per class.

## Capabilities

### Modified Capabilities

- `archive-full-text-search`: gains the relaxation ladder with match-tier labelling, dual-pool candidate guarantee, sender-column separation with entity boost, rename-triggered derived-text maintenance, and the term-alias expansion layer.

## Impact

- **Schema**: fourth FTS column (index rebuild — measured at ~31s for 325k rows), `brain_term_aliases`, `fts5vocab` companion table.
- **Code**: `src/server/db/sqliteRepository.ts` (query builder, ladder, pools, boost) + mirror, seed list fixture, search DTO `matchTier` in `src/shared/types.ts`, client badge for relaxed results.
- **Tests**: ladder tiers, pool union, sent-by vs about ranking, alias OR-in, rename recompute, code-mixed fixture recall.
- **Depends on**: nothing hard; `brain-eval-harness` first is recommended so the delta is measured. (`identity-late-resolution` and `demask-contact-labels` have both landed — the shared recompute hook exists; only the rename-trigger gap above remains.)
