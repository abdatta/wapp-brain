# brain-eval-harness — Design

> Expanded 2026-07-16 from the 2026-07-11 seed (premises re-verified against the codebase the same day). Model for the working session: Opus.

## Context

The roadmap's governing rule is *contract before spend*: no archive-scale assimilation until quality is measurable. The contract landed (`episode-contract-v2`, `EXTRACTION_VERSION = 4` in `src/server/brain/episodes.ts:39`) and every episode is stamped with `generator`, `model`, and `extraction_version` — a free A/B substrate nobody reads. Nothing today measures retrieval recall or claim quality: the model-tier policy rests on external benchmarks never validated against this archive's code-mixed content, the embedding-rerank follow-up is "data-gated" with no data producer, and downstream phase gates say "run a paraphrase query" — anecdote, not measurement.

What exists to build on (verified):

- `searchMessages(options): Promise<SearchResponse>` (`src/server/db/sqliteRepository.ts:2113`, mirror `memoryRepository.ts:3140`) returns ranked results carrying both `messageId` (rowid) and `sourceMessageKey` — the same `wa|<chat>|<msgId>` key space `brain_citations.source_message_key` uses (`identity/keys.ts:6`). Golden-query recall is a direct join. It throws `SEARCH_INDEX_NOT_BUILT` when FTS isn't ready.
- `GET /api/brain/episodes` → `listBrainEpisodes` returns episodes with nested claims and citations (filters on `generator`/`status` already exist) — the read spine for grading; cited message *text* still needs a server-side join.
- Fallback marker: `generator='extractive'` + `fallback_reason` — but the fallback commit nulls `model` (`episodes.ts:1306`), so the *attempted* model is currently dropped.
- Anchoring-lint `unanchored` and `validation_failed` rows in `brain_validation_issues` were explicitly written as signals for this harness.
- `BrainPanel` (`src/client/panels.tsx:497`) is a status dashboard; no claim/citation view exists anywhere in the client. Routes are lazy per-page under `AppShell` (`src/client/routes.tsx`).
- No eval/grading/aggregation code exists anywhere (grep-verified); `brain_runs` records no model; reset (`sqliteRepository.ts:2664-2693`) and the contract-shape rebuild guard (`:8280`) both enumerate their targets explicitly.

## Goals / Non-Goals

**Goals:**

- Golden-set retrieval recall, measured per query class, persisted and comparable across runs — the gate data for retrieval changes and the embedding-rerank decision.
- Claim-citation precision from manual grading, keyed to the episode stamps, so per-model quality *on this archive* becomes queryable — the backfill model chooser.
- Free interim signals per model (fallback rate, validation/anchoring rates) from columns that already exist.
- Zero LLM cost end to end; measurement must be cheaper than dirt or it won't run.

**Non-Goals:**

- No LLM-judge grading (manual-first; a judge can be a later producer into the same grade table).
- No embedding/rerank work — this change produces the data that gates it, nothing more.
- No brain deep-retrieval eval yet: the runner targets archive search now, with the target field extensible so `brain-retrieval-pipeline` plugs in later.
- No multi-grader identity model: one owner, one grade per claim, overwrite on regrade.

## Decisions

### E1. Golden set: a self-versioned file next to the archive, never in git

`<WAPP_WORK_DIR>/eval/golden-queries.json` — sibling of `archive.sqlite`, deliberately **outside** `config.brain.rootDir`'s regenerable projection space and untouched by every wipe path. Shape: `{ version, classes, queries: [{ id, class, query, expect: [sourceMessageKey], note? }] }` with classes `paraphrase | person | commitment | temporal | code-mixed` (open vocabulary — new classes are data, not schema). Every run records `(version, sha256(file))`; comparisons are only offered between runs with equal hash, otherwise labelled cross-version. A **synthetic** example ships in-repo (`fixtures/eval/golden-queries.example.json`) as scaffold and test fixture; `brain-eval` with no file present writes the scaffold and exits with instructions rather than measuring an empty set.

*Why not in-repo, as the seed proposal said*: golden queries quote real archive content ("when did X say they'd pay rent" + real message keys). `docs/TESTING.md` Fixture Policy: real WhatsApp content is never committed. The seed's actual intent — versioned, reviewable, diffable — survives via the self-version + hash stamped into every run. *Why not a DB table*: hand-editing ~30 queries is a text-editor job; a JSON file diffs, backs up, and survives DB surgery by construction.

### E2. Runner: the real search path, recall@k per class, invalid expectations quarantined

