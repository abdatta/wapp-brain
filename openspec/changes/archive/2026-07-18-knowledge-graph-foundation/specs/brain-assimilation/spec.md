# brain-assimilation — knowledge-graph-foundation delta

## ADDED Requirements

### Requirement: Knowledge Graph Substrate
The brain SHALL maintain a typed knowledge graph in dedicated tables — nodes, edges, edge evidence, node-claim junctions, and node aliases — as derived-of-derived state rebuildable from committed episodes and captured archive signals with zero model calls. Nodes SHALL carry a kind from the vocabulary (`person`, `chat`, `topic`, `org`, `place`, `project`, `other`, `commitment`, `question`, `event`, `fact`), a unique natural key making every producer idempotent, an immutable slug assigned at creation, a status (`active`, `dormant`, `merged`), and a payload for kind-specific fields. Edges SHALL be typed (`participates_in`, `mentions`, `about`, `involves`, `related_to`, `replies_to`, `derived_from`, `alias_of`, with `resolves` reserved for the commitment lifecycle), unique per (source, destination, kind), weighted by accumulated evidence, and stamped with first/last-seen times. Every edge SHALL be traceable to its evidence (claim ids, source message keys, or signal references); no edge SHALL exist without at least one evidence row. Person-kind nodes SHALL key on canonical JID when identity-anchored; titles SHALL never be load-bearing — person labels resolve at read time so renames re-label with zero regeneration.

#### Scenario: Nodes and edges populate from claim entities
- **WHEN** episodes with JID-anchored and topic-linked claims have committed for a few chats
- **THEN** `brain_nodes` contains person, chat, and topic nodes with stable natural keys and slugs, and `brain_edges` contains typed edges each carrying at least one evidence row resolvable to claims or messages

#### Scenario: Upserts are idempotent under replay
- **WHEN** the same episode's graph derivation is applied twice (retry, regeneration, or rebuild)
- **THEN** no duplicate nodes or edges are created and evidence rows do not double-count

#### Scenario: Renamed contact re-labels at read time
- **WHEN** a contact whose identity anchors a person node is renamed
- **THEN** graph reads resolve the new label with no node, edge, or episode writes

