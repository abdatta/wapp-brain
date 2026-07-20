## Context

`knowledge-graph-foundation` (9) shipped the typed substrate and its read surface, but stopped one hop short of the product the user asked for: *see the connections*. What exists today, confirmed in code:

- Five tables in `sqliteRepository.ts` `schemaStatements` (no migrations): `brain_nodes` (11 kinds, `status active|dormant|merged`, read-time-only `salience/citation_count/status`), `brain_edges` (9 kinds, `UNIQUE(src,dst,kind)`, `related_to` normalized `src<dst`), `brain_edge_evidence` (`claim_id | source_message_key | source_ref`, dedup on `evidence_key`), `brain_node_claims`, `brain_node_aliases`. Traversal indexes were laid down *for this change*: `idx_brain_edges_src/dst (node, kind, last_seen_at_ms)` and `idx_brain_nodes_kind_status_salience`.
- A **one-hop** read: `getBrainGraphEntity` (`sqliteRepository.ts:5547-5724`, memory mirror `memoryRepository.ts:4966-5110`) resolves an anchor (following `merged→merged_into` redirect stubs), fans out `brain_edges WHERE src IN(…) OR dst IN(…) … LIMIT 200`, hydrates the far endpoint with read-time labels via `graphNodeRowToRecord`/`graphLabelForNodeRow` (`5511-5545`), and joins claims→`brain_citations` for evidence. Routes live at `server.ts:1111-1189` under `/api/brain/graph/*`.
- Read-time labels resolve through `labelForJid` → `resolveDisplayLabel` (`import/jid.ts:126-141`, saved-name → push-name → +E.164, masked placeholders rejected). **Same-name disambiguation exists** (`persons/disambiguate.ts:27-52`) but the entity endpoint does **not** apply it to edge labels — two distinct "Amit" nodes come back identically labelled today.
- The live archive is fully populated: 16.4k nodes / 58.7k edges / 148k evidence rows / 48k citations; ~12k nodes are dormant. The graph is real, so the explorer is worth building and testable on day one.

The client is Vite 7 + React 19 + React Router v7. Routes are lazy chunks in `routes.tsx`; pages fetch through the hand-rolled `request<T>` wrapper in `api.ts`; thread deep-links go through `lib/deepLinks.ts` `buildChatDeepLink(chatId, at?)` → `/chats/:id?at=<messageId>`, and `ThreadView` scrolls to `[data-mid]`. No graph/visualization library is installed.

Constraints (standing): deterministic-first (zero model calls at view time), store-references-render-names, downstream-consumer-first (meaning is server-side; the visualization is one consumer of a reusable read contract), async-progress for any op ≥~1s, no raw JSON in the UI, and **never render the whole graph** — unscoped reads over the 326k-message archive are a known wedge hazard.

## Goals / Non-Goals

**Goals:**

- A bounded **neighborhood read contract** — the product primitive: anchor + depth ≤2 + edge-kind filter + time window + minimum salience + hard node/edge caps, pure SQL, zero LLM, returning read-time-resolved and same-name-disambiguated labels, per-edge freshness, and truncation disclosed. One repository method, byte-identical across the SQLite CTE and the in-memory BFS (mirror parity).
- An **evidence read** for a single edge — its claims and citations carrying the coordinates (`chatId`, `messageId`) needed to open the thread at the cited message — so the graph inherits the same auditability as every other brain surface.
- A routed, lazily code-split **`/graph` explorer**: anchored ego-graph (Cytoscape.js + fcose), expand-on-click, edge-kind chips, a time-window scrub that fades edges by last evidence, a dormancy toggle (hidden by default), evidence click-through to the thread, and freshness/provenance tooltips per the people-UX conventions.
- **Deep links into the graph** from person, entity, and episode surfaces, plus a nav entry — reload-safe, per `client-navigation`.
- The neighborhood contract shaped for reuse by `brain-retrieval-pipeline` (12) and an optional `mcp-agent-surface` (13) tool wrapper — not built speculatively here, but not foreclosed.

