# Retrieval Hardening — Tasks

## 1. Schema, derived columns, and index migration

- [x] 1.1 Add `messages.resolved_sender` and `messages.resolved_context` as guarded additive columns (`migrateAdditiveColumns`), and mirror the fields in `MemoryArchiveRepository`'s row model
- [x] 1.2 Extend `searchSchemaStatements` to the 5-column `messages_fts` (`resolved_text, body, caption, sender, context`), rewrite the three sync triggers to carry the new columns, add `messages_fts_vocab` (fts5vocab `row`), `brain_term_aliases`, and `idx_quoted_snapshots_source (quoted_source_message_id)`
- [x] 1.3 Teach `ensureSearchSchema` to structurally detect a pre-5-column `messages_fts` (pragma `table_info`), drop and recreate the FTS table + triggers on the new DDL, and stamp `needs_rebuild` when messages exist
- [x] 1.4 Auto-start the existing background reindex job on server boot when `fts_state = needs_rebuild` and messages exist (non-blocking, existing progress + failure surfaces), leaving the manual `POST /api/search/reindex` and CLI paths untouched
- [x] 1.5 Rework `composeResolvedText` → sender no longer co-mingled; compute `resolved_sender` (existing content-guard preserved) and `resolved_context` (link-preview title/description/canonical URL always; quoted-snapshot body/caption only when the original is absent-or-deleted in its source chat) inside `syncMessageDerivedState`, writing only on change
- [x] 1.6 Convergence hook: when message upsert ingests a message, re-derive the context of replies whose snapshots point at it (indexed lookup via `idx_quoted_snapshots_source`)
- [x] 1.7 Create `src/server/search/aliasSeed.ts` (conservative romanized-Hindi variant list) and seed `brain_term_aliases` idempotently on boot (`INSERT OR IGNORE`, `source='seed'`)

## 2. Query planner, ladder, and ranking

- [x] 2.1 Create the pure planner module `src/server/search/relaxation.ts`: tokenizer (ports `buildFtsMatchQuery` quoting/prefix semantics), bidirectional alias expansion (cap 3, cached), and the T0–T4 tier plan builder with quoted-phrase exemptions and equal-expression tier dedupe
- [x] 2.2 Document-frequency support: per-token df from `messages_fts_vocab` (exact term + starred prefix range-sum), archive doc count cached per query; T2 drops unmatchable (df=0) tokens first, then highest-df, floor 2 tokens; T3 keeps best ⌈n/2⌉ by IDF
- [x] 2.3 Rewire `sqliteRepository.searchMessages` through the planner: ladder execution gated on `minHits` (default 1), tier-aware `totalMatches` count, dual candidate pool (top-240 BM25 ∪ top-120 recency, deduped) with `bm25(messages_fts, 3.0, 2.0, 1.0, 0.5, 1.0)`, mention boost (batched `source_mask & 2` lookup, additive `SEARCH_MENTION_BOOST`), and per-row `senderOnlyMatch` / `termCoverage` computation
- [x] 2.4 Mirror the same observable semantics in `MemoryArchiveRepository.searchMessages` via the shared planner (tiers, aliases, sender/context strata, boost, matchTier/coverage)

## 3. Rename-triggered recompute

- [x] 3.1 Extend the `upsertContacts` repair predicate: snapshot genuinely-named labels before the write and add name→different-name changes to the repair set (union with unnamed→named), still routed through `repairIdentityResolution`; confirm `POST /api/persons/rename` inherits the fix and restated names cause zero recompute

## 4. DTO and client labelling

- [x] 4.1 `src/shared/types.ts`: `SearchResponse.matchTier` + `relaxation {tier, droppedTerms, totalTerms, requiredTerms}`; `SearchResultItem.termCoverage?` + `senderOnlyMatch?`
- [x] 4.2 Client: relaxation banner in `GlobalSearchResults` header (tier, matched-m-of-n, dropped terms), per-hit coverage chip on partial tiers, sender-match chip — `.filterBadge`-style, no raw JSON

## 5. Tests and fixtures

- [x] 5.1 `tests/retrieval-hardening.test.ts`: ladder tiers (typo→labelled partial with dropped term; prefix tier `relaxed`; strict-hit queries untouched; honest totals), alias recall ("nhi" finds "nahi" as `exact`), dual-pool recency guarantee, sender-split ordering + sender-only marking, mention-boost ordering (bit-2 boosted, bit-1 not), orphan-quote/link-preview context indexing + in-chat no-double-hit + late-original convergence, rename recompute end-to-end, SQLite/memory parity
- [x] 5.2 Keep `tests/search.test.ts` (incl. its mirror suite) green, adjusting only assertions the design intentionally changed
- [x] 5.3 Add at least one additional code-mixed case to the synthetic golden scaffold (`fixtures/eval/golden-queries.example.json`) and exercise transliteration variance in the vitest eval fixture
- [x] 5.4 Full `npm test` and `npm run build` green

## 6. Real-archive verification (checkpoint gates)

- [x] 6.1 Boot a server on a real-archive copy: additive columns land, FTS migrates to 5 columns, background reindex auto-starts and completes with visible progress in an acceptable window
- [x] 6.2 Gate queries on the real archive: a typo'd multi-word query returns labelled relaxed/partial results instead of nothing; "nhi" finds "nahi" messages; renaming a contact makes old messages searchable by the new name with zero model calls
- [x] 6.3 Run `brain:eval` (recall-only) against the real archive and record the per-class recall delta vs the latest pre-change baseline run in the change notes
