# Graph Explorer — Tasks

## 1. Neighborhood read contract (the server primitive)

- [x] 1.1 Add neighborhood DTOs to `src/shared/types.ts`: `BrainGraphNeighborhoodParams` (anchor {nodeId|jid|name}, depth, kinds[], since/until, minSalience, includeDormant, maxNodes, maxEdges), `BrainGraphNeighborhoodNode` (`BrainGraphNodeRecord` + `hop`), `BrainGraphNeighborhoodEdge` (`id, srcId, dstId, kind, weight, evidenceCount, lastSeenAtMs`), and `BrainGraphNeighborhoodView` (anchor resolution, `nodes[]`, `edges[]`, `truncated`, `totalNodes`, `totalEdges`, `appliedFilters`) — meaning server-side per the downstream-consumer principle
- [x] 1.2 Create `src/server/brain/graphQuery.ts` (pure, zero DB/model): param validation + clamping (depth 1–2, cap ceilings, edge-kind allowlist against `GRAPH_EDGE_KINDS`, window sanity), hop-distance assignment, global cap application (keep top-`maxNodes` by salience with anchor pinned, drop orphaned edges, set `truncated`), dedup by edge id, and the `disambiguateLabels` pass across the returned node set (via `personKeysSync`) — the single shared shaping both repos feed into (design E1/E4/E6)
- [x] 1.3 Add `getBrainGraphNeighborhood(params)` to the `ArchiveRepository` interface (`src/server/db/repository.ts`, beside the graph reads ~425-431) with the same doc-comment conventions
- [x] 1.4 Implement the SQLite traversal in `sqliteRepository.ts`: recursive CTE seeded on the redirect-resolved anchor (reuse the `getBrainGraphEntity` anchor-resolution + `merged→merged_into` follow), expanding both `src→dst` and `dst→src`, pushing kind/time-window/salience/status filters into the walk, deterministic order (`evidence_count DESC, last_seen_at_ms DESC, id ASC`) with a per-query safety ceiling; return raw reachable node rows + connecting edge rows to `graphQuery.ts` for shaping; reuse `graphNodeRowToRecord`/`graphLabelForNodeRow` for read-time labels
- [x] 1.5 Implement the equivalent BFS in `memoryRepository.ts` over the graph Maps — identical predicates, ordering, and returned raw rows so shaping produces byte-identical DTOs (mirror parity by construction)
- [x] 1.6 Register `GET /api/brain/graph/neighborhood` in `server.ts` (before the SPA fallback), parsing params with `stringQuery`/`clampNumber`/`booleanQuery`, 400 on missing anchor, 404 on unresolved anchor, `try/catch → publicErrorMessage` per the house idiom
- [x] 1.7 Add the `getBrainGraphNeighborhood(...)` wrapper to client `src/client/api.ts` following the `request<T>` convention (also add the missing `getBrainGraphEntity`/`listUnresolvedBrainGraphEntities` wrappers the `/graph` page will need)

## 2. Edge evidence read + CLI twin

- [x] 2.1 Add `getBrainGraphEdgeEvidence(edgeId)` to the interface + both repos: resolve endpoint labels (read-time), kind/weight/freshness, and evidence via `brain_edge_evidence` — claim-derived rows join `brain_claims`→`brain_citations`; message-derived rows resolve `source_message_key`; each citation carries `{ sourceChatId, messageId, sourceMessageKey, timestampMs, claimText? }` (design E5). DTO `BrainGraphEdgeEvidenceView` in `shared/types.ts`
- [x] 2.2 Register `GET /api/brain/graph/edge?id=` in `server.ts` (404 on unknown edge) and add its `api.ts` wrapper
- [x] 2.3 Add the `brain graph neighborhood --anchor <…> [--depth --kinds --since --until --min-salience --include-dormant --max-nodes --max-edges]` CLI subcommand beside the existing `brain graph …` twins, printing a compact summary over the same repository method (design E10)

## 3. Query-layer tests (mirror parity)