**Non-Goals:**

- No whole-graph render mode; no global layout; no "show everything" escape hatch.
- No graph database — SQLite recursive CTEs at this scale; a separate graph store would trade away the single-file private archive for a query need that does not exist.
- No LLM calls at view time; no new node/edge production, no salience or schema changes (this change is **read-only** over the substrate).
- No Obsidian/vault changes (the ambient wikilink graph rides `semantic-rollups` (11) unchanged).
- No new graph write paths, no WebGL renderer (sigma.js stays the named escape hatch if real neighborhoods outgrow Cytoscape — measured, not speculative).

## Decisions

### E1. One bounded traversal method on the repository; pure shaping in `graphQuery.ts`

`src/server/brain/` holds no SQL by construction (the derivation core `graph.ts` is pure so the two repositories can never fork). The traversal follows that grain: a new `getBrainGraphNeighborhood(params)` on the `ArchiveRepository` interface (`repository.ts`, beside the graph reads at 425-431), implemented as a **recursive CTE** in `sqliteRepository.ts` and an equivalent **BFS** in `memoryRepository.ts`. Both return the same *raw* reachable node rows + connecting edge rows in the same deterministic order; the new pure module `src/server/brain/graphQuery.ts` does everything downstream — param validation/clamping, hop-distance assignment, global cap application, dedup, read-time label + disambiguation pass, and DTO assembly. Meaning lives in one place, so parity is by construction and the SQL/Map layers only have to agree on *which rows*, not on *how they're shaped*. *Alternative rejected*: traversal logic living in `graphQuery.ts` over interface primitives — there is no generic "edges for a node set" primitive today, and hand-rolling one per backend re-introduces the fork this avoids.

### E2. Endpoint path: `/api/brain/graph/neighborhood` (+ `/api/brain/graph/edge`)

The proposal seed wrote `GET /api/graph/neighborhood`; the shipped read surface is firmly `/api/brain/graph/{stats,entity,unresolved,rebuild,recompute}`. Consistency wins over the seed's shorthand: the neighborhood endpoint slots in as `GET /api/brain/graph/neighborhood`, and the edge-evidence read as `GET /api/brain/graph/edge?id=<edgeId>`, both registered in `server.ts` before the SPA fallback, using the existing `stringQuery`/`clampNumber`/`booleanQuery` helpers and the inline `try/catch → publicErrorMessage` idiom. The "same answer serves client, deep path, and MCP" property is a function of the DTO and the repository method, not the URL prefix — nothing about reuse requires a top-level path. *Consequence*: the seed's literal path is not honored; noted so the divergence is deliberate, not drift.

### E3. Neighborhood request/response contract

Request (all but anchor optional): `anchor` (nodeId | jid | name — resolved by the same redirect-following logic as `getBrainGraphEntity`), `depth` (clamped 1–2, default 1), `kinds` (CSV of edge kinds, validated against the allowlist, default all), `since`/`until` (ms, applied to `brain_edges.last_seen_at_ms`), `minSalience` (default 0), `includeDormant` (default false), `maxNodes`/`maxEdges` (clamped to server ceilings, defaults 120/300). Response DTO in `shared/types.ts` (server-side meaning): `anchor` (the resolved node, or a "not found"/"redirected" signal), `nodes[]` (`BrainGraphNodeRecord` + `hop` distance 0..depth), `edges[]` (`{ id, srcId, dstId, kind, weight, evidenceCount, lastSeenAtMs }` — freshness inline so the scrub needs no refetch), `truncated` (bool) with `totalNodes`/`totalEdges` before capping, and `appliedFilters` echoed back. No citation arrays inline (see E5). Edges whose endpoint was dropped by a cap are dropped too; the anchor (hop 0) is never dropped.

### E4. Bounded, deterministic, both-directions traversal