### Requirement: Graph Commit Integration
Committing a model-generated episode SHALL upsert its graph contribution in the same transaction as the episode, claims, citations, entities, topics, stamps, and watermark advance: entity nodes (person entities keyed by canonical JID when anchored), chat and topic nodes, one node per commitment and question claim (payload status `open`, holder and due derived from the claim) and per event claim with an event time, and the deterministic edges — `participates_in` (participants and citing senders to the chat), `mentions` (authoritative structured mentions on pack messages), `about` (claim entities to episode topics), `involves` (lifecycle nodes to their claim's entities), `related_to` (entity pairs co-occurring in one claim), and `replies_to` (replier to an existing lifecycle node when a pack message's quoted snapshot targets a message that node's claim cites). Extractive episodes SHALL contribute no graph writes. When a regeneration supersedes an episode, the superseded episode's node-claim junctions, lifecycle nodes, and edge evidence SHALL be removed in the same transaction that commits the replacement's contribution, so the graph always derives from current model episodes only.

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

### Requirement: Deterministic Graph Signal Sync
The brain SHALL provide an idempotent, chunked signal sync that derives graph state from captured archive signals with zero model calls: group membership periods SHALL produce `participates_in` edges whose first/last-seen reflect the period bounds; vCards with a source-resolved JID SHALL produce the subject's person node and a `mentions` edge from sharer to subject; number-change events SHALL record alias evidence on the surviving identity's node; engagement aggregates SHALL feed a bounded person-node salience factor. Signal sync SHALL run as part of rebuild and on demand, and re-running it SHALL be a no-op absent new signals.

#### Scenario: Membership timeline becomes participation edges
- **WHEN** signal sync runs over captured group membership periods
- **THEN** each (participant, group) period yields one `participates_in` edge with first/last-seen from the period bounds, and re-running sync creates no duplicates

#### Scenario: Resolved vCard introduces a person node
- **WHEN** a captured vCard carries a source-resolved JID for a person with no prior node
- **THEN** sync creates that person node keyed on the canonical JID and a `mentions` edge from the sharer with the vCard as evidence

### Requirement: Graph Salience And Kind-Aware Dormancy
Every node SHALL carry a salience recomputed from evidence — never incremented blindly — as `log(1+citations) × log(1+evidence_days) × exp(−days_since_last_evidence/90)`, where citations and distinct evidence days derive from the node's claim citations and edge evidence; person nodes MAY additionally carry a bounded engagement factor (at most 1.25×). Nodes whose salience falls below the configured dormancy threshold SHALL become `dormant` and SHALL return to `active` when evidence revives them; dormant nodes SHALL be hidden from ranked and default surfaces but SHALL remain directly readable and searchable — dormancy hides, never deletes. Commitment and question nodes with payload status `open` SHALL be exempt from dormancy regardless of salience and SHALL receive a due-date proximity boost when due within two weeks. Salience recompute SHALL run after every completed brain run, after rebuild and signal sync, and on demand, as pure SQL with zero model calls.

#### Scenario: Quiet chat's open commitment survives recompute
- **WHEN** a salience recompute runs after a chat has been quiet long enough that its nodes decay below the dormancy threshold
- **THEN** that chat's open commitment node remains `active` while ordinary low-salience nodes flip to `dormant`

#### Scenario: Dormant node stays readable and revivable
- **WHEN** a node is dormant and new evidence cites its entity
- **THEN** direct lookup returned it while dormant, and the next recompute returns it to `active`

#### Scenario: Due-soon commitment ranks up
- **WHEN** an open commitment node's due date is within two weeks of now at recompute time
- **THEN** its salience carries the proximity boost and it outranks an otherwise-equal commitment with a distant due date

### Requirement: Graph Rebuild Determinism
The brain SHALL provide a rebuild that wipes graph tables and re-derives the entire graph from current model episodes and captured signals — chunked, yielding, progress-reporting, zero model calls. A from-scratch rebuild SHALL converge to the same graph as incremental commit-time operation over the same committed state. Brain derived-data resets SHALL wipe graph tables alongside episodes. Rebuild SHALL NOT require an extraction-version bump and SHALL NOT modify episodes, claims, citations, or watermarks.

#### Scenario: Rebuild equals incremental
- **WHEN** the graph built incrementally by episode commits is compared with a wipe-and-rebuild over the same episodes and signals
- **THEN** both contain the same nodes (by natural key), edges (by endpoints and kind), and evidence counts

#### Scenario: Pre-existing episodes gain graph coverage
- **WHEN** rebuild runs on an archive whose episodes were committed before the graph existed
- **THEN** those episodes' entities populate the graph with no model calls and no episode writes

#### Scenario: Brain reset covers the graph
- **WHEN** brain derived data is reset
- **THEN** graph tables are emptied in the same operation and the next assimilation or rebuild repopulates them

### Requirement: Graph Read Surface And Traversal Contract
The brain SHALL expose server-side graph reads returning shared DTOs: graph stats (node/edge counts by kind and status, last recompute), an entity view (a node resolved by id, JID, or name — person-aggregated per membership — with its claims, citations, and one-hop edges with read-time labels), and the unresolved-entity backpressure list (chat-scoped unresolved person nodes ranked by salience). Storage and indexes SHALL serve bounded k-hop neighborhood traversal filtered by edge kind, time window, and salience with hard caps — index walks, not table scans — as the contract for the explorer and retrieval consumers. No API, CLI, or UI surface SHALL offer an unbounded whole-graph read.

#### Scenario: Entity query aggregates the person at read time
- **WHEN** the entity view is requested for a JID whose identity belongs to a multi-member person
- **THEN** the response aggregates nodes, claims, and edges across all member identities, resolved through membership at read time

#### Scenario: Disconnect re-derives with zero graph writes
- **WHEN** an identity is disconnected from a person and the entity view is requested again
- **THEN** the aggregation excludes the disconnected identity's knowledge, with no graph, episode, claim, or citation rows changed by the disconnect

#### Scenario: Unresolved entities surface as backpressure
- **WHEN** committed claims carry person entities that failed pack-local resolution
- **THEN** the unresolved list returns their chat-scoped nodes ranked by salience, each linked to its claims, and no global name-based resolution occurred

### Requirement: Graph Identity Merge Reconciliation
When an identity merge collapses a JID onto its canonical form, the same transaction SHALL reconcile the graph: the obsolete node's claim junctions, aliases, and edges re-point onto the canonical node (edges merging by endpoints and kind, evidence accumulating), and the obsolete node becomes a redirect stub (`merged`, pointing at the survivor) so externally-held node ids never dangle. Reads SHALL follow at most one redirect hop. Slugs SHALL remain immutable through merges.

#### Scenario: LID node merges into the phone node
- **WHEN** an identity merge collapses a LID whose person node holds claims and edges onto a phone JID with its own node
- **THEN** the phone node carries the union of claims and edges with accumulated evidence, and the LID node answers as a redirect to it

#### Scenario: Held node id survives the merge
- **WHEN** a graph read arrives for a node id that was merged away
- **THEN** the read resolves through the redirect to the surviving node rather than erroring
