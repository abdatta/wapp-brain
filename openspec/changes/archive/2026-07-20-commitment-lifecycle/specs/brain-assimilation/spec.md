# brain-assimilation Delta Spec

## MODIFIED Requirements

### Requirement: Knowledge Graph Substrate
The brain SHALL maintain a typed knowledge graph in dedicated tables — nodes, edges, edge evidence, node-claim junctions, and node aliases — as derived-of-derived state rebuildable from committed episodes, captured archive signals, and durable lifecycle transition events with zero model calls. Nodes SHALL carry a kind from the vocabulary (`person`, `chat`, `topic`, `org`, `place`, `project`, `other`, `commitment`, `question`, `event`, `fact`), a unique natural key making every producer idempotent, an immutable slug assigned at creation, a status (`active`, `dormant`, `merged`), and a payload for kind-specific fields. Edges SHALL be typed (`participates_in`, `mentions`, `about`, `involves`, `related_to`, `replies_to`, `derived_from`, `alias_of`, and `resolves` produced by the commitment lifecycle as a projection of cited transition events), unique per (source, destination, kind), weighted by accumulated evidence, and stamped with first/last-seen times. Every edge SHALL be traceable to its evidence (claim ids, source message keys, or signal references); no edge SHALL exist without at least one evidence row. Person-kind nodes SHALL key on canonical JID when identity-anchored; titles SHALL never be load-bearing — person labels resolve at read time so renames re-label with zero regeneration.

#### Scenario: Nodes and edges populate from claim entities
- **WHEN** episodes with JID-anchored and topic-linked claims have committed for a few chats
- **THEN** `brain_nodes` contains person, chat, and topic nodes with stable natural keys and slugs, and `brain_edges` contains typed edges each carrying at least one evidence row resolvable to claims or messages

#### Scenario: Upserts are idempotent under replay
- **WHEN** the same episode's graph derivation is applied twice (retry, regeneration, or rebuild)
- **THEN** no duplicate nodes or edges are created and evidence rows do not double-count

#### Scenario: Renamed contact re-labels at read time
- **WHEN** a contact whose identity anchors a person node is renamed
- **THEN** graph reads resolve the new label with no node, edge, or episode writes

#### Scenario: Resolves edge carries transition evidence
- **WHEN** a commitment node is closed by a cited transition
- **THEN** the projected `resolves` edge from the resolver's person node to the commitment node carries the cited message keys as evidence rows, like any other evidenced edge