Edges are stored directionally but most kinds are logically undirected and `related_to` is pre-normalized `src<dst`, so the walk must expand **both** `src→dst` and `dst→src` and dedup by edge `id`. The CTE seeds on the resolved anchor id, and at each level joins `brain_edges` on the frontier (either endpoint) with the hard filters pushed down — `kind IN (…)`, `last_seen_at_ms` within window, far-node `status` in the allowed set (`active`, plus `dormant` when `includeDormant`; `merged` always excluded from expansion), far-node `salience >= minSalience` — ordered `evidence_count DESC, last_seen_at_ms DESC, id ASC` with a safety ceiling, so it is an index walk over `idx_brain_edges_src/dst`, never a scan. Depth ≤2 and the filters bound the candidate set; `graphQuery.ts` then keeps the top-`maxNodes` by `(salience DESC, id)` (anchor pinned) and the edges among survivors, setting `truncated` when anything was clipped — an explicit, disclosed cap, never a silent truncation. The memory BFS applies the identical predicates, order, and caps.

### E5. Evidence read is lazy, per-edge, and deep-linkable

Selecting an edge fetches `GET /api/brain/graph/edge?id=` rather than shipping citations for 300 edges up front. It resolves the edge's two endpoint labels (read-time), its kind/weight/freshness, and its evidence via `brain_edge_evidence`: claim-derived rows (`claim:*`) join `brain_claims`→`brain_citations`; message-derived rows (`msg:*`) resolve their `source_message_key` to a citation/message. Each returned citation carries `{ sourceChatId, messageId, sourceMessageKey, timestampMs, claimText? }`. This closes the trust loop *and* the one gap the client audit found: memory-citation resolution today returns message context but no `chatId`/`messageId`, so it cannot jump to a thread — the graph edge read returns those coordinates directly, and the client builds `buildChatDeepLink(sourceChatId, messageId)` → `/chats/:id?at=<messageId>`, reusing the existing `data-mid` scroll-to-message machinery unchanged.

### E6. Read-time labels + same-name disambiguation across the response

Every node label comes from `graphLabelForNodeRow`/`labelForJid` (person → contact/person label, chat → display name, else `title||slug`) at read time, so a contact rename re-labels with **zero** graph writes or regeneration — the checkpoint property. Because a neighborhood can surface two distinct people who both resolve to "Amit", `graphQuery.ts` runs the existing `disambiguateLabels` pass across the whole returned node set (grouping by `personKey`, appending +E.164 / context / stable ordinal only when a label maps to ≥2 distinct persons) — new work the entity endpoint never needed because it renders one subject at a time. Merged nodes are followed by one redirect hop for the anchor and excluded from expansion, so externally-held ids never dangle and merged stubs never appear as neighbors.

### E7. Explorer surface: Cytoscape in a lazy route chunk

