## Context

Episodes commit with identity-anchored claim entities (`brain_claim_entities.jid` = canonical JID when pack-local resolution matched, NULL otherwise), structured topics, temporal fields, and signal anchors — but nothing turns them into the queryable semantic substrate. The D6 baseline (archived `build-the-brain` design) specified the graph; three later changes amended its premises: `two-level-person-model` replaced person hard-merges with membership aggregation, `reply-quote-recovery` landed `message_quoted_snapshots.quoted_source_message_id` and deferred edge creation here, and `archive-signal-capture` landed authoritative structural sources (`message_mentions` with `source_mask & 2`, `group_membership_periods/events`, `message_locations`, `message_vcards.resolved_jid`, `engagement_aggregates`) plus the `brain_episode_signal_anchors` reverse index.

Integration points confirmed in code: the atomic episode commit is `commitBrainEpisode` (`src/server/db/sqliteRepository.ts:3097`, mirrored in `memoryRepository.ts`); runs finalize in `src/server/brain/runJob.ts`; `resetBrainDerivedData` defines what a brain wipe covers; `mergeIdentity` already reconciles derived brain state transactionally. Downstream consumers pin the read shape: `graph-explorer` (23) needs bounded k-hop neighborhood queries with read-time labels; `brain-retrieval-pipeline` (12) needs graph-proximity boosts; `commitment-lifecycle` (10) needs open commitment/question nodes and the reserved `resolves` edge.

Constraints: deterministic-first (zero model calls anywhere in this change), store-references-render-names, under-merge-beats-over-merge, better-sqlite3 single-writer synchronous (chunk + yield), breaking-change sanction active (graph tables are derived-of-derived and wipeable by construction).

## Goals / Non-Goals

**Goals:**

