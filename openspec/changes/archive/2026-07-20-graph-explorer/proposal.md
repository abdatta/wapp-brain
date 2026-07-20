# Graph Explorer

> Proposal-level seed (2026-07-17). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

`knowledge-graph-foundation` (9) builds the typed node/edge substrate — persons, chats, topics, events, commitments, places, with citations, event-time, and kind-aware salience — but plans no human lens over it. The existing lenses cannot carry that weight: the Obsidian vault projection (`semantic-rollups` 11) renders untyped wikilinks with no time axis and no evidence click-through, and the people/evidence surfaces show one entity at a time. What's missing is the view the user actually asked for: *see the connections* — people, relations, events, places — as an interactive graph. The architectural commitments, decided here so the expansion doesn't relitigate them: never render the whole graph (anchored neighborhoods only — global hairballs are demo-ware, and unscoped reads over a 326k-message archive are a known wedge hazard); time is a first-class control, not a buried filter; every edge is auditable down to its citing messages or it's a rumor; the same server-side answer serves the client, the deep path, and MCP agents (downstream-consumer principle) — the visualization is just one consumer.

## What Changes

- **Neighborhood endpoint (the product primitive)**: `GET /api/graph/neighborhood` — anchor node (or JID/person id), depth ≤2, edge-kind filter, time window, minimum salience, hard node/edge caps. Pure SQL (recursive CTE over `brain_nodes`/`brain_edges`), zero LLM. Labels resolve at read time through the identity/person layer with same-name disambiguators (store references, render names — renames just work), and every edge carries its citation refs. One endpoint, three consumers: this UI, `brain-retrieval-pipeline` (12)'s spreading activation (shared bounded-traversal layer), and an optional `mcp-agent-surface` (13) tool wrapper.
- **Explorer surface**: a routed `/graph` page (per `client-route-architecture`) plus deep links from person, entity, and episode surfaces ("view in graph"). Anchored ego-graph with expand-on-click, edge-kind filter chips, and a time-window scrub that fades edges by last evidence; dormant nodes hidden by default with an explicit toggle (dormancy hides, never deletes). No raw JSON anywhere; tooltips carry freshness and provenance per the people-UX conventions.
- **Evidence click-through**: selecting an edge opens its claims and citations; a citation opens the thread view at the exact message via the existing deep-link machinery. This is the trust loop — the graph inherits the same auditability as every other brain surface.
- **Rendering**: Cytoscape.js (typed edge styling, fcose layout) in a lazy-loaded route chunk so the main bundle is untouched. WebGL (sigma.js) is the named escape hatch if real neighborhoods outgrow it — not built speculatively.
- **Non-goals (explicit)**: no whole-graph render mode; no graph database (SQLite CTEs at this scale — a separate graph store would trade away the single-file private archive for zero query need); no LLM calls at view time; no Obsidian changes (the vault's ambient graph rides 11's wikilink projection unchanged).
- **Checkpoint**: anchor on a person → typed 2-hop neighborhood with live-resolved labels; scrub to a past window → the visible edge set changes accordingly; click an edge → its citations open the thread at the cited message; a renamed contact re-labels without any regeneration; a dormant node stays hidden until toggled; a 2-hop query on the real archive returns within the interactive budget with caps enforced.

## Capabilities

### New Capabilities

- `brain-graph-explorer`: the bounded neighborhood read contract (anchor/depth/kinds/time/salience/caps, read-time labels, citation refs) and the interactive explorer surface over it (time scrub, evidence click-through, dormancy toggle).

### Modified Capabilities

- `client-navigation`: gains the `/graph` route and graph deep links from person/entity/episode surfaces.

## Impact

- **Schema**: none — consumes `brain_nodes`/`brain_edges`/`brain_aliases` and the traversal indexes from `knowledge-graph-foundation` (9).
- **Code**: `src/server/brain/graphQuery.ts` (neighborhood CTE + DTO) + route; `src/client/pages/graph/` (Cytoscape page, lazy chunk); new client dependency `cytoscape` (+ fcose layout).
- **Tests**: neighborhood bounds/caps and depth limits, kind/time/salience filtering, read-time label resolution incl. rename behavior, citation joins, dormancy default-hidden, mirror parity for the query layer.
- **Depends on**: `knowledge-graph-foundation` (9) hard — the substrate; `client-route-architecture` (19) landed. Soft: `semantic-rollups` (11) entity pages as node click-through targets; `historical-backfill` (14) — the view gets more interesting as coverage climbs (measure-then-spend applies to UI too). Consumed by: `brain-retrieval-pipeline` (12) may share the traversal layer; `mcp-agent-surface` (13) may wrap the endpoint as a `brain_graph` tool.