### Requirement: Graph Commit Integration
Committing a model-generated episode SHALL upsert its graph contribution in the same transaction as the episode, claims, citations, entities, topics, stamps, and watermark advance: entity nodes (person entities keyed by canonical JID when anchored), chat and topic nodes, one node per commitment and question claim (payload status `open`, holder and due derived from the claim) and per event claim with an event time, and the deterministic edges — `participates_in` (participants and citing senders to the chat), `mentions` (authoritative structured mentions on pack messages), `about` (claim entities to episode topics), `involves` (lifecycle nodes to their claim's entities), `related_to` (entity pairs co-occurring in one claim), and `replies_to` (replier to an existing lifecycle node when a pack message's quoted snapshot targets a message that node's claim cites). Extractive episodes SHALL contribute no graph writes. When a regeneration supersedes an episode, the superseded episode's node-claim junctions, lifecycle nodes, and edge evidence SHALL be removed in the same transaction that commits the replacement's contribution, so the graph always derives from current model episodes only; in that same transaction, lifecycle transition events keyed to a superseded lifecycle claim SHALL re-key onto the replacement claim when exactly one same-kind lifecycle claim among the replacement episodes shares at least one citation message key with the superseded claim, and otherwise SHALL be marked orphaned rather than deleted.

#### Scenario: Commit is atomic including the graph
- **WHEN** an episode commit transaction fails at any point
- **THEN** no partial graph state exists for that episode; when it succeeds, its nodes, edges, junctions, and evidence are all present

#### Scenario: Extractive fallback mints no semantic nodes
- **WHEN** a pack falls back to an extractive episode
- **THEN** no graph rows are written for it, and a later model regeneration of that window contributes the graph rows

#### Scenario: Open commitment node born from a commitment claim
- **WHEN** a claim of kind `commitment` with a person entity and a validity horizon commits
- **THEN** a commitment node exists with payload status `open`, holder set to the entity's JID, due set from the claim, and an `involves` edge to the holder's person node

#### Scenario: Reply to a cited message links the lifecycle node
- **WHEN** a later pack contains a reply whose quoted snapshot points at a message cited by an existing open commitment node
- **THEN** the commit upserts a `replies_to` edge from the replier's person node to that commitment node with the reply message as evidence

#### Scenario: Superseded episode's contribution is replaced
- **WHEN** regeneration supersedes an episode whose claims minted lifecycle nodes and edge evidence
- **THEN** the replacement commit removes the superseded contribution and applies its own in one transaction, with no orphaned junctions or evidence remaining

#### Scenario: Superseded closure re-keys or orphans in the same transaction
- **WHEN** regeneration supersedes an episode whose closed commitment claim has lifecycle transition events
- **THEN** the same transaction re-keys the events onto the unique citation-sharing replacement claim, or marks them orphaned when no unambiguous replacement exists, never leaving events silently attached to a claim that is no longer current

### Requirement: Graph Rebuild Determinism
The brain SHALL provide a rebuild that wipes graph tables and re-derives the entire graph from current model episodes and captured signals — chunked, yielding, progress-reporting, zero model calls — and SHALL then re-apply the lifecycle state projection: folding durable transition events per current lifecycle claim onto node payloads and re-deriving `resolves` edges from event citations, still with zero model calls. A from-scratch rebuild SHALL converge to the same graph as incremental commit-time operation over the same committed state, including folded lifecycle statuses and projected edges. Brain derived-data resets SHALL wipe graph tables and lifecycle transition events alongside episodes. Rebuild SHALL NOT require an extraction-version bump and SHALL NOT modify episodes, claims, citations, watermarks, or lifecycle transition events.

#### Scenario: Rebuild equals incremental
- **WHEN** the graph built incrementally by episode commits is compared with a wipe-and-rebuild over the same episodes and signals
- **THEN** both contain the same nodes (by natural key), edges (by endpoints and kind), and evidence counts

#### Scenario: Pre-existing episodes gain graph coverage
- **WHEN** rebuild runs on an archive whose episodes were committed before the graph existed
- **THEN** those episodes' entities populate the graph with no model calls and no episode writes

#### Scenario: Brain reset covers the graph
- **WHEN** brain derived data is reset
- **THEN** graph tables and lifecycle transition events are emptied in the same operation and the next assimilation or rebuild repopulates them

#### Scenario: Rebuild preserves closed statuses
- **WHEN** a rebuild replays episodes whose lifecycle claims carry recorded transition events
- **THEN** the re-minted nodes fold to their recorded statuses with `resolves` edges re-derived from event citations, and no closed commitment silently reopens

### Requirement: Graph Salience And Kind-Aware Dormancy
Every node SHALL carry a salience recomputed from evidence — never incremented blindly — as `log(1+citations) × log(1+evidence_days) × exp(−days_since_last_evidence/90)`, where citations and distinct evidence days derive from the node's claim citations and edge evidence; person nodes MAY additionally carry a bounded engagement factor (at most 1.25×). Nodes whose salience falls below the configured dormancy threshold SHALL become `dormant` and SHALL return to `active` when evidence revives them; dormant nodes SHALL be hidden from ranked and default surfaces but SHALL remain directly readable and searchable — dormancy hides, never deletes. Commitment and question nodes whose projected lifecycle status folds to `open` SHALL be exempt from dormancy regardless of salience and SHALL receive a due-date proximity boost when due within two weeks; nodes folding to `fulfilled` or `dismissed` SHALL lose the exemption and boost and decay like ordinary nodes. Salience recompute SHALL run after every completed brain run, after rebuild and signal sync, on demand, and scoped to affected nodes when lifecycle transitions apply, as pure SQL with zero model calls.

#### Scenario: Quiet chat's open commitment survives recompute
- **WHEN** a salience recompute runs after a chat has been quiet long enough that its nodes decay below the dormancy threshold
- **THEN** that chat's open commitment node remains `active` while ordinary low-salience nodes flip to `dormant`

#### Scenario: Dormant node stays readable and revivable
- **WHEN** a node is dormant and new evidence cites its entity
- **THEN** direct lookup returned it while dormant, and the next recompute returns it to `active`

#### Scenario: Due-soon commitment ranks up
- **WHEN** an open commitment node's due date is within two weeks of now at recompute time
- **THEN** its salience carries the proximity boost and it outranks an otherwise-equal commitment with a distant due date

#### Scenario: Fulfilled commitment stops outranking
- **WHEN** a commitment node's lifecycle status folds to `fulfilled` and a recompute runs
- **THEN** it carries no due boost or dormancy exemption and may become dormant under the normal threshold while remaining directly readable with its resolution history
