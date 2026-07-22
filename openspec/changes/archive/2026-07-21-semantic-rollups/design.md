# Semantic Rollups — Design

## Context

The semantic tier is unbuilt: the task queue pre-declares `rollup`/`overview`/`project_pages` kinds but the spine executor retires them loudly; the only page generator in the tree is the legacy `memory_*` consolidator (from raw messages, removed by #15). What exists to build on, verified in code 2026-07-20:

- **Claims spine**: `brain_claims` (kind/text/event_at/valid_until/confidence) → `brain_citations` (message keys, "citation labels ARE message keys") → `brain_episodes` (generator `model|extractive`, status incl. `superseded`, `EXTRACTION_VERSION`-stamped). `brain_node_claims` is the entity-view read spine, populated in the commit transaction, cascade-cleaned with claims.
- **Graph**: `brain_nodes` with immutable UNIQUE `slug` (minted as "wikilink and projection currency for semantic-rollups later"), `natural_key`, `status('active'|'dormant'|'merged')` + `merged_into` redirect stubs. `getBrainGraphEntity` already person-aggregates (`personId`, `memberJids`, `memberNodes`, claims across members, `redirected` flag).
- **Lifecycle (#10, §L8 handoff)**: durable `brain_lifecycle_events` keyed by claim id; **one writer** `applyBrainLifecycleTransitions(transitions, {source, runId?, model?})` with collect-all validation and closed-world cite re-checking; `listBrainLifecycleItems` (L6 read); shipped status vocabulary **`open|fulfilled|dismissed`**, transitions **`fulfilled|dismissed|still_open|reopened`** (the design-doc's `cancelled` shipped as `dismissed` — this change embeds the *shipped* contract); sweep prompt/response machinery in `lifecycle.ts` with the `{"resolutions":[{node,status,cites,note?}]}` fragment and mechanical-salvage parsing.
- **Run machinery**: `BrainRunKind` currently `"nightly"|"catchup"|"manual"|"backfill"|"regenerate"|"lifecycle"`; the lifecycle sweep is the precedent — direct chunked loop, per-call `model`/`effort` via `generateStructured`, HIGH effort for consolidation-class judgment, daily ledger caps, per-run `maxModelCalls`/`maxTokens`, mid-run provider-degradation guard (post-mortem 2026-07-19), no fallback.
- **Projection**: episodes project to `config.brain.rootDir/episodes/*.md` with `^claim-N` anchors — page→episode wikilinks with anchors are already addressable. `repairBrainProseForIdentities` repairs episode prose deterministically on identity change.
- **Client**: flat lazy routes (`/brain`, `/brain/eval`, `/brain/commitments`, `/graph`); GraphPage node click re-anchors the ego-graph (no page target yet — #23's deferred integration); citation → thread deep-link machinery exists.

Constraints in force: the **anchoring principle** (2026-07-20 — determinism for recall & verification, never suggestion; strong models anchor harder on injected candidate answers and can't be instructed off them); **iterative-rewrite drift** research (knowledge overwriting, semantic intensification — each regeneration from a prior generation compounds); the **bulk-query-or-wedge lesson** (#10's first surface run: 2m14s from per-node queries + a quadratic entity self-join → 606k pairs; fixed to <1s with set-based queries + composite indexes); manual-first spend; store-references-render-names; breaking-change sanction (additive DDL suffices here); **cost guardrail** — no Sol/Fable-Opus test runs without explicit user authorization; engine must be fully exercisable on stub/Terra/Sonnet.

## Goals / Non-Goals

**Goals:**

- Entity/topic/chat pages consolidated from current model-generated claims by a strong-tier HIGH-effort call, committed as **structured statement revisions** whose markdown is a deterministic render.
- An **exact** regression guard: every claim the prior revision represented is either re-referenced, declared dropped (with machine-readable reason), or mechanically accounted (claim deleted upstream) — undeclared disappearance refuses the revision, keeps the prior current, and records a visible issue.
- Claim-level supersession: declared in revisions (durable truth), projected to `brain_claims.superseded_by_claim_id` (queryable convenience for #12).
- Conflict machinery per the anchoring principle: detector drives input **co-location** (neutral, unlabelled) and **post-write verification** (flag residual contradictions) — never prompt hints.
- Embedded closure: rollup calls carry #10's resolutions fragment verbatim and apply via `applyBrainLifecycleTransitions` in the page-rewrite transaction.
- Deterministic vault projection (pages, overview, stubs, structural wikilinks, `brain project --rebuild`) and a rollback command; identity prose repair extended to statements.
- Manual-first run kind `rollup` with dueness surfaced, budget stops, degradation guard, chunk+yield; all reads/scans set-based and `EXPLAIN QUERY PLAN`-verified on a real-DB copy.
- Routed pages UI completing #23's node click-through, with revision history and rollback.

**Non-Goals:**

- **No monthly episode compression** — deferred out of this change entirely; #12 should first measure whether episode-count noise actually hurts retrieval (measure-then-spend). Episodes are the permanent citation spine regardless.
- **No model-written overview** — the overview is a deterministic L0 projection; a narrative weekly digest is a demand-gated future seed.
- No auto-scheduled rollups in v1 (dueness surfaces; the user triggers spend; `WAPP_BRAIN_SCHEDULER=auto` integration can follow once spend patterns are observed — resolving #10's deferred cadence question as "dueness alerts for both, auto for neither yet").
- No retrieval fusion, page search ranking, or `brain_ask` (#12/#13 consume; this change only writes the substrate and DTOs).
- No page-quality eval-harness extension (episode grading exists; page grading is a future seed if rot is suspected despite the guard).
- No user claim-curation UI (manual supersede/edit of claims) — the user's lever is the lifecycle UI, rollback, and re-rollup; curation is a future seed.

## Decisions

### R1. Pages are structured statements; markdown is a deterministic projection

A doc revision is `statements: [{section, text, claims: [claim_id...]}]` (+ `drops`, + `resolutions`). The renderer — code, not model — produces the markdown: frontmatter, sections, per-statement citation links, Related footer, anchors. The model **never writes the document**.

*Why*: this dissolves the D8 problem rather than patching it. The 30%-threshold guard existed because free-form markdown can only be compared heuristically; statement/claim-ref sets compare **exactly** (R6). It also neutralizes the two documented drift modes of whole-document rewrites — knowledge overwriting (facts silently replaced by model-internal knowledge: statements must reference fed claim ids, closed-world) and format rot (the renderer is deterministic, so prose conventions cannot decay). Label repair becomes free: repair statement text in SQLite, re-render the file (R10). On format-restriction concerns ("Let Me Speak Freely"): the schema is shallow (three fields per statement), the strong tier reasons at HIGH effort *before* emitting, and the rebuttal literature attributes the reported degradation to prompt quality, not structure per se — and our episode/sweep contracts already prove the JSON path on this exact infra. *Alternatives rejected*: model-written markdown page + heuristic diff (the original D8 — rot vector this change exists to kill); NL-then-format two-step (second call per page, drift between the steps, nothing gained — the statements ARE the content).

### R2. Consolidate from claims only — never from prior page prose

The rollup input is the doc's current claim set (R4) plus the prior revision's **claim-ref accounting** (which claims it represented — needed for drop declarations) and a fixed section-skeleton hint per doc kind. The prior revision's *prose never enters the prompt*.

*Why*: iterative-summarization drift compounds per generation ("likes mild spicy" → "loves very spicy"); sourcing every revision from the immutable claim substrate keeps every page exactly **one** generation from ground truth forever. Prose stability across revisions is cosmetic; content fidelity is the product. *Alternative rejected*: prior-page-as-context for tone/structure continuity — the model would anchor on and copy prior prose (the exact compounding this kills); structure continuity comes from the skeleton hint instead.

### R3. Doc identity: 1:1 with graph nodes, keyed by slug; person docs aggregate via membership

Docs: `entity:<slug>` (person-kind nodes), `topic:<slug>`, `chat:<slug>`, plus singleton `overview`. The doc anchors on the node's immutable `slug` (the minted projection currency). Person docs use `getBrainGraphEntity`'s membership aggregation — claims gathered across all member nodes, doc anchored on the person's primary node; membership/merge changes mark affected docs due, and a doc whose node becomes `merged` becomes a redirect stub to the survivor's doc (mirroring node stubs — wikilinks and held URLs never dangle).

**Page population is opt-in by worth, not universal**: a node is page-eligible when it has ≥ `WAPP_BRAIN_ROLLUP_MIN_CLAIMS` (default 5) current model-generated claims; runs process the **due** set ranked by salience, top-K within budget; any eligible node can be rolled on demand. At real-archive scale (3.7k chats, thousands of person nodes) universal pages would be an unbounded strong-tier spend for mostly-empty dossiers.

### R4. Input selection: feed-more; quotas only on overflow; audit persisted

The input query (set-based, one pass per doc): current claims for the doc scope via `brain_node_claims` (person docs: across member nodes) JOIN episodes WHERE `generator='model'` AND episode status current AND claim not superseded (`superseded_by_claim_id IS NULL`). Rendered per claim, injection-fenced (BEGIN/END CLAIMS discipline): prompt-local alias, **episode date range (or min citation timestamp)**, kind + confidence, text, and its citation message keys (the citable currency for resolutions). Claims render **oldest-first** so recency lands last (recency-bias-aligned); statements' section grouping is the model's judgment.

Under `WAPP_BRAIN_ROLLUP_INPUT_TOKENS` (default 24k — ~500+ claims, covering the overwhelming majority of docs whole), **everything goes in**. Only on overflow do tiers apply: (1) open lifecycle items for the doc's scope (from `listBrainLifecycleItems` — they are page content, not hints), (2) conflict co-location pairs (R5), (3) remaining claims by salience-weighted recency with per-time-bucket floors (coverage, not an importance opinion). The revision persists `fed_claim_ids` + input stats (counts, overflow flag, tiers engaged) — the guard's "not fed vs fed-and-dropped" distinction and the audit trail.

*Why feed-more*: pre-selection is a bucket-① lever (an "importance opinion" baked upstream of the model); claims are cheap relative to the strong call's value, and the anchoring principle says determinism serves recall. *Why persisted audit*: exclusion must be distinguishable from model drops or the guard lies.

### R5. Conflict detector: co-location in, verification out — never a hint

One detector, two anchoring-free uses. Definition (per doc, set-based): claim pairs from **different episodes** in the doc scope, same claim kind, sharing ≥1 entity (JID match, or normalized name when both lack JIDs), whose episodes share ≥1 topic or overlap in time — bounded top-M pairs by recency, computed in one bulk query per run batch (the #10 lesson: composite indexes, no quadratic self-joins on popular JIDs — cap per-entity fan-out in SQL, `EXPLAIN QUERY PLAN` gate before ship).

- **In (recall)**: on overflow, tier 2 guarantees both members of each detected pair survive selection. They render as ordinary dated claims — **no conflict label, no pairing markup, no "resolve this"**.
- **Out (verification)**: post-commit, re-run the detector over the revision's *referenced* claims only (both-still-current, neither superseding the other). Hits record `rollup_contradiction` validation issues (warning severity) with both claim ids + the doc — surfaced on the run console and doc page. **Flag-only in v1**: no auto re-roll (the model already saw both co-located and chose to keep both — a re-roll with the same input is spend without new information; a detector false-positive stays a visible, cheap flag; a real contradiction is the user's call via lifecycle/rollback tools).

*Why not prompt hints*: the anchoring evidence — strong models over-adopt injected candidates and mitigation instructions don't work; a mediocre heuristic would corrupt the page from inside the prompt. Both-sides-neutral co-location is exactly the one presentation the anchoring literature found non-distorting.

### R6. Output contract and validation: closed-world refs, mechanical salvage, no fallback

Response JSON: `{sections: [{title, statements: [{text, claims: ["c1",...]}]}], drops: [{claim: "c9", reason: "superseded"|"stale"|"out_of_scope", by?: "c12"}], resolutions: [{node, status, cites, note?}]}` — the resolutions fragment is #10's **verbatim** (aliases, `fulfilled|dismissed|still_open`, cites = message keys offered in *this* input, empty for `still_open`).

Validation mirrors the episode/sweep house pattern: mechanical salvage never consumes the retry (lone-object coercion, comma-joined refs, scalar coercions); **collect-all** errors — unknown claim alias, statement with zero claims, drop of a never-fed claim, `by` not newer than the dropped claim (episode-window comparison), resolution errors from #10's validators — into **one** retry enumerating every error; second failure → run item `failed`, error-severity issue, **prior revision stays current**. **No extractive fallback, by design**: a placeholder *page* would be laundered authority at the semantic tier (worse than the extractive *episodes* it quarantines); absence-with-visible-issue is the honest failure mode, exactly like the sweep.

Commit is one transaction: revision row (+ junction rows for referenced claims) + supersession projection (R7) + `applyBrainLifecycleTransitions(resolutions)` + doc current-pointer flip + file render + validation issues + ledger. The writer re-validates resolutions independently (closed world = this input's message keys) per §L8 — the rollup never trusts its own assembly.

### R7. The exact guard, and supersession as projection

Let `prior` = prior revision's referenced-claim set, `new` = this revision's, `dead` = prior members no longer current in SQLite (episode regenerated/superseded — mechanically annotated `claim_deleted`, never the model's burden). **Rule: `prior − new − dead` must exactly equal the declared `drops` set — any undeclared disappearance refuses the revision** (rejected revision retained with `status='rejected'` + its errors, for audit); any drop of a claim not in `prior` is an error (nothing to drop). No thresholds, no percentages — the D8 heuristic is superseded by exact accounting; both its failure modes (silent small drops, blocked legitimate consolidation) are structurally impossible.

Drops with `reason='superseded'` + `by` write `brain_claims.superseded_by_claim_id = <by>` (ON DELETE SET NULL via the claim's episode cascade). The **revision record is the durable truth**; the column is a re-derivable projection for cheap retrieval predicates (#12's "current claims only" filter) and input exclusion (R4). `reason='stale'`/`'out_of_scope'` drops write no column — but when stale-reason drops exceed `WAPP_BRAIN_ROLLUP_STALE_DROP_SHARE` (default 0.5) of prior refs in one revision, record an info-severity issue: lazy mass-dropping is allowed but never invisible. Regeneration re-keying: when episode regeneration replaces claims, supersession pointers *to* dead claims null out; the next rollup re-derives dispositions from the fresh claim set (the doc goes due via `dead ≠ ∅`) — no repair machinery needed beyond honest re-consolidation.

### R8. Schema (additive DDL only)

```sql
brain_docs (
  doc_id TEXT PRIMARY KEY,            -- 'entity:<slug>' | 'topic:<slug>' | 'chat:<slug>' | 'overview'
  kind TEXT CHECK (kind IN ('entity','topic','chat','overview')),
  node_id TEXT NULL REFERENCES brain_nodes(id),
  slug TEXT NULL,                     -- denormalized projection/file currency
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
  merged_into TEXT NULL,              -- doc_id of survivor when the node merged
  current_revision_id INTEGER NULL,   -- no FK (write-order); revisions carry the doc FK
  last_rollup_at_ms INTEGER NULL,
  created_at_ms INTEGER NOT NULL
)
brain_doc_revisions (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES brain_docs(doc_id),
  revision INTEGER NOT NULL,          -- monotonic per doc
  status TEXT CHECK (status IN ('current','superseded','rejected')),
  sections_json TEXT NOT NULL,        -- statements with claim ids (post-alias-resolution)
  drops_json TEXT NOT NULL,
  fed_claim_ids_json TEXT NOT NULL,   -- the audit: exactly what the call saw
  input_stats_json TEXT NOT NULL,     -- counts, token estimate, overflow flag, tiers engaged
  resolutions_json TEXT NOT NULL,     -- what was applied (event ids), for the trail
  errors_json TEXT NULL,              -- rejected revisions keep their refusal
  model TEXT NULL, effort TEXT NULL, run_id TEXT NULL,
  prompt_version INTEGER NOT NULL,    -- rollup contract version (independent of EXTRACTION_VERSION)
  created_at_ms INTEGER NOT NULL,
  UNIQUE (doc_id, revision)
)
brain_doc_revision_claims (           -- referenced (cited-by-statements) refs only
  revision_id INTEGER NOT NULL REFERENCES brain_doc_revisions(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL,             -- no FK: must survive claim deletion to make docs go due
  PRIMARY KEY (revision_id, claim_id)
) WITHOUT ROWID
ALTER TABLE brain_claims ADD COLUMN superseded_by_claim_id TEXT NULL REFERENCES brain_claims(id) ON DELETE SET NULL
-- indexes: idx_docrev_doc (doc_id, revision DESC); idx_docrevclaims_claim (claim_id);
--          idx_claims_superseded (superseded_by_claim_id) WHERE superseded_by_claim_id IS NOT NULL
```

*Why junction without claim FK*: dangling junction rows are the **dueness signal** for upstream regeneration (R9) — a cascade would erase exactly the evidence that a doc's ground truth moved. *Why fed set as JSON but referenced set as junction*: "which docs cite claim X" must be an index walk (staleness, #12 provenance); "what was fed" is per-revision audit, read whole. Both repositories (sqlite + memory mirror) implement with doc-comment parity, per house pattern.

### R9. Dueness is a read-time set query; runs are direct chunked loops

A doc is **due** when: never rolled and eligible (R3 floor); OR new model-generated claims in scope since `last_rollup_at_ms` ≥ `WAPP_BRAIN_ROLLUP_DUE_NEW_CLAIMS` (default 3); OR any referenced claim died (junction LEFT JOIN claims — the R8 dangle); OR a lifecycle event touched a scope claim since last rollup; OR node/person merge touched the doc. One bulk query computes the due set + counts for all docs (no per-doc probes — the L6 lesson; `EXPLAIN QUERY PLAN` gate on the real-archive copy). Surfaced: Brain page strip (docs due count → link), docs list, run console.

Run kind **`rollup`** joins `BrainRunKind`, mirroring the lifecycle sweep: manual-first trigger from console/CLI with per-run model + effort (default HIGH) + `maxModelCalls`/`maxTokens`; scope = one doc, a doc list, or top-K due by salience (`maxModelCalls` bounds K — an unscoped rollup run is **structurally bounded**, unlike the wedge-class episode runs); one call per doc; per-doc provider-degradation check (stop as named `interrupted`, resumable — dueness recomputes); daily ledger purpose `rollup`; `setImmediate` yields between docs; SSE progress via the existing run console; loud failures. The queue's dead `rollup`/`overview`/`project_pages` task kinds stay retired (dueness-recompute makes queue durability worthless here; enum cleanup noted for #15).

### R10. Deterministic projection, structural links, repair-not-regenerate

Files under `config.brain.rootDir`: `entities/<slug>.md`, `topics/<slug>.md`, `chats/<slug>.md`, `overview.md`; episodes stay in `episodes/`. Render (pure function of SQLite state): frontmatter (doc id, node id, slug, kind, revision, updated, aliases from `brain_node_aliases`, person members for entity docs); sections in model order, statements in stable order (earliest-claim date, then claim id); each statement suffixed with citation links — `[[episodes/<episode-file>#^claim-N]]` per referenced claim plus raw message keys (the deep-link currency) — and `^stmt-<n>` anchors; a deterministic **Related** footer (top co-cited/edge-adjacent nodes with docs, wikilinked by slug) provides the ambient Obsidian graph; merged/rejected-free: merged docs render as one-line stubs pointing at the survivor. **Prose is never parsed for linking** — all wikilinks are structural (from refs and edges), so rendering is total and deterministic. `brain project --rebuild` re-renders every current doc + overview + stubs from SQLite, idempotent, byte-stable (a determinism test asserts render(render-input) is fixed-point stable).

Identity rename/merge repairs statements the same way episodes repair: extend `repairBrainProseForIdentities` to sweep `sections_json` statement text (same substitutable-label discipline — the input claims already carry repair-stamped labels, so statements inherit the same token forms), then re-render affected files. Zero model calls. This is the pages row of the late-binding inventory: anchor = doc revision; stamp = label provenance inherited from claims + `prompt_version`; repair = deterministic prose sweep + re-render.

### R11. Overview is deterministic (zero model calls)

`overview.md` + `GET /api/brain/overview` render entirely from existing reads: top-salience active nodes (linked to their docs where they exist), open/overdue/stale lifecycle counts + soonest-due items (L6), docs-due count, coverage/freshness (watermark stats, last run times, provider health), orphaned-resolution and validation-issue debts. Re-rendered at the end of every rollup/lifecycle/episode run and on `project --rebuild` — always fresh, cannot rot, costs nothing. *Alternative rejected*: model-written overview — spend + rot risk for content that is 100% derivable; the "weekly narrative digest" idea stays a demand-gated future seed (it would be a new doc kind riding this same engine, cheap to add if wanted).

### R12. Read surface and UI: pages complete the graph loop

Endpoints (DTOs carry meaning server-side, per house rules): `GET /api/brain/docs` (list: doc, title via read-time label resolution, dueness, issue counts, revision/updated stamps), `GET /api/brain/docs/:docId` (rendered markdown + structured sections + revision history + issues + input-audit summary), `POST /api/brain/docs/:docId/rollback {toRevision?}` (flip current to prior/named revision + re-render + record an audit issue row), rollup trigger via the existing runs API with `kind:'rollup'`. CLI: `brain docs [list|show|rollback|rollup|project]`.

Client: lazy routes `/brain/pages` (list with due/issue chips, filter by kind) and `/brain/pages/:docId` (rendered page; citation click-through to thread via existing deep links; revision history with per-revision drop/supersession detail; rollback button with confirm; "view in graph" link; "run rollup" for this doc through the console machinery). GraphPage nodes with docs gain "open page" (the #23 handoff); person surfaces link their entity page where one exists. Brain page gets the docs-due strip.

### R13. Model policy: strong-tier consolidation, cheap everything else

Rollup calls default to the persisted provider selection with effort **high**, and the console surfaces the standing recommendation (Sol / Fable-Opus class for rollup runs; never Luna — per the model-selection memory). Everything deterministic in this change (guard, render, dueness, detector, overview, repair, rollback) runs at zero model cost by construction. **Development and tests exercise the engine exclusively via the stub/extractive provider path and cheap tiers (Terra/Sonnet) — Sol/Fable-Opus runs happen only when the user explicitly green-lights each one** (standing cost guardrail, 2026-07-20). The contract is provider-agnostic: nothing in the schema or validation depends on which tier answered, so a cheap-tier dry run is a faithful rehearsal of everything but prose quality.

## Risks / Trade-offs

- **[Model mangles claim aliases at scale (hundreds of refs per call)]** → prompt-local short aliases (the episode/sweep pattern), mechanical salvage for the routine deviations, collect-all + one retry, no-fallback refusal keeps the prior revision; refusal rate is visible per run (issue rows), and if a specific tier proves sloppy the per-call model knob redirects spend.
- **[Pages bloat monotonically if the model hoards claims]** → the drops channel with `stale`/`out_of_scope` reasons makes shedding *legal and recorded*; the stale-share info issue makes mass-shedding *visible*; nothing is ever silently lost (revisions retained, supersession recorded).
- **[Detector false positives annoy via contradiction flags]** → warning severity, doc-scoped, flag-only (no spend, no blocking); tune the topic/time-overlap predicate before widening; false negatives cost nothing (the model still sees co-located claims on overflow and everything on whole-feed docs).
- **[Busy-entity overflow degrades dossier quality]** → 24k default covers the vast majority whole; overflow tiers are coverage-preserving with per-bucket floors; the input audit records exactly what was excluded; the user can raise the budget per run (spend lever stays theirs).
- **[Junction + revisions grow unbounded]** → refs are compact rows; revisions are text-sized and *the* audit/rollback substrate (retention is the feature); if growth ever matters, prune `rejected` revisions older than N days first — noted, not built.
- **[Two writers of lifecycle state (sweep + rollups) drift]** → impossible by construction: one writer function, one validation path, both re-check closed-world cites independently (§L8 honored); a parity test drives both callers over the same fixture.
- **[Statement prose bakes names]** → same discipline as episodes: substitutable labels from input claims, `repairBrainProseForIdentities` extension, deterministic re-render; weekly rewrite cadence bounds any residue.
- **[Dueness/detector queries wedge the live server at archive scale]** → set-based single-pass queries, composite indexes shipped with the DDL, per-entity fan-out caps in SQL, `EXPLAIN QUERY PLAN` verified against a real-DB copy **before** first live run (task-gated), yields between docs in the run loop.
- **[SQLite `ALTER TABLE ADD COLUMN ... REFERENCES` quirks]** → SQLite accepts REFERENCES on ADD COLUMN with NULL default and enforces on new writes only — exactly the projection semantics wanted; the migration is a plain additive statement in both repositories.

## Migration Plan

1. Additive DDL (three tables + indexes + one column); no wipe, no `EXTRACTION_VERSION` bump, no changes to episodes, graph, or lifecycle tables. Existing surfaces unaffected until a rollup run is triggered.
2. Ship engine + projection + UI dark (no docs exist → lists render empty states; overview renders deterministically from day one).
3. First real rollups: user-triggered, scoped (one entity), cheap-tier dry run first, then strong-tier on explicit go — the checkpoint's entity pages come from these runs.
4. Rollback story: `brain rollback` per doc; wholesale, `resetBrainDerivedData` extends to the three doc tables (docs are derived-of-derived; rebuild = re-run rollups, which costs spend and is therefore *not* part of graph rebuild — reset wipes docs only on explicit full reset, same class as episodes).

## Open Questions

- Defaults to calibrate on real data after first runs: `WAPP_BRAIN_ROLLUP_INPUT_TOKENS` (24k), `MIN_CLAIMS` (5), `DUE_NEW_CLAIMS` (3), `STALE_DROP_SHARE` (0.5), top-K due per run.
- Whether topic docs are worth pages at current topic-node quality (vocabulary convergence is prompt-nudged, not enforced) — build the engine kind-generic, gate topic pages on eyeballing real topic nodes; entity + chat pages are the checkpoint.
- Whether `#12` wants statement-level provenance DTOs (statement → claims → citations) beyond the doc DTO — the junction supports it; expose when #12 asks.
