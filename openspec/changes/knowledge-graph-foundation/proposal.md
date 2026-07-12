# Knowledge Graph Foundation

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

Episodes now emit identity-anchored entities and topics (episode-contract-v2), and persons exist as editable groupings over identities (two-level-person-model) — but nothing yet turns those into the queryable graph the semantic tier and retrieval boosts depend on. This change builds the node/edge substrate: typed nodes upserted from claim entities in the episode commit transaction, person-level aggregation views, and the salience/dormancy model — amended per the review so that dormancy is kind-aware (an open commitment must never go dormant just because its chat went quiet).

## What Changes

- **Node substrate**: typed nodes (`person`, `chat`, `topic`, `event`, `commitment`, `fact`) with `payload_json`, stable ids, immutable slugs; identity-kind anchors join to the person layer via membership, not merges.
- **Edge substrate**: typed weighted edges (`participates_in`, `mentions`, `about`, `involves`, `derived_from`, `related_to`, `alias_of`, plus `resolves` reserved for the commitment lifecycle) with first/last-seen.
- **Commit integration**: episode commits upsert nodes/edges from `brain_claim_entities` and topic links in the same transaction as claims/citations/watermark — completing the D5 commit shape.
- **Person aggregation**: entity-scoped queries aggregate identity-anchored data to the person level through `person_members` at read time (or via a maintained rollup view) — connect/disconnect re-derives these without touching episodes.
- **Salience + kind-aware dormancy**: the D6 salience formula recomputed on schedule, with the review's amendment — commitment/question nodes with open status are exempt from dormancy and gain due-date proximity boosts; dormancy hides, never deletes.
- **Deterministic claim-entity backpressure**: entities that failed pack-local resolution surface as unresolved text entities linked for later suggestion — never global name matches.
- **Checkpoint**: after assimilating a few chats, `brain_nodes/edges` populate from claim entities; an entity query returns the person-aggregated node with its claims; disconnecting a person membership re-derives the aggregation with zero episode changes; a quiet chat's open commitment node survives a salience recompute.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: Knowledge Graph Maintenance implemented per the amended design — commit-transaction upserts from claim entities, kind-aware dormancy, person aggregation via membership.
- `person-identity-model`: gains the graph-facing aggregation contract (person-level reads over identity-anchored nodes).

## Impact

- **Schema**: `brain_nodes`, `brain_edges`, `brain_aliases`, salience columns, indexes for entity-path and graph-traversal queries.
- **Code**: `src/server/brain/graph.ts` (upserts, salience recompute job), commit-transaction extension in the repository + mirror.
- **Docs**: design.md D6 finalized (two-level person integration, kind-aware dormancy, `resolves` reserved).
- **Tests**: commit upserts, aggregation through membership, dormancy exemptions, slug immutability, unresolved-entity backpressure.
- **Depends on**: `episode-contract-v2` (claim entities/topics exist), `two-level-person-model` (person aggregation level).