- [x] 3.1 Create `tests/graph-explorer.test.ts` on the `withRepos` harness (seed via `seedChat` + `commitBrainEpisode`) — every scenario runs against both SQLite and memory backends
- [x] 3.2 Bounds & shape: depth-1 vs depth-2 reachability, hop distances, anchor always present at hop 0, both-directions traversal (anchor as dst, and a normalized `related_to` pair), each edge once
- [x] 3.3 Filters: edge-kind restriction, time-window on `last_seen_at_ms`, `minSalience`, `includeDormant` default-hidden then revealed
- [x] 3.4 Caps & truncation: node/edge caps enforced, anchor pinned, orphaned edges dropped, `truncated` + pre-cap totals reported, deterministic top-salience selection
- [x] 3.5 Labels: read-time resolution, rename re-labels with zero graph writes, merged node excluded as neighbor / anchor redirect followed, two distinct same-name persons disambiguated (and same-person nodes not disambiguated against each other)
- [x] 3.6 Edge evidence: claim-derived and message-derived citations both resolve, each carrying chat id + message id; parity across backends
- [x] 3.7 Mirror parity assertion: identical anchor/nodes/edges/hops/labels/truncation/totals from both backends for the same seeded inputs

## 4. Explorer surface (client `/graph`)

- [x] 4.1 Add `cytoscape` + `cytoscape-fcose` to `package.json`; scaffold `src/client/pages/graph/GraphPage.tsx` (named export) with the page conventions (local state, fetch-in-effect, loading/error + toast); add the `lazy(...)` line + `<Route path="graph">` to `routes.tsx` and a `NavRail` entry (lucide icon)
- [x] 4.2 Render the ego-graph with Cytoscape **dynamically imported inside the page** (keeps it in the `/graph` chunk, main bundle untouched): fcose layout, typed edge styling by kind, node labels + kind glyphs; empty state offers an anchor pick box (over entity/unresolved search) and a few top-salience suggested anchors
- [x] 4.3 Controls: edge-kind filter chips, dormancy toggle (default hidden → `includeDormant`), and a time-window scrub that recomputes edge opacity from `lastSeenAtMs` client-side and hides edges outside the window (no refetch); depth control (1–2)
- [x] 4.4 Expand-on-click: selecting a node fetches its neighborhood and merges into the on-screen graph (with a soft on-screen ceiling + "re-anchor here" action per design Open Questions); freshness (`relativeTime`) + provenance via `tipChip`/`data-tip` tooltips; no raw JSON; reads show progress and surface failures as toast + console

## 5. Evidence click-through, deep links in, nav