`src/server/brain/eval.ts` — plain functions over `ArchiveRepository` (the `scheduler.ts` pattern), no new service surface. Per query: `searchMessages({ query, limit: max(K) })` with `K = {5, 10, 20}`; per-query recall@k = |expect ∩ top-k| / |expect|; class and overall aggregates are means, reported with `n` (thin data must look thin). Per-query detail (found/missing keys with ranks) persists in the run row for inspection. Expected keys that no longer resolve to a message are counted as `invalid_expectations` and excluded from recall — a stale golden entry must read as "fix the golden set", never as a retrieval regression. FTS not ready → refuse with the `search:reindex` hint (same contract as the search API). The whole run is zero-LLM by construction (nothing in the path can reach `generateStructured`) and yields between queries, honoring the never-block-the-event-loop rule.

*Why the shared `searchMessages` and not a bespoke query*: the measurement must move when user-facing retrieval moves — `retrieval-hardening`'s ladder and `matchTier` should show up in the recall delta for free. A parallel implementation would measure a fiction and silently drift.

### E3. Execution topology: server-owned routes; the CLI delegates when the server is up

Eval and grading live behind `/api/brain/eval/*` routes executing inside the server process. `brain-eval` (CLI) probes the configured local port first: server answering → delegate over HTTP and print the same report; nothing listening → open the repository directly (`createArchiveRepository()`) and run the identical module. Runs are synchronous requests (~30 pure-SQL queries, well under the progress threshold; the UI button still gets a busy state per the async-progress house rule) — no job/queue machinery.

*Why not offline-only with the advisory-comment pattern of `brain-run`/`brain-regenerate`*: those commands are long write storms; eval is a single-row write after read-only queries, and its natural workflow is interactive — run, tweak, re-run, grade in the panel — exactly when the server *is* up. Better-sqlite3's single-writer constraint is honored by putting the write inside the process that already owns the DB, not by asking the user to stop it. *Why not a lockfile protocol*: solving cross-process writer arbitration for one tiny write is machinery without a customer.

### E4. Persistence: two standalone tables that survive every wipe

Added to `schemaStatements` (idempotent `CREATE TABLE IF NOT EXISTS`, both backends mirrored):

- `brain_eval_runs(id TEXT PK, ran_at_ms, target TEXT /* 'archive-search', extensible */, golden_version, golden_hash, k_values_json, query_count, invalid_expectations_json, per_class_json, per_query_json, totals_json, notes NULL)` — index `(golden_hash, ran_at_ms)`.
- `brain_claim_grades(claim_id TEXT PK, grade TEXT CHECK ('supported','partial','unsupported','unclear'), graded_at_ms, episode_id, chat_source_id, generator, model, extraction_version, claim_kind, claim_confidence, claim_text, citation_keys_json)` — index `(model, extraction_version)`.