- Typed node/edge substrate populated from claim entities, topics, and lifecycle-bearing claims in the same transaction as the episode commit — completing the D5 commit shape.
- Deterministic enrichment from captured archive signals (mentions, membership, vCards, locations, replies) with per-row provenance down to claims/messages.
- Person-level aggregation resolved through `person_members` at read time; connect/disconnect re-derives with zero graph writes.
- D6 salience with the review's amendment: kind-aware dormancy (open commitments/questions never go dormant), due-date proximity boost, optional engagement factor for person nodes.
- Rebuild determinism: the whole graph re-derives from committed episodes + signal tables with zero model calls; incremental state and a from-scratch rebuild converge to the same graph.
- Read paths and indexes shaped for bounded traversal (the #23/#12 contract), plus a minimal entity/stats/unresolved read surface to verify the checkpoint.

**Non-Goals:**

- No explorer UI, no neighborhood endpoint (`graph-explorer` 23); this change ships indexes and an entity-scoped read, not the k-hop CTE product surface.
- No lifecycle transitions (`commitment-lifecycle` 10): commitment/question nodes are born `open` in payload; `resolves` stays a reserved edge kind with no producer.
- No LLM adjudication of duplicate entities (`merge_adjudicate` stays an unused task kind), no embeddings, no rollup pages (11), no Markdown projection of graph state.
- No new brain task kinds; rebuild/recompute are chunked synchronous jobs, not queued work.

## Decisions

### G1. Schema: five tables, natural-key idempotency

- `brain_nodes(id TEXT PK uuid, kind, natural_key TEXT UNIQUE, slug TEXT UNIQUE, title TEXT NULL, jid TEXT NULL, chat_scope TEXT NULL, payload_json TEXT NULL, status TEXT 'active'|'dormant'|'merged', merged_into TEXT NULL, salience REAL 0, citation_count INTEGER 0, evidence_days INTEGER 0, first_seen_at_ms, last_seen_at_ms, created_at, updated_at)`.
- `brain_edges(id INTEGER PK, src_node_id, dst_node_id, kind, weight REAL 0, evidence_count INTEGER 0, first_seen_at_ms, last_seen_at_ms, updated_at, UNIQUE(src_node_id, dst_node_id, kind))`.
- `brain_edge_evidence(edge_id, claim_id NULL, source_message_key NULL, source_ref NULL, observed_at_ms NULL, UNIQUE(edge_id, evidence_key))` where `evidence_key` is a stored text column (claim id, message key, or signal ref) making re-application a no-op.
- `brain_node_claims(node_id, claim_id, PRIMARY KEY(node_id, claim_id))` — the node→claims join the entity query and salience recompute read; populated in the commit transaction.
- `brain_node_aliases(node_id, alias, source, created_at, UNIQUE(node_id, alias))` — observed surface forms (extracted entity names that resolved to a node whose title differs); fuel for future adjudication and search, never resolution input.

*Why natural keys*: commit-time upserts and full rebuild must be idempotent under retries, regeneration, and merges. Natural keys: `person:jid:<canonical>`, `person:name:<chat>:<slug>` (unresolved), `org|place|project:<slug>` (global), `other:<chat>:<slug>`, `chat:<chat_source_id>`, `topic:<topic_id>`, `commitment|question|event:<claim_id>`. *Alternative rejected*: content-hash ids (opaque, breaks slug immutability guarantees) and rowid-only identity (no idempotency).

### G2. Node kind vocabulary: lean producers, reserved room

Kinds in the CHECK constraint: `person`, `chat`, `topic`, `org`, `place`, `project`, `other`, `commitment`, `question`, `event`, `fact`. v1 producers emit all except `fact` — facts stay claims (the episodic tier already serves them; a per-fact node duplicates `brain_claims` row-for-row). `fact` stays in the vocabulary for `semantic-rollups` (11), which may promote durable facts. Claim-derived nodes are created only for lifecycle-bearing kinds: one node per `commitment`/`question` claim (payload `{holderJid?, dueMs?, status:'open'}` — holder = first person entity with a JID, due = valid_until else event_at) and per `event` claim with an `event_at_ms` (payload `{eventAtMs}`). *Why*: D6's insight (promises are first-class queryables) without the graph-first design's 11-kind sprawl of populated kinds; decisions/facts without lifecycle don't need node identity to be queryable.

### G3. Unresolved person entities are chat-scoped, never global

A person entity with NULL jid becomes `person:name:<chat_source_id>:<name-slug>` — one node per (chat, name), not per name. *Why*: a global "amit" node silently merges different humans (the exact failure `never global name matches` forbids); chat scope is the conservative unit inside which a repeated bare name overwhelmingly refers to the same person. These nodes are the deterministic backpressure surface: listable, ranked, and linked to their claims for later suggestion producers — resolution happens only through the person layer's certainty-graded sources, never here. Non-person entity kinds (`org`, `place`, `project`) key globally by normalized name (an org name is its identity); `other` stays chat-scoped (too vague to merge globally).

### G4. Commit integration: graph upserts inside the episode transaction

`commitBrainEpisode` gains a graph section (same `db.transaction`), so D5's commit shape is finally complete: episode + claims + citations + entities + topics + stamps + **nodes/edges** + watermark, atomically. Per committed episode it upserts:

- Chat node; person nodes for JID-anchored entities and pack participants; entity nodes per G3; topic nodes for the episode's topics; commitment/question/event nodes per G2.
- `participates_in` (person→chat) for participants and citing senders; `mentions` (person→person) from `message_mentions` rows (`source_mask & 2`) on pack messages; `about` (entity→topic) for each claim entity × episode topic; `involves` (claim-node→entity) for lifecycle nodes; `related_to` (entity↔entity, src<dst normalized) for entity pairs co-occurring in one claim; `replies_to` (person→commitment/question node) when a pack message's quoted snapshot points at a message cited by an existing lifecycle node — the deferred #21 edge, feeding #10's `resolves` derivation.
- `brain_node_claims` rows for every node touched by a claim; `brain_edge_evidence` with claim/message provenance; alias rows when an extracted name differs from the node title.

Extractive episodes contribute **no** graph writes (Extractive Claims Never Consolidate applies one tier down: placeholder claims must not mint semantic nodes; regeneration upgrades them and the graph section runs then). Regeneration commits (`advanceWatermark:false`, supersede) run graph upserts normally — natural keys make re-application converge, and superseded episodes' claim-derived rows are removed by the same transaction (their claims cascade away with the superseded episode's replacement? No — superseded episodes keep claims; see G5 scope rule). Scope rule: graph derivation reads only `current` model episodes; the supersede step deletes the old episode's `brain_node_claims`/lifecycle nodes/edge evidence before the replacement's upserts land, in the same transaction. *Why in-transaction*: a crash can never leave an episode whose entities are missing from the graph; *alternative rejected*: post-commit async upserts (drift window, second writer ordering).