- [x] 5.1 Edge selection panel: fetch `getBrainGraphEdgeEvidence`, render claims + citations as labelled rows (no raw JSON), each citation activatable
- [x] 5.2 Citation → thread: activating a citation calls `buildChatDeepLink(sourceChatId, messageId)` → navigate to `/chats/:id?at=<messageId>`, reusing the `data-mid` scroll-to-message machinery
- [x] 5.3 Deep links into the graph: a `/graph?node=|jid=|name=` helper beside `deepLinks.ts`; "view in graph" affordances on PeoplePage (by jid), the BrainPage graph section/entity view (by node id), and brain episode cards (anchor on the episode's chat node); reload-safe cold-load anchoring in `GraphPage`

## 6. Verification & closeout

- [x] 6.1 Full suite (`npm test`) + `tsc -p tsconfig.json` typecheck + `vite build`; confirm the build output keeps `cytoscape` in the `/graph` chunk, not the main bundle; fix fallout
- [x] 6.2 Real-archive verification (server on 3600, client on 5900): neighborhood of a busy person anchor at depth 2 returns within the interactive budget with caps enforced and `truncated` honest; CLI twin agrees with the HTTP response
- [x] 6.3 Browser-driven checkpoint: anchor on a person → typed 2-hop neighborhood with live-resolved labels; scrub to a past window → visible edge set changes; click an edge → citations → thread opens at the cited message; rename a contact → node re-labels with no regeneration; dormant node stays hidden until toggled; browser console clean
- [x] 6.4 `npm run roadmap:sync`; confirm the `brain-retrieval-pipeline` (12) and `mcp-agent-surface` (13) seeds still describe the neighborhood contract accurately as the shared traversal primitive / `brain_graph` wrapper target

## 7. Checkpoint feedback: graph UX (2026-07-20)

- [x] 7.1 Client declutter (no server restart): fullscreen button; node-kind filter chips with claim kinds (event/commitment/question) hidden by default so the graph reads people-and-things first; fcose spacing loosened (repulsion/edge-length/separation); status shows shown-vs-total
- [x] 7.2 Identity collapse in the neighborhood (`graphQuery.collapsePersonIdentities`): person nodes sharing a `person_id` (person_members) merge into one representative — anchor pinned as its own rep, edges rewired onto reps, intra-person self-loops dropped, parallel edges deduped; connect/disconnect re-derive at read time with zero graph writes. Verified on the real archive: 0 same-person duplicates across 135 person nodes, 35 multi-identity people shown once
- [x] 7.3 Tests: collapse round-trip (connect → one node → disconnect → two) + anchor-stays-representative, both repo backends; full suite green (478)

## 8. Checkpoint feedback: layout, hover, entity dedup (2026-07-20)

- [x] 8.1 Layout spread + clustering (client): fcose retuned (nodeRepulsion 70k, idealEdgeLength 230, nodeSeparation 320, proof quality) so densely-connected groups form emergent visual clusters; open at a readable 0.6 zoom centred on the anchor and let the graph OVERFLOW the canvas (pan/drag/zoom to traverse) rather than fit-to-cram; nodes sized by salience; labels hide when zoomed out (min-zoomed-font-size)
- [x] 8.2 Hover hints (client): node tooltip (label, kind, salience, link count) and edge tooltip (endpoints, relation, evidence count); fixed a crash when a hover fired without a pointer position; fullscreen button retained
- [x] 8.3 Generic entity dedup beyond linked identities (`graphQuery.collapsePersonIdentities`): fold an unresolved chat-scoped `person:name` node onto the resolved person of its DM when the written name aligns with any of that person's identity labels — conservative (DM scope + name overlap), deterministic, read-time; tested both backends. Known limit: a name matching a linked alias that isn't co-present, and cross-kind mis-classifications (project/other), still need a full resolution pass

## 9. Checkpoint feedback: DM-chat fold, alias-fold, fit, spacing (2026-07-20)

- [x] 9.1 DM-chat fold (`graphQuery`): a 1-on-1 chat node folds onto its counterparty person (source_chat_id = the person's JID, not `@g.us`), so "X participates in X (their DM)" collapses to one X; group chats and the anchor are never folded. Verified on the real archive: 0 self-referential edges, 0 unfolded DM chats
- [x] 9.2 Alias-fold extension (both repos + `graphQuery`): the walk now carries `personAliasesByJid` (every linked identity's label per person, off-screen ones included), so an unresolved written name folds onto a person whose matching name is a linked alias ("Misti" → linked "Misti AI"), not only the DM number's own label; tested both backends
- [x] 9.3 Layout + controls (client): fcose pushed harder (repulsion 100k, edge 280, separation 400) → overlap-free spread (~3060×1940, min gap > node diameter), opens at a readable zoom centred on the anchor and overflows for panning; added a fit-to-view button beside fullscreen; node/edge hover tooltips

## 10. Checkpoint feedback: owner unification, spacing control (2026-07-20)

- [x] 10.1 Owner unification (both repos + `graphQuery`): using the archive owner config (`owner_display_name` + `owner_self_jids`, expanded to every linked identity), fold the synthetic "me" marker, the owner's self-number people, the owner's own DM chats, and exact mentions of the owner's name into ONE "Me" node — generic (config-driven), read-time. Verified on the real archive: anchored on "Me", no separate "Me US (Mint)" person/chat, 0 stray "Abhishek" mentions, one jid=me node. Tested both backends
- [x] 10.2 Explained the identity fragmentation (synthetic owner marker vs self-number person vs unresolved name-mentions) and why only linked identities had merged before
- [x] 10.3 Layout: topics hidden by default (a hub links to dozens — they crowd the centre; toggle back via Show); a user-driven **Spread** control (0.6×–3.4×) that re-runs fcose live, so spacing is dial-to-taste instead of a fixed guess; nodes open zoomed-in on the anchor and overflow for panning

- [x] 10.4 Fixed a hover bug: the `mouseout` selector `"node edge"` was invalid (Cytoscape needs a comma), so hovered edges/nodes stayed bold permanently; now `"node, edge"` + clear-all on mouseout/pan/zoom. Verified in-browser

## 11. Checkpoint feedback: community detection (2026-07-20)

- [x] 11.1 Client-side Louvain (single-level) community detection over the neighbourhood edges, run on the graph MINUS the anchor (a hub blurs communities); deterministic ordering. Behind a "Group communities" toggle
- [x] 11.2 Only real communities (3+ members) become tinted compound boxes (fcose lays them out apart and packs each); nodes tied only to the hub stay loose. Verified on the real archive: 9 boxes incl. the UCLA cluster grouped automatically; toggle on/off restores the free layout; node-tap/hover survive the compounds; console clean
- [x] 11.3 Fixed the hover-stays-bold bug (invalid `"node edge"` mouseout selector → `"node, edge"` + clear-all)

## 12. Checkpoint feedback: community tint, orphan cleanup, defaults (2026-07-20)

- [x] 12.1 Community grouping ON by default with nodes **tinted by community** (loose acquaintances grey); compound boxes are now invisible by default (the tint shows the grouping) with an opt-in "Boxes" toggle to draw them. "Communities" toggle off → colour-by-kind + free layout. Verified on the real archive (9 communities, tint + box toggles work, console clean)
- [x] 12.2 Topics excluded from community membership (conceptual, not social actors; they'd pull unrelated people together) — communities are people/chats/orgs/places/projects
- [x] 12.3 Default Spread set to 1×
- [x] 12.4 Drop nodes orphaned from the anchor: hiding a kind (e.g. topics) could leave nodes linked only through it floating as disconnected islands (the "Mitul Gada / LilacBuds" side-pair); the render now keeps only the anchor's connected component. Verified: 0 disconnected nodes

## 13. Anchor-by-name resolves to the resolved person (2026-07-20)

- [x] 13.1 `?name=` now prefers a RESOLVED person whose read-time label (contact display name) matches, before the stored-title/alias match — people carry no stored title, so name-anchoring used to skip the real person and land on an unresolved same-name mention (`?name=Swati` → a `person:name:…` node in a different chat, ≠ `?jid=…`). Both repos; tested both backends. Verified on the real archive: `?name=Swati` and `?jid=919883015080…` now resolve to the identical `person:jid:…` node

## 14. Anchor by typeahead over real nodes, not free text (2026-07-20)

- [x] 14.1 New server contract `searchBrainGraphNodes(query, limit)` + `GET /api/brain/graph/search`: substring match on each kind's read-time label source — persons on contact name (with a title fallback so unresolved name-nodes still surface), chats on chat name, everything else on title — salience-ranked, claim-ish kinds and merged stubs excluded, each result carrying a stable node id. Mirrored in both repos (SQLite + memory) with parity
- [x] 14.2 Kind-scoped matching: a node is matched only by ITS OWN label source, never by the chat it is scoped to — fixes a leak where e.g. a topic inside a chat named "Swati" surfaced for the query "swati"
- [x] 14.3 Client: replaced the free-text "Anchor by number or name" box with an `AnchorSearch` combobox (debounced, stale-response-guarded, keyboard nav, colour-dot + kind + phone-tail disambiguator). You can only anchor by PICKING a suggestion — there is no free-text submit — so the anchor is always an exact node id. Present in both the header and the empty state
- [x] 14.4 Tests: +5 in tests/graph-explorer.test.ts (person/org/chat match, same-name disambiguation, claim-kind exclusion, picked-id anchors the neighborhood, blank-query + backend parity) — 25 total, both backends. Verified in-browser on the real archive: `swati` → resolved person `919883015080` first + same-named chat/unresolved variants each selectable; `zzznotarealnode` → "No matching nodes" and Enter does not anchor; debounce collapses keystrokes to one request per query; no console errors

## 15. Explorer refinements: dropdown, DM dedup, defaults, colours (2026-07-20)

- [x] 15.1 Anchor dropdown no longer clipped: the menu is `position: fixed`, positioned from the input's viewport rect (escaping the graph canvas wrapper's `overflow: hidden`) and height-capped to the space below the input so it fits the viewport and scrolls internally. Verified in-browser (empty-state menu bottom 824 ≤ viewport 832, scrollable)
- [x] 15.2 Search excludes DM (1:1) chats — a direct chat folds onto its counterparty person in the neighborhood, so offering both "X (person)" and "X (chat)" was a duplicate. Only group chats (`@g.us`) surface as chat suggestions; the person is always reachable by name. Both repos + a test; verified on the real archive (`swati` no longer returns the "Swati" DM chat, group chats still surface)
- [x] 15.3 Default depth is now 1 hop (was 2)
- [x] 15.4 Nodes are ALWAYS coloured by type (kind); community grouping only clusters members spatially (+ optional boxes) and no longer tints nodes — so colour always reads as the entity type and matches the legend. Verified in-browser (each kind → exactly one colour)
- [x] 15.5 488 tests pass (46 files), typecheck clean, `openspec validate --strict` valid, no console errors