**No foreign keys into brain tables, deliberately.** Grades denormalize everything they mean at grade time (stamps read server-side from the claim's episode, never trusted from the client); a grade outlives its claim's supersession, deletion, and any brain wipe. Both tables are **excluded** from `resetBrainData`'s delete set, from `rebuildBrainDerivedTablesIfStale`'s drop list, and from regeneration side effects — eval history and human labels are user-authored ground truth, not derived data; a test pins reset-survival. Regrade = `INSERT OR REPLACE` on `claim_id` (claim ids are UUIDs; a regenerated episode's new claims are new UUIDs, so old grades never collide with new claims).

### E5. Sampling: deterministic, stratified per model, current-only, ungraded-first

`listClaimsForGrading({ perModel, includeGraded })`: eligible claims are those of `status='current'`, `generator='model'` episodes (extractive placeholders are honest but ungradeable — nothing to attribute to a model); stratified per `model`; within a stratum ordered by `(grade IS NULL) DESC, claim.id ASC`. Claim UUIDs are already uniform-random, so UUID order **is** an unbiased stable shuffle — same archive state, same sample, no `RANDOM()`, no seed plumbing, reproducible in both backends with one `ORDER BY`.

*Why not insertion order*: biased toward oldest chats/packs. *Why not `RANDOM()` with a seed*: SQLite's `RANDOM()` is unseedable per-query without a UDF; UUID order gets the same statistical effect for free.

### E6. Grade vocabulary and the precision headline

Four one-click grades: `supported` (citations establish the claim), `partial` (grounded but imprecise/overstated), `unsupported`, `unclear` (can't judge — excluded from precision denominators). Headline metric is **strict precision** = supported / (supported + partial + unsupported); the full distribution is always shown beside it with its denominator. No composite scores, no partial-credit weighting — with ~20 grades per model, honesty about smallness beats resolution the sample can't support.

### E7. Per-model aggregates; `attempted_model` closes the fallback attribution gap

New repo aggregate (`getBrainModelQualityAggregates()`), grouped by `(model, extraction_version)`: grade distribution + strict precision (from E4), episode counts, fallback rate, and `validation_failed` / `unanchored` issue rates (issues joined via `episode_id`). One schema gap blocks fallback-per-model today: the fallback commit nulls `model` (`episodes.ts:1306`), so **`attempted_model TEXT NULL`** is added to `brain_episodes` via `migrateAdditiveColumns`, stamped with `options.model` on fallback commits from now on. Historical fallback rows aggregate under `unknown` — honest, and the population is small (the brain is barely assimilated post-contract-v2). Fallback rate per model = fallbacks(attempted_model=M) / (episodes(model=M) + fallbacks(attempted_model=M)); no-provider extractive rows (`fallback_reason IS NULL`) are excluded from both sides — they measure configuration, not model quality.

*Why not resolve the model via `brain_runs` or the LLM ledger*: `brain_runs` has no model column, and ledger↔episode correlation is temporal guesswork; one additive column is the truthful join.

### E8. UI: a dedicated `/brain/eval` route; BrainPanel gets one line and a link

Grading is a work surface, not a status readout, so it gets its own lazily-split route (`client-route-architecture` invariant: every surface at its own URL): golden-set summary (version/hash/count, scaffold hint when missing), Run-eval button with busy state, runs table with per-class recall and delta vs baseline, the grading strip (claim text + kind + confidence beside its cited messages' full text — resolved server-side; deleted originals render as tombstones), grade buttons that persist and advance without reload, and the per-model quality table (E7) with sample sizes. `BrainPanel` itself gains only the free interim signal — a per-model fallback-rate line next to the existing validation/media-gap counts — and a link to `/brain/eval`. Grading-sample and grade routes: `GET /api/brain/eval/grading-sample`, `POST /api/brain/eval/grades`; aggregates: `GET /api/brain/eval/aggregates`.

### E9. Gate semantics: baseline runs and a machine verdict

A gate check compares a run against a baseline (explicit run id, default: most recent prior run with the same golden hash): pass iff every class's recall@k meets or exceeds baseline. Exposed as a report section, and `brain-eval --gate` exits non-zero on regression naming the regressed classes and offending queries. `docs/TESTING.md` gains the methodology ("golden-set recall@k per class meets or exceeds the recorded baseline" replaces spot-query phrasing); downstream seeds (#8, #12) already reference the eval delta and need no rewording.

## Risks / Trade-offs

- **[~30 queries and ~20 grades per model are small samples]** → every figure renders with its `n`; strict precision only; the golden set is designed to grow (classes are open vocabulary, runs record the hash so growth is visible as a version change, never silent).
- **[Single human grader, subjective boundaries between `supported`/`partial`]** → grade definitions rendered in the strip itself; `unclear` gives a sanctioned exit; consistency matters more than absolute calibration since the comparison is *between models on the same claims pipeline*.
- **[User runs `brain-eval` against a live server anyway (direct mode bug or race)]** → delegation is the default path and probing is automatic; direct mode's writes are one row inside a 5s `busy_timeout`; worst case is a retryable `SQLITE_BUSY`, never corruption (WAL).
- **[Grades under `extraction_version` 4 age out when the contract bumps]** → by design: aggregates are keyed `(model, extraction_version)`; cross-version rows never blend, and re-grading after a bump is exactly the harness's job.
- **[Golden set lives outside git → no offsite copy]** → it's inside the work dir the user already treats as precious (same disk as the archive); the scaffold + docs say to include `eval/` in whatever backup covers `archive.sqlite`.
- **[UUID-order sampling is stable, so the "next N" after grading is predictable]** → intended: predictability is what makes the sample auditable; ungraded-first ordering keeps the queue moving.

## Migration Plan

Purely additive; no wipe, no `EXTRACTION_VERSION` bump (no contract surface changes — prompts, normalization, and commit semantics untouched apart from stamping `attempted_model` on fallback rows going forward).

1. Two new tables land via `schemaStatements` on next open; `attempted_model` via `migrateAdditiveColumns`.
2. Both wipe paths (`resetBrainData`, `rebuildBrainDerivedTablesIfStale`) are *not* extended — a reset-survival test pins that.
3. Rollback = drop the two tables and ignore the column; nothing else references them.

## Open Questions

- None blocking. (Free-text notes on grades and a second grader identity are deliberately deferred until the single-grader loop has run once on real data.)