### G5. Rebuild and signal sync are deterministic replays

`rebuildBrainGraph()`: wipe graph tables → replay the commit-time upsert over every `current` model episode (chunked, `setImmediate` yields, progress counts) → run signal sync → recompute salience. Zero model calls; converges to the same graph as incremental operation (tested). This is also the backfill answer for episodes committed before this change: one rebuild covers them — no `EXTRACTION_VERSION` bump, since episode content is untouched. `syncBrainGraphSignals()` (idempotent, chunked) derives non-message-scoped signals: `group_membership_periods` → `participates_in` with `first/last_seen` from `joined/left_at_ms`; `message_vcards.resolved_jid` → person node + `mentions` edge (sharer→subject, `source_ref` = vcard key); `identity_number_changes` → alias/evidence on the surviving person node; `engagement_aggregates` → per-person engagement factor input (G6). `resetBrainDerivedData` wipes graph tables alongside episodes (derived-of-derived). *Why replay-over-log*: one code path produces the graph in both modes — no second derivation to drift.

### G6. Salience: D6 formula, kind-aware dormancy, bounded engagement factor

Per node, recomputed from evidence (never incremented blindly): `citations` = distinct citation rows across `brain_node_claims` joined claims plus edge-evidence rows touching the node; `evidence_days` = distinct UTC days of those timestamps; `last_evidence` = max timestamp. `salience = log(1+citations) × log(1+evidence_days) × exp(-days_since_last_evidence/90) × engagement_factor`, engagement_factor ∈ [1.0, 1.25] for person nodes from read-rate/latency aggregates (1.0 when absent). Dormancy: `salience < WAPP_BRAIN_SALIENCE_DORMANT` (default 0.25) flips `active→dormant` (and back), **except** commitment/question nodes with payload `status='open'` — never dormant, and boosted `×(1 + max(0, 1 − |due − now|/14d))` when a due date is within two weeks. Dormant hides from ranked/default surfaces only; direct lookup and search still return the node; nothing is deleted. Recompute runs at the end of every completed brain run (`runJob.ts` finalize), after rebuild/sync, and on demand (CLI/API) — manual-first: no new standalone schedule. *Why recompute-from-evidence*: incremental counters drift under regeneration/supersession; the recompute is pure indexed SQL and chunked. Default threshold rationale: a fresh single-citation node scores ≈0.48 (visible); untouched for ~2 months it decays below 0.25 (dormant); recurring entities stay comfortably above.

### G7. Person aggregation: read-time membership resolution, no cache

Entity reads resolve person scope live: query node by jid → `person_members` → member JIDs → union their `person:jid:*` nodes → aggregate claims (`brain_node_claims`), edges, and salience stats over the set. Connect/disconnect therefore requires **zero** graph writes and re-derives instantly (the Person Aggregation Via Membership requirement, extended to the graph). No maintained rollup view until measured need. *Why*: membership edits are metadata-only by spec; a cached aggregate is a re-derivation liability with no read-frequency justification yet.

### G8. Identity merge rekeys graph nodes with redirect stubs

