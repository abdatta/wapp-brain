# Brain Retrieval Pipeline

> Proposal-level seed (2026-07-11; premises re-verified against the codebase 2026-07-16). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Fable.**

## Why

The progressive-disclosure read path (L0 overview → L1 pages → L2 episodes → L3 exact messages) is the brain's product surface, and the review found its plan underspecified exactly where it would fail: raw BM25 scores fused across corpora are not comparable (one table can structurally bury the pre-digested layers), the deep path's trigger ("when fast results are weak") names no predicate and its expansion-to-FTS construction is undefined, coverage metadata is raw numbers requiring judgment that weak consumers won't exercise, and there is no cross-chat time axis ("summarize my week" has no one-call path) nor entity-scoped claim enumeration ("everything about E" caps at a 1.5k-token page for every model tier). This change implements retrieval with those decisions pinned.

## What Changes

- **Layered fast path (<300ms, no LLM)**: per-layer sections (pages / episode-claims / messages) with independent within-corpus BM25 rankings and per-layer caps, digest-first — eliminating cross-corpus score comparability by shape rather than by normalization; Reciprocal Rank Fusion only where genuine fusion is needed; inherits `retrieval-hardening`'s relaxation ladder and `matchTier` labels.
- **Coverage as a verdict**: server-computed completeness (`full | partial | mostly_unassimilated`) plus a pre-rendered `gaps` array of human sentences ("Family group not yet assimilated after Jun 20"); per-hit coverage on episode-layer items; scope defined mechanically (explicit filters ∪ chats producing doc-layer hits), sidestepping free-text scope inference.
- **Deep path, pinned**: weakness as a checkable predicate (fewer than K hits above a floor score, or no doc-layer hit) surfaced in the DTO; expansion as one FTS query per term (capped ~8) fused by RRF so one bad term degrades gracefully; cache keyed on normalized term sets; expansion learnings persisted into `brain_term_aliases`; ≤2-hop spreading activation over edges; synthesis optional and citation-validated, with results persisted as labelled query artifacts instead of discarded.
- **Timeline route**: `GET /api/brain/timeline` with `{from, to, scope?}` — episodes-in-window grouped by day then chat, claims filtered to decision/commitment/event kinds, token-capped with overflow markers, coverage-qualified; `listBrainEpisodes` gains time bounds.
- **Claims route**: `/api/brain/claims?node=&kind=&after=&before=` with cursor pagination — the deterministic "everything about E, distilled and cited" enumeration for strong models and for rollup input paging.
- **Read-time naming**: all entity/chat names in results render from current nodes/chats (with same-name disambiguators), never from stored prose.
- **UI**: the brain query panel over these routes (layer navigation, citations opening the thread view at the hit).
- **Checkpoint**: a paraphrase query with zero keyword overlap recovers content in deep mode with the predicate visible; a query over a half-assimilated scope returns the verdict and gap sentences; "summarize my week" is one timeline call; the eval harness records the recall delta.

## Capabilities

### New Capabilities

- `brain-retrieval`: created as a main spec here (none exists — `build-the-brain` never synced one) with the pinned design — sectioned layer results, RRF-only fusion, coverage verdicts with rendered gaps, deep-path predicate/construction/caching, timeline and claims routes, synthesis persistence, read-time naming — absorbing the L0 open-commitment semantics pinned by `commitment-lifecycle` (10).

## Impact

- **Schema**: `brain_docs_fts`, `brain_query_cache` (normalized keys), query-artifact storage.
- **Code**: `src/server/brain/retrieval.ts`, `/api/brain/query|timeline|claims|overview|pages|episodes|citations` routes, client brain panel query UI.
- **Docs**: the D7 rewrite recorded in this change's own design.md (the archived `build-the-brain` design.md is a frozen baseline); brain-retrieval spec scenarios written fresh (zero-hit, verdict, timeline, claims).
- **Tests**: cross-layer ranking (page surfaces above message flood), verdict/gap rendering for lagging watermarks, deep predicate, per-term RRF, timeline grouping/caps, claims pagination.
- **Depends on**: `semantic-rollups` (docs to search), `knowledge-graph-foundation` (graph boosts/traversal), `retrieval-hardening` (shared FTS layer).
