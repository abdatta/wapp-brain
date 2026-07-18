# Retrieval Hardening — Design

## Context

The shipped archive search is a single-tier FTS5 pipeline in `src/server/db/sqliteRepository.ts`:

- `messages_fts(resolved_text, body, caption)` — a **content-storing** FTS5 table (`tokenize='unicode61 remove_diacritics 2', prefix='2 3'`), synced by three rowid-keyed triggers off `messages`. External-content mode was deliberately abandoned after shadow-table corruption on the real archive; that stays.
- `resolved_text` is built by `composeResolvedText(body, caption, mediaName, senderLabel, mentionLabels)` — the sender label is co-mingled with content, so a sent-by hit is indistinguishable from an about-hit and inherits the top 3.0 column weight.
- `buildFtsMatchQuery` quotes every token and joins with implicit AND; only the final token gets a prefix star. One mistyped or differently-romanized non-final token ⇒ zero rows, and `totalMatches: 0` endorses the false "no evidence".
- Candidates are `ORDER BY bm25(messages_fts, 3.0, 2.0, 1.0) LIMIT 240` (`SEARCH_CANDIDATE_POOL`), then reranked in JS by `score = relevance × recency` (90-day half-life, floor 0.2). A recent average-relevance match that misses the top-240 BM25 cut is structurally invisible.
- `message_mentions(message_id, mentioned_jid, source_mask)` exists (bit 1 = `@digits` text fallback, bit 2 = authoritative structured source) but is never joined by ranking.
- `syncMessageDerivedState` is the single choke point that recomputes derived search state; `recomputeFtsForIdentities` → `repairIdentityResolution` is the shared identity-repair entry point. The `upsertContacts` trigger predicate (`genuinelyNamedJids` before/after diff) fires **only on unnamed→named transitions** — a rename from one genuine name to another never recomputes old messages, and the in-app rename (`POST /api/persons/rename`) routes through `upsertContacts("user-rename", …)`, so it inherits the gap.
- `message_quoted_snapshots` (reply-keyed, `quoted_source_message_id`/`quoted_source_chat_id` pointers, full body/caption) and `message_link_previews` (title/description/canonical_url, ~3.1k rows) exist but feed no FTS column.
- No `fts5vocab` table, no alias machinery exists.
- `MemoryArchiveRepository` (`src/server/db/memoryRepository.ts`) re-implements search as a pure-JS scan; `tests/search.test.ts` runs a mirror suite against it, so every query-semantics change lands twice.
- The eval harness (`runBrainEval`, target `archive-search`) measures per-class recall@{5,10,20} against golden `sourceMessageKey` sets by calling `repository.searchMessages` — the delta measurement for this change comes free.

Constraints: everything here is pure SQL/JS — zero model calls at query time; the breaking-change sanction applies (FTS drop-and-rebuild is fine, archive tables are untouchable); long operations must be non-blocking with visible progress; the real archive is ~326k messages / ~3.7k chats and the measured full FTS rebuild is ~31s.

## Goals / Non-Goals

**Goals:**

- No multi-word query dead-ends: a zero-hit strict query walks a relaxation ladder and returns labelled looser results instead of nothing.
- Recency guarantee: best-matching **and** most-recent FTS matches are always both in the rerank pool.
- Sent-by hits identifiable and down-weighted; authoritative mentions boost about-hits.
- A contact rename (genuine name → different genuine name) repairs derived search text through the existing identity-repair entry point.
- Romanized-Hindi variant recall ("nhi" finds "nahi") via a persistent, compounding term-alias layer at zero query-time model cost.
- Orphaned quoted-snapshot text and link-preview text become searchable without duplicating hits on originals.
- Honest labelling end-to-end: `matchTier` in the DTO, badges in the UI, eval measures the delta.

**Non-Goals:**