`mergeIdentity`'s existing brain reconciliation gains graph statements (same transaction): the LID node's claims junctions, aliases, and edges re-point onto the canonical-JID node (edge duplicates merge by `(src,dst,kind)`, evidence accumulates); the LID node becomes `status='merged', merged_into=<survivor>` so externally-held node ids and future wikilinks never dangle; reads follow at most one redirect hop. Slugs are immutable from birth (collision → short-hash suffix at creation); titles are never load-bearing — person labels resolve at read time via contacts/persons, so renames re-label with zero regeneration.

### G9. Read surface now, traversal contract for later

Routes (plus CLI twins under `brain graph …`): `GET /api/brain/graph/stats` (counts by kind/status/edge kind, last recompute); `GET /api/brain/graph/entity?jid=|name=|nodeId=` (node → person-aggregated claims with citations, 1-hop edges with read-time labels); `GET /api/brain/graph/unresolved` (chat-scoped unresolved person nodes ranked by salience); `POST /api/brain/graph/rebuild|recompute` (chunked jobs, progress + honest errors). All DTOs in `shared/types.ts`, meaning server-side. Indexes serve the #23/#12 shape — `(src_node_id, kind, last_seen_at_ms)`, `(dst_node_id, kind, last_seen_at_ms)` on edges; `(kind, status, salience DESC)`, `jid`, `natural_key`, `slug` on nodes — so bounded k-hop with kind/time/salience filters and hard caps is an index walk, not a scan. No whole-graph read exists on any surface. A small Brain-panel strip shows the stat DTO with rebuild/recompute controls (async progress, failures visible per the observability contract) — the full explorer stays #23.

### G10. Placement and parity

`src/server/brain/graph.ts` owns pure derivation helpers (natural keys, slugs, salience math, payload builders) shared by both repositories; `sqliteRepository` owns the transactional SQL (commit section, sync, rebuild, recompute, reads); `memoryRepository` mirrors every method over its structures for the test parity the suite depends on. Repository interface gains the graph methods with the same doc-comment conventions.

## Risks / Trade-offs

- **[Claim-derived node volume at archive scale (every commitment/question/event claim mints a node)]** → bounded kinds only (G2), dormancy hides stale ones, natural keys dedupe regenerated claims' predecessors via the G4 supersede scope rule; #14's density gates bound claims per pack.
- **[Chat-scoped unresolved nodes fragment one human across chats]** → intentional under-merge; the backpressure surface ranks them for the person layer's future suggestion producers; person-layer connects (not graph writes) are the only consolidation path.
- **[Graph/claims drift if any write path forgets the graph]** → single in-transaction producer (G4) + rebuild-equals-incremental determinism test + `resetBrainDerivedData` wipes both.
- **[Salience recompute cost growth]** → pure indexed SQL over junctions, chunked with yields; measured in tests at current scale; if it outgrows the run-end hook, it moves behind a task kind (schema change sanctioned).
- **[`payload_json` shape drift across changes 10/11]** → typed builders/parsers in `graph.ts` are the only writers; payloads carry no version field yet (YAGNI under the wipe sanction).
- **[Engagement factor rewarding noisy chats]** → bounded multiplier (≤1.25), person nodes only, documented as display-rank input never a truth signal.

## Migration Plan

1. Additive DDL (five tables + indexes) — no existing table changes; schema-additivity tests pass on real archives.
2. Ship code; existing assimilated chats get graph coverage via one manual `brain graph rebuild` (UI button/CLI) — deterministic, no model spend, no episode changes, no `EXTRACTION_VERSION` bump.
3. Rollback: drop the five tables; nothing outside this change reads them yet (#23/#12/#10 land later).

## Open Questions

- Place-node identity for coordinate-only locations (no name): skipped in v1 — revisit when location-heavy chats matter to retrieval.
- Engagement factor calibration (read-rate vs latency weighting) — shipped conservative; tune with #14's dashboard data.
- Whether `related_to` should decay separately from node salience (edge-level dormancy) — deferred until #23 renders real neighborhoods.
