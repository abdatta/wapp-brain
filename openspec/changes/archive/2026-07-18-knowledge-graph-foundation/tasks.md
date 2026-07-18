## 1. Schema, types, and pure helpers

- [x] 1.1 Add the five graph tables + traversal indexes to the DDL (`brain_nodes`, `brain_edges`, `brain_edge_evidence`, `brain_node_claims`, `brain_node_aliases`) per design G1/G9
- [x] 1.2 Add graph DTOs to `src/shared/types.ts` and the graph method signatures to the `Repository` interface
- [x] 1.3 Create `src/server/brain/graph.ts`: natural-key/slug derivation (immutable, hash-suffix on collision), salience math with kind-aware dormancy + due boost, payload builders/parsers

## 2. Commit integration and lifecycle hooks

- [x] 2.1 Extend `commitBrainEpisode` (SQLite) with the in-transaction graph section: nodes, edges, junctions, evidence from model episodes; extractive episodes write nothing; supersede removes the old episode's contribution first
- [x] 2.2 Mirror the commit graph section in `memoryRepository`
- [x] 2.3 Extend `mergeIdentity` reconciliation with graph rekey: re-point junctions/aliases/edges, merge duplicates, leave a `merged` redirect stub (both repos)
- [x] 2.4 Extend `resetBrainDerivedData` to wipe graph tables (both repos)

## 3. Sync, rebuild, and salience jobs

- [x] 3.1 Implement `syncBrainGraphSignals`: membership periods → `participates_in`, resolved vCards → person node + `mentions`, number-changes → alias evidence, engagement aggregates → bounded person factor (both repos, idempotent, chunked)
- [x] 3.2 Implement `rebuildBrainGraph`: wipe + chunked replay over current model episodes + signal sync + recompute, with progress counts (both repos)
- [x] 3.3 Implement `recomputeBrainGraphSalience`: evidence-derived stats, dormancy flip both directions, open commitment/question exemption + due-proximity boost (both repos)
- [x] 3.4 Hook salience recompute into brain run completion in `runJob.ts`

## 4. Read surface

- [x] 4.1 Implement graph reads: stats by kind/status, entity view (person-aggregated at read time, claims + citations + 1-hop labelled edges, redirect-following), unresolved backpressure list (both repos)
- [x] 4.2 Add API routes (`/api/brain/graph/stats|entity|unresolved|rebuild|recompute`) and `brain graph …` CLI subcommands with honest error surfacing
- [x] 4.3 Add the Brain panel knowledge-graph strip: stat counts, rebuild/recompute controls with async progress and visible failures

## 5. Tests

- [x] 5.1 Commit upserts: atomicity, entity/topic/chat nodes, lifecycle nodes (holder/due/open), `mentions`/`about`/`involves`/`related_to`/`replies_to` edges, extractive-no-write
- [x] 5.2 Idempotency and convergence: double-apply no-op, regeneration supersede scope rule, rebuild-equals-incremental determinism
- [x] 5.3 Salience: formula from evidence, dormancy threshold both directions, open-commitment exemption on a quiet chat, due-soon boost, dormant stays readable
- [x] 5.4 Person layer: aggregation via membership, connect widens / disconnect narrows with zero graph writes, no person-id keys in graph tables, unresolved chat-scoped backpressure, merge rekey + redirect + slug immutability
- [x] 5.5 Hygiene: reset wipes graph, schema additivity on existing archives, SQLite/memory mirror parity across graph methods

## 6. Verification gate (real archive + fixture server)

- [x] 6.1 `brain graph rebuild` on the real archive: nodes/edges populate from existing claim entities with zero model calls; episode/claim/citation/watermark counts byte-identical before/after
- [x] 6.2 Entity query returns the person-aggregated node with claims; disconnect on a fixture server re-derives the aggregation with zero episode changes
- [x] 6.3 Quiet-chat open commitment node survives a salience recompute (fixture)
- [x] 6.4 Brain panel strip renders stats; rebuild/recompute run with visible progress and surface failures; browser console clean