New `src/client/pages/graph/GraphPage.tsx` (named export), one `lazy(() => import(...))` line in `routes.tsx`, one `<Route path="graph">`, one `NavRail` entry (`lucide-react` icon). `cytoscape` + `cytoscape-fcose` are new client deps, **dynamically imported inside the page** so they land only in the `/graph` chunk and the main bundle is untouched (a route-lazy page still bundles its static imports into that page's chunk; the dynamic import keeps even that out of the initial paint and gives a clean Suspense/loading seam). Typed edge styling by kind, fcose layout, expand-on-click (clicking a node fetches its neighborhood and merges), edge-kind filter chips, a time-window scrub that recomputes edge opacity from `lastSeenAtMs` client-side (no refetch) and filters when the window excludes an edge, and a dormancy toggle wired to `includeDormant`. Empty state (no anchor) offers a pick box over `unresolved`/entity search and a few top-salience suggested anchors. Freshness lines (`relativeTime`) and provenance live in CSS `tipChip`/`data-tip` tooltips per people-UX; no raw JSON anywhere. Fetches show progress and surface failures as toast + console per the async-progress contract.

### E8. Deep links into the graph

A `/graph?node=<id>` (falling back to `?jid=` / `?name=`) scheme — a small helper beside `deepLinks.ts` — is reload-safe and shareable. "View in graph" affordances land on the person surface (PeoplePage, by jid), the entity surface (BrainPage's graph section / entity view, by node id), and the episode surface (anchoring on the episode's chat node, which every episode has). Client-navigation gains the route and these links.

### E9. Read-only change: no substrate writes, no wipe

This change adds two read endpoints, one repository read method (both impls), pure shaping/CLI, and a client page. It writes nothing to the substrate, changes no schema, needs no `EXTRACTION_VERSION` bump and no data wipe. Rollback is deleting the route handlers and the page. The one non-code footprint is two new npm deps (`cytoscape`, `cytoscape-fcose`).

### E10. CLI twin for headless verification and parity

A `brain graph neighborhood --anchor <…> [--depth --kinds --since --until --min-salience --include-dormant --max-nodes --max-edges]` subcommand (beside the existing `brain graph …` twins) prints a compact neighborhood summary. It exercises the exact repository method the route uses, so the endpoint can be verified without a browser and the CLI/HTTP paths can't diverge.

## Risks / Trade-offs

- **[A hub anchor (a busy chat, or `jid=me`) at depth 2 explodes the candidate set before caps apply]** → hard filters (kind/time/salience/status) are pushed into the CTE/BFS with a per-query safety ceiling *inside* the walk, so the bounded set is produced by the index walk, not materialized-then-trimmed; caps in `graphQuery.ts` are the final, disclosed clip. The busiest real anchors are the explicit verification target.
- **[CTE and BFS silently diverge on ordering, tie-breaks, or a filter edge case]** → both return raw rows only; all shaping is the single shared `graphQuery.ts`; every scenario runs under the `withRepos` harness asserting identical DTOs (the mirror-parity gate). Deterministic total order (`… , id ASC`) removes tie-break ambiguity.
- **[Cytoscape + fcose bloat the bundle]** → dynamic import confines them to the `/graph` chunk; main bundle unchanged, verified by the build output. WebGL/sigma.js remains the named, unbuilt escape hatch.
- **[Same-name disambiguation misfires — over-suffdaimixing distinct-but-same-person, or under-suffixing true collisions]** → reuse the shipped `disambiguateLabels`/`personKeysSync` (same behavior the people surfaces already trust), applied only within a single response; tested with a two-distinct-"Amit" neighborhood.
- **[Time-scrub semantics ambiguous — does an edge "exist" in a past window?]** → the scrub filters/fades on `edges.last_seen_at_ms` (the field the traversal already carries and indexes); a past window shows edges whose last evidence falls at or before it. Documented; `first_seen` band interpretation deferred (Open Questions).
- **[Deep-linking an edge's citation needs a chat id the memory-citation path lacks]** → the edge read derives `chatId`/`messageId` from `brain_citations` directly (E5), sidestepping the gap rather than widening the memory-citation DTO.

## Migration Plan

1. Ship server (read method both repos + `graphQuery.ts` + two routes + DTOs + CLI) and client (page + route + nav + api wrappers + deep links) together; two additive npm deps.
2. No data step — the substrate is already populated; the endpoint is live the moment the server restarts. If a target archive has an empty graph, the existing `brain graph rebuild` (deterministic, zero LLM) fills it; not part of this change.
3. Rollback: remove the two routes, the repository method, the page/route/nav, and the two deps. Nothing else reads them (the #12/#13 consumers land later and are additive).

## Open Questions

- Expand-on-click merge policy: cap the accumulated on-screen graph (and evict lowest-salience when it grows) or re-anchor outright? Start with a soft on-screen ceiling + "re-anchor here" action; tune once real neighborhoods are on screen.
- Time-scrub band semantics beyond `last_seen` (should an edge fade *in* only within `[first_seen, last_seen]`?) — deferred until the scrub is used against real archives.
- Whether the neighborhood DTO should carry a coarse per-node degree hint (for "there's more beyond the cap" affordances) — deferred; `truncated` + totals cover the honest-truncation requirement for v1.
