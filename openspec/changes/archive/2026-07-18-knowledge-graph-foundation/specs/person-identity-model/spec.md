# person-identity-model — knowledge-graph-foundation delta

## ADDED Requirements

### Requirement: Graph-Facing Person Aggregation Contract
Person-level graph reads SHALL resolve membership at read time: an entity query for any member identity SHALL aggregate identity-anchored graph state (nodes, node-claim junctions, edges, and salience inputs) across all current members of that identity's person, and a lone identity SHALL answer as its own single-member aggregate. Person membership edits SHALL require zero graph writes: no brain graph table row SHALL key on a person id, and connect or disconnect SHALL change subsequent aggregated reads only. Graph surfaces SHALL render person labels resolved through the person/identity layer at read time — a rename or membership change re-labels and re-scopes reads with no node, edge, or episode regeneration.

#### Scenario: Connect widens the graph aggregate immediately
- **WHEN** two identities whose person nodes each carry claims are connected into one person
- **THEN** the next entity query for either JID aggregates both identities' nodes, claims, and edges, and no graph rows were inserted, updated, or deleted by the connect

#### Scenario: Disconnect narrows the aggregate with zero graph writes
- **WHEN** an identity is disconnected from a person after aggregated graph reads were served
- **THEN** subsequent entity queries exclude that identity's graph state, again with zero graph table writes

#### Scenario: No durable graph state keys on a person id
- **WHEN** the graph schema and its write paths are inspected
- **THEN** nodes, edges, evidence, junctions, and aliases key on identity JIDs, natural keys, or claim ids — never on a person id
