# Brain Eval Harness — Tasks

## 1. Substrate: schema, attempted-model stamp, golden set

- [x] 1.1 Add `brain_eval_runs` and `brain_claim_grades` to `schemaStatements` (`src/server/db/sqliteRepository.ts`) with indexes `(golden_hash, ran_at_ms)` / `(model, extraction_version)` per design E4; mirror the structures in `memoryRepository.ts`; do NOT extend `resetBrainData` or `rebuildBrainDerivedTablesIfStale`
- [x] 1.2 Add `attempted_model TEXT NULL` to `brain_episodes` via `migrateAdditiveColumns`; plumb through `commitBrainEpisode` input on both backends; stamp `options.model` on the extractive-fallback commit in `generateEpisodeForPack` (`src/server/brain/episodes.ts` fallback path) — model episodes and no-provider extractive rows keep it NULL
- [x] 1.3 Golden-set module in `src/server/brain/eval.ts`: load + validate + sha256-hash `<WAPP_WORK_DIR>/eval/golden-queries.json` (shape per design E1, open class vocabulary); scaffold-and-refuse when missing; synthetic example at `fixtures/eval/golden-queries.example.json` doubling as test fixture
- [x] 1.4 Tests (both backends): eval tables exist after open and survive `resetBrainData` + a simulated stale rebuild; `attempted_model` stamped on fallback only; golden load/scaffold round-trip and hash change on edit

## 2. Eval runner, persistence, gate

- [x] 2.1 Repo methods on the `ArchiveRepository` interface + both impls: `insertBrainEvalRun`, `listBrainEvalRuns({ goldenHash?, limit? })`, `getBrainEvalRun(id)`
- [x] 2.2 Runner in `eval.ts`: execute every golden query through `repository.searchMessages` (limit = max K, K = {5,10,20}); per-query recall@k with found/missing keys + ranks; invalid-expectation quarantine (never a retrieval miss); per-class/overall means carrying `n`; yield between queries; refuse with the `search:reindex` hint when FTS isn't ready; zero model calls by construction
- [x] 2.3 Gate computation: delta vs baseline (explicit run id, default latest same-hash run); pass/fail verdict naming regressed classes and offending queries; cross-hash comparisons labelled, never silently mixed
- [x] 2.4 Tests: recall math against the synthetic fixture with known answers on a seeded temp DB (+ `rebuildSearchIndex`) and the memory backend; two identical runs produce identical results; deleted expected message → invalid-expectation; gate pass and regression verdicts

## 3. Routes, grading sample, aggregates, CLI

- [x] 3.1 Routes in `src/server/server.ts`: `POST /api/brain/eval/runs` (synchronous, returns the completed run), `GET /api/brain/eval/runs` + `/:id`, `GET /api/brain/eval/grading-sample`, `POST /api/brain/eval/grades`, `GET /api/brain/eval/aggregates`
- [x] 3.2 `listClaimsForGrading({ perModel, includeGraded })` on both repos per design E5: `current` + `generator='model'` episodes only, stratified per model, ungraded-first, claim-UUID order; grading-sample route resolves cited messages' full text server-side (tombstone line for deleted originals)
- [x] 3.3 Grade write path: `upsertBrainClaimGrade` (INSERT OR REPLACE on `claim_id`) with stamps denormalized server-side from the claim's episode (grade enum per design E6) — client sends only `{claimId, grade}`
- [x] 3.4 `getBrainModelQualityAggregates()` per `(model, extraction_version)`: grade distribution + strict precision, episode counts, fallback rate with the `unknown` bucket for historical rows, `validation_failed`/`unanchored` rates via `episode_id` joins; every figure carries its denominator
- [x] 3.5 CLI `brain-eval` in `src/server/cli.ts` + `brain:eval` npm script: probe the configured server port → delegate over HTTP, else open the repo directly and run the same module (design E3); prints per-class table + delta; `--gate [--baseline <id>]` exits non-zero on regression
- [x] 3.6 Tests: route-level grading round-trip (persist, overwrite on regrade, stamps never trusted from client); sampling determinism + superseded exclusion across regeneration; aggregates math incl. fallback attribution and unknown bucket; CLI probe/delegate decision unit-tested

## 4. Client: /brain/eval surface + BrainPanel signal line

- [x] 4.1 New lazy route `brain/eval` in `src/client/routes.tsx` + page under `src/client/pages/brain/`: golden summary (version/hash/count or scaffold hint), Run-eval button with busy state, runs table with per-class recall@k and delta vs baseline
- [x] 4.2 Grading strip: claim text/kind/confidence beside its cited messages' full text; four grade buttons with inline definitions; persist-and-advance without reload; per-model progress ("12/20 graded · terra · v4")
- [x] 4.3 Per-model quality table on the eval page (precision, distribution, fallback + issue rates, all with `n`); `BrainPanel` gains the per-model fallback-rate line next to validation/media-gap counts and a link to `/brain/eval`
- [x] 4.4 Typecheck + client build green; UI states degrade to explanatory empties (no golden set, no runs, no grades, no model episodes yet)

## 5. Docs, verification, phase gates

- [x] 5.1 `docs/TESTING.md`: eval methodology section — golden-set location/versioning/backup note, recall@k definition, baseline-gate phrasing ("recall@k per class meets or exceeds the recorded baseline"), grading rubric; confirm #8/#12 seed gate phrasing needs no rewording (design E9)
- [x] 5.2 Full suite (`vitest run`) + typecheck + build; fix fallout
- [x] 5.3 Real-archive verification: `brain:eval` delegated (server up) and direct (server down) produce the same report; grade a real claim end-to-end from `/brain/eval`; reset-survival spot check on a DB copy
- [x] 5.4 PHASE GATE (user): golden set + first baseline eval ran on the real archive (starter set of 15 real queries across the five classes at `.wapp-brain/eval/golden-queries.json`, v1 hash `2e789432de43be23`; extendable toward ~30 — paraphrase class currently 0% recall, the retrieval-hardening #8 signal)
- [x] 5.5 PHASE GATE (user): graded on the real archive — Terra 30/30 claims (86.7% precision, 0% fallback) and Sonnet 20/24 (100% precision, 12.5% fallback) across per-model recall/precision/fallback tables
- [x] 5.6 PHASE GATE (user): backfill model chosen — **codex `gpt-5.6-terra`** for reliability (0% vs Sonnet's 12.5% fallback); baseline run `7ca7c08a-87e0-4789-81ec-c515eb8f9dbc`; no-silent-fallback requirement recorded in `historical-backfill`'s proposal (unblocks its contract-before-spend gate)
- [x] 5.7 `npm run roadmap:sync`; when the gates pass, `/opsx:archive` the change