- No LLM query expansion, no embeddings/vectors, no reranker models — the deep path is `brain-retrieval-pipeline` (#12); this change only leaves it the alias table to write into.
- No episode/brain regeneration and no evidence-pack changes (quote/preview indexing is FTS-only; packs already render both).
- No alias-management UI and no user-editable alias CRUD (schema supports future sources; seeding is static).
- No search-UI redesign beyond relaxation/coverage/sender badges.
- No change to the demask backfill path or to Google enrichment's no-overwrite policy.

## Decisions

### D1. FTS schema: three columns → five, fed by two new derived columns on `messages`

`messages_fts(resolved_text, body, caption, sender, context)` with weights `bm25(messages_fts, 3.0, 2.0, 1.0, 0.5, 1.0)`.

- `composeResolvedText` stops appending the sender label; `resolved_text` becomes mention-resolved body + caption + media name only.
- New `messages.resolved_sender` — the sender display label (owner name for `fromMe`), populated only when the row has visible content (same guard as today, so content-less system rows don't become searchable by name). Keeps the spec's sender-indexed requirement satisfied while making sent-by matches low-weight and identifiable.
- New `messages.resolved_context` — orphaned quoted-snapshot text (D8) + link-preview title/description/canonical URL (D8), newline-joined.
- Both columns are maintained inside `syncMessageDerivedState` (the existing single choke point), written only when the value changed, and mirrored into FTS by the extended triggers (`AFTER UPDATE OF resolved_text, body, caption, resolved_sender, resolved_context`).

*Why messages columns instead of FTS-only writes*: the rowid-keyed triggers are the one sync mechanism and they read the `messages` row; bypassing them re-opens the drift/corruption class the content-storing migration closed. `resolved_text` set the precedent.

*Alternative rejected*: folding context into `resolved_text` (single column) — loses the ability to weight snapshot/preview text below primary content and to tell which stratum matched.

### D2. Zero-hit relaxation ladder in a shared query planner

New pure module `src/server/search/relaxation.ts` exports the token model (tokenize + quote handling identical to today's `buildFtsMatchQuery`), alias expansion (D7), and a **tier plan builder**. Both repositories consume the same plan; only execution differs (SQL MATCH vs JS scan). This is the "shared FTS query layer" the future brain fast path inherits.

Tiers, each producing a MATCH expression (a tier is skipped when its expression equals the previous one):

- **T0 `exact`** — today's semantics: all tokens ANDed, final unquoted token prefix-starred, plus alias OR-groups (D7).
- **T1 `relaxed`** — every unquoted token with ≥3 word chars gets a prefix star (the `prefix='2 3'` indexes keep short-prefix scans cheap; longer prefixes fall back to term-range scans, acceptable on the zero-hit path).
- **T2 `partial` (drop tokens)** — using document frequencies from `fts5vocab`: first drop **unmatchable** tokens (df = 0 even with their star — they cannot match anything; this is the typo case, and dropping the typo'd token preserves AND precision on the rest), then drop remaining tokens highest-df-first, one at a time, re-querying each step, floor of 2 surviving tokens. Explicitly quoted phrases are never starred or dropped in T1–T3.
- **T3 `partial` (best half)** — require only the best ⌈n/2⌉ tokens by IDF (rarest kept), prefix-starred.
- **T4 `partial` (ranked OR)** — OR of all tokens (starred), BM25-ranked so multi-token rows surface first.

Escalation runs **only while the result count is below `minHits` (default 1 — i.e. only on zero hits)**; the parameter exists so the future brain fast path can demand more. Rationale for zero-hit-only: non-empty strict results are real hits; blending looser hits below them complicates ranking and the honesty story for no measured win. `totalMatches` is computed with the tier that actually produced results, so the count always describes what is shown.

*Why df-guided dropping and not edit-distance*: `spellfix1` needs a loadable extension build and a maintained vocabulary; trigram tokenizers double the index. The df signal is free (fts5vocab is a zero-maintenance virtual table over the existing index), and T2's unmatchable-first refinement recovers the typo checkpoint at AND precision instead of falling through to OR.

### D3. Dual candidate pool

Two bounded queries with the identical WHERE (winning tier + filters): top `SEARCH_CANDIDATE_POOL = 240` by BM25 ∪ top `SEARCH_RECENCY_POOL = 120` by `timestamp_ms DESC`, deduped by message id, then the existing JS recency rerank over the union. "Best-matching and most-recent are always considered" becomes an explicit guarantee. One extra indexed query; both scans are over the FTS match set that the count query already traverses.

*Alternative rejected*: raising the single pool (a bigger BM25 pool still has no recency guarantee and gets slower on common terms).

### D4. Sent-by identifiability

With the sender label in its own 0.5-weight column, sender-only hits stop outranking content hits. Per row, the reranker computes `senderMatch` (any query token or alias variant word-prefix-matches the sender label) and whether any content stratum matched (highlight present in resolved/body/caption snippets); `senderOnlyMatch = senderMatch && !contentMatch` is surfaced in the DTO so the UI can chip it. Sender-only hits keep their plain body snippet (no fabricated highlight).

### D5. Mention entity boost

After the pool union, one batched query fetches `message_mentions` rows for pool ids with `source_mask & 2` (authoritative structured mentions only, per the landed provenance bits), resolving mention labels through `contacts` at read time. A row whose mention label word-prefix-matches any query token (or alias variant) gets an additive `SEARCH_MENTION_BOOST = 1.0` before the final sort. Additive per the seed; magnitude is a tunable pinned by ordering assertions, not absolute values, in tests.

*Scope note*: the boost applies within the pool (rerank stage), not at candidate selection — the dual pool (D3) already guarantees recency representation, and a SQL-side join into the FTS candidate query would complicate the hot path for a marginal gain.

### D6. Rename-triggered recompute

`upsertContacts` today snapshots `namedBefore = genuinelyNamedJids(batch)` and repairs `named-after − named-before`. It additionally snapshots the **labels** of genuinely named JIDs before the write; the repair set becomes:

- unnamed→named transitions (unchanged), plus
- JIDs genuinely named before **and** after whose resolved label (display*name ?? push_name) changed — the rename case.

Both flow into the existing `repairIdentityResolution` (chunked, yielding, idempotent — safe under bulk `wa.db` imports because only actually-changed labels enter the set). This closes the gap for every rename source in one place, including `POST /api/persons/rename` (routes through `upsertContacts("user-rename", …)`) and future importers. Google enrichment stays untouched: it never overwrites a genuine name by design, so no rename can originate there.

### D7. Term-alias layer

New table (in `schemaStatements`, per the additive-DDL pattern):

```sql
CREATE TABLE IF NOT EXISTS brain_term_aliases (
  term    TEXT NOT NULL,   -- canonical form, tokenizer-normalized (lowercase)
  variant TEXT NOT NULL,   -- observed variant, tokenizer-normalized
  source  TEXT NOT NULL,   -- 'seed' now; 'model' reserved for the deep path
  weight  REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (term, variant)
)
```

Seeded idempotently on boot (`INSERT OR IGNORE`, `source='seed'`) from a small static romanized-Hindi list (`src/server/search/aliasSeed.ts`) — conservative, true spelling variants of the same word only ("nahi/nhi/nai", "kya/kia", "hai/h", "kar/kr", "kyun/kyu", "aur/or", "haan/han", "mujhe/muje/mje", "raha/rha", "gaya/gya", …), never near-words with distinct meanings ("bhai" ≠ "bhi").

At query time each unquoted token is looked up bidirectionally (rows where it equals `term` **or** `variant`); up to 3 co-variants by weight join it as a parenthesized FTS OR-group — at **every** tier, including strict. Alias expansion never changes `matchTier`: a variant hit is the same word, not a degraded match. The table is cached in memory on first use and invalidated on write; the future deep path (#12) persists its expansion learnings here so the asset compounds.

*Alternative rejected*: a synonym-aware tokenizer (native code) or baking variants into the index (index churn on every alias edit; query-time OR is cheap, transparent, and reversible).

### D8. Context column contents (the two "decide here" items)

- **Quoted snapshots — index only orphans.** A reply's snapshot text (body/caption) joins `resolved_context` **only when the original is absent**: no `messages` row with `source_message_id = quoted_source_message_id` in the source chat (`quoted_source_chat_id` when present, else the reply's own chat), **or** that row is deleted/empty-bodied. In-chat quotes of live originals stay unindexed — the original already matches, and duplicating it would double-hit every quoted exchange. Cross-chat *Reply Privately*, deleted, and out-of-window originals are exactly the content-not-otherwise-present cases.
- **Convergence when originals arrive later**: message upsert recomputes derived state for replies whose snapshots point at the arriving message (indexed lookup on a new `idx_quoted_snapshots_source (quoted_source_message_id)`), so a backfilled original demotes its now-redundant snapshot text instead of leaving a permanent duplicate.
- **Link previews — always index** title + description + canonical URL: preview text exists nowhere else in the archive, so there is no duplication concern; ~3.1k rows is negligible index weight at column weight 1.0.

### D9. DTO and UI labelling

`src/shared/types.ts`:

- `SearchResponse` gains `matchTier: "exact" | "relaxed" | "partial"` and optional `relaxation: { tier: 1|2|3|4; droppedTerms: string[]; totalTerms: number; requiredTerms: number }`.
- `SearchResultItem` gains optional `termCoverage: { matched: number; total: number }` (partial tiers only, computed in JS over returned rows against token + alias sets — display-grade, not ranking input) and optional `senderOnlyMatch: boolean`.

Client (`GlobalSearchResults` in `src/client/panels.tsx` + `SearchPage`): a header banner when `matchTier ≠ "exact"` ("No exact matches — relaxed search, matched m of n terms", listing dropped terms), a per-hit coverage chip on partial tiers, and a sender-match chip — following the existing `.filterBadge`/`.dueBadge` patterns. No raw JSON, per the UI principle.

### D10. `fts5vocab` companion

`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_vocab USING fts5vocab('messages_fts', 'row')` — created with the search schema, zero maintenance (it's a live view over the FTS index). df(token) = exact-term `doc` + (when starred) a bounded range scan summing `doc` over `term BETWEEN tok AND tok || high-codepoint`. N = FTS row count, cached per search call. The vocab table only serves T2/T3 planning; it is never on the strict path.

### D11. Measurement

- New Vitest coverage in `tests/retrieval-hardening.test.ts` (repo pattern: one file per change) for ladder tiers, pool union, sender split ranking, mention boost, rename recompute, alias OR-in, orphan-quote/preview indexing, and mirror parity — plus keeping `tests/search.test.ts` green (its mirror suite pins parity).
- At least one code-mixed fixture in the synthetic golden scaffold (`fixtures/eval/golden-queries.example.json` already ships `codemix-nahi-aa-raha` — extend the vitest fixtures so recall gates exercise transliteration variance without the real archive).
- On the real archive: `brain:eval` run before and after (recall-only, model-free) to show the per-class delta the roadmap checkpoint asks for.

## Risks / Trade-offs

- **[FTS rebuild window]** The 3→5 column migration drops and recreates `messages_fts`; search is refused until reindex completes (~31s measured, longer with context assembly). → Boot detects the column mismatch structurally, stamps `needs_rebuild`, and **auto-starts** the existing background reindex job (chunked, yielding, progress via `/api/search/status` + the existing UI banner) instead of waiting for a manual click. Failures surface in the banner and server console per the reindex job's existing contract.
- **[T4 OR queries over common tokens]** A ranked OR across frequent tokens scans a large match set. → Only reachable on the zero-hit path (rare by construction); pool LIMITs bound the fetch; the count query is the same class of work the strict count already does. If real-archive timing exceeds the 2s budget, cap T4's count to the pool size and report `totalMatches` as a lower bound ("240+") — decided at implementation with real timings.
- **[Alias false positives]** An over-eager pair ("me"/"mai") would pollute strict results invisibly. → Seed list is conservative and reviewed; `weight` and `source` columns exist so the deep path's learned aliases can be tiered or pruned later; tests pin that alias hits never change `matchTier`.
- **[Snapshot duplication until convergence]** A quoted original that arrives *after* the reply was indexed leaves duplicate context text until the upsert-time convergence hook fires — which it does on exactly that arrival (D8), so the window is the ingest transaction itself. Residual risk is only pre-existing rows at migration time, and the full rebuild recomputes everything anyway.
- **[Mirror drift]** Two implementations of one semantics. → The tier planner/tokenizer/alias expander live in one pure module consumed by both repos; the mirror suite in `tests/search.test.ts` plus new parity assertions keep observable behavior locked.
- **[Sender-only hits lose highlighted snippets]** resolved/body/caption snippets carry no highlight when only the sender matched. → `senderOnlyMatch` chip explains the hit; plain body snippet is shown (no fabricated highlight).
- **[Rename flood on bulk import]** A `wa.db` re-import upserting thousands of contacts must not trigger mass recompute. → Only JIDs whose resolved label actually changed enter the repair set; `repairIdentityResolution` is already chunked, yielding, and idempotent.

## Migration Plan

1. Boot on an existing archive: `migrateAdditiveColumns` adds `messages.resolved_sender` / `messages.resolved_context` (NULL); `ensureSearchSchema` detects the 3-column `messages_fts` (via `pragma table_info`), drops FTS + triggers, recreates the 5-column table + extended triggers + `messages_fts_vocab`, stamps `needs_rebuild`, and the server auto-starts the background reindex (visible progress; search refused with the existing `SEARCH_INDEX_NOT_BUILT` error until ready).
2. `brain_term_aliases` is created and seeded idempotently; `idx_quoted_snapshots_source` is added with the schema statements.
3. No archive-table changes; no episode regeneration; eval tables untouched.
4. **Rollback**: revert the code and run `search:reindex` — the old code's `rebuildSearchIndex` drops and recreates the 3-column FTS from its own DDL. The extra `messages` columns and the alias table are inert leftovers (additive, unread by old code).

## Open Questions

None blocking. Tunables (`0.5`/`1.0` column weights, `SEARCH_RECENCY_POOL = 120`, `SEARCH_MENTION_BOOST = 1.0`, alias cap 3) are pinned by ordering-level tests, with exact values adjustable against real-archive behavior during implementation; T4's `totalMatches` bound is decided by real-archive timing (see Risks).
