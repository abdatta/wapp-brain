# brain-graph-explorer Specification

## Purpose

Define the bounded graph-neighborhood read and its interactive explorer: an anchored ego-graph primitive (never a whole-graph read) with read-time person labels and same-name disambiguation, one-node-per-person identity collapse, auditable edge evidence that clicks through to the source thread, a typeahead anchor over real nodes, and mirror parity across both repository backends — a reusable server-side contract that serves the explorer UI, the deep retrieval path, and agent tools with zero model calls.

## Requirements

### Requirement: Bounded neighborhood read contract

The system SHALL expose a bounded graph-neighborhood read (`GET /api/brain/graph/neighborhood`, a repository method, and a CLI twin) that returns the anchored ego-graph around a single node and never the whole graph. The read SHALL accept an anchor (node id, JID, or name), a traversal `depth` clamped to at most 2, an optional edge-kind filter, an optional time window applied to each edge's last-evidence time, an optional minimum node salience, and hard node/edge caps clamped to server-side ceilings. It SHALL execute as pure SQL/traversal with zero model calls, and SHALL push the kind, time-window, salience, and status filters into the traversal so the result is bounded by construction rather than materialized and trimmed. When caps clip the neighborhood, the response SHALL disclose truncation (a flag plus the pre-cap totals) rather than silently dropping nodes, and SHALL never drop the anchor.

#### Scenario: Anchored two-hop neighborhood

- **WHEN** a client requests the neighborhood of a person anchor at depth 2
- **THEN** the response contains that anchor at hop 0 and only nodes reachable within two hops under the active filters, each carrying its hop distance, with no node beyond the requested depth

#### Scenario: Whole-graph reads are impossible

- **WHEN** any client calls the neighborhood read without narrowing filters
- **THEN** the result is still bounded by the depth limit and the node/edge caps, and no endpoint, parameter, or path returns the entire node/edge set

#### Scenario: Caps are enforced and truncation is disclosed

- **WHEN** an anchor's neighborhood exceeds the node or edge cap
- **THEN** the response returns at most the capped counts, keeps the anchor, retains the highest-salience nodes deterministically, drops edges whose endpoint was dropped, and marks the result truncated with the pre-cap totals

#### Scenario: Edge-kind, time, and salience filters restrict the result

- **WHEN** the request restricts edge kinds, sets a past time window, or sets a minimum salience
- **THEN** only edges of those kinds, only edges whose last-evidence time falls within the window, and only nodes at or above the minimum salience appear in the response

#### Scenario: Undirected traversal reaches both directions

- **WHEN** the anchor is the destination endpoint of a stored edge (including a normalized `related_to` pair)
- **THEN** the traversal still reaches the other endpoint, and each edge appears once regardless of stored direction

### Requirement: Read-time labels with same-name disambiguation

Every node in a neighborhood response SHALL be labelled at read time from the identity/person layer (saved name, else push name, else full +E.164 number; masked placeholders never win), so that renaming a contact re-labels the node with zero graph writes and zero episode regeneration. When two or more nodes in a single response resolve to the same display label but represent distinct persons, the system SHALL disambiguate them (complete number, else context, else a stable ordinal) so distinct people are never presented as one. Nodes that have been merged SHALL be followed by at most one redirect hop for anchor resolution and SHALL NOT appear as neighbors.

#### Scenario: Renamed contact re-labels with no regeneration

- **WHEN** a contact anchored in the graph is renamed and the same neighborhood is requested again
- **THEN** the node shows the new label with no change to any stored node, edge, claim, or episode

#### Scenario: Two same-named people stay distinct

- **WHEN** a neighborhood contains two distinct person nodes that both resolve to the same name
- **THEN** each is rendered with a disambiguator so they read as two different people, while multiple nodes of the same person are not disambiguated against each other

#### Scenario: Merged node never appears as a neighbor

- **WHEN** a node that was merged into a survivor would be reached by the traversal
- **THEN** the survivor is used and the merged stub is excluded from the returned neighbors

### Requirement: Neighborhood collapses linked identities into one node per person

The neighborhood read SHALL present one node per PERSON, not per identity: person identity nodes that belong to the same person (through the person-membership layer) SHALL collapse into a single representative node, with their edges rewired onto it, so a person who has several numbers appears once. The anchor, when it is a person, SHALL remain its own group's representative. This aggregation SHALL be read-time — connecting or disconnecting identities SHALL change the next read with zero stored graph changes — and SHALL be identical across both repository backends.

#### Scenario: Connected identities appear once

- **WHEN** two identities are linked as the same person and both fall within a requested neighborhood
- **THEN** they render as a single person node with their edges merged onto it

#### Scenario: Disconnect re-separates with no graph writes

- **WHEN** the two identities are subsequently disconnected
- **THEN** the next neighborhood read shows them as two separate nodes again, with no change to any stored node or edge

#### Scenario: The anchored identity stays the hub

- **WHEN** the anchor is one identity of a multi-identity person
- **THEN** the anchored identity is the representative node, and its sibling identities fold into it rather than appearing separately

### Requirement: Edge evidence is auditable and thread-linkable

The system SHALL expose a per-edge evidence read (`GET /api/brain/graph/edge?id=`) that returns an edge's endpoint labels, kind, and its supporting claims and citations. Each citation SHALL carry the coordinates needed to open the source conversation at the exact cited message (source chat id and message id, plus the source message key and timestamp). The evidence read SHALL be lazy — the neighborhood response SHALL NOT inline citation lists for every edge — and SHALL resolve both claim-derived and message-derived edge evidence.

#### Scenario: Selecting an edge returns its claims and citations

- **WHEN** a client requests the evidence for a specific edge id
- **THEN** the response lists the edge's supporting claims and citations, each citation carrying the chat id and message id of the cited message

#### Scenario: A citation resolves to a thread anchor

- **WHEN** a returned citation is opened
- **THEN** it yields a thread deep link to that chat centered on the cited message, using the existing message-anchor navigation

#### Scenario: Neighborhood payload stays lean

- **WHEN** a neighborhood with many edges is returned
- **THEN** the edges carry evidence counts and freshness but not full citation arrays, and citations are fetched only when an edge is selected

### Requirement: Interactive graph explorer surface

The system SHALL provide a routed `/graph` explorer that renders an anchored ego-graph (not a global layout) with typed edge styling. It SHALL support expanding the neighborhood by selecting a node, filtering by edge kind, scrubbing a time window that changes which edges are visible by fading or hiding edges by last evidence, and toggling dormant nodes which SHALL be hidden by default. The surface SHALL show freshness and provenance through tooltips per the people-UX conventions, SHALL NOT display raw JSON, and SHALL show progress for reads and surface failures as a visible toast and a console log rather than failing silently.

#### Scenario: Anchor and expand

- **WHEN** the user anchors on a node and then selects a neighboring node
- **THEN** the neighborhood expands around the selected node without re-rendering the whole graph

#### Scenario: Time scrub changes the visible edge set

- **WHEN** the user scrubs the time window to an earlier period
- **THEN** edges whose last evidence is outside the window fade or disappear and the visible edge set changes accordingly

#### Scenario: Dormant nodes hidden until toggled

- **WHEN** the explorer first renders a neighborhood
- **THEN** dormant nodes are hidden, and enabling the dormancy toggle reveals them without deleting or altering anything

#### Scenario: Slow reads show progress and never fail silently

- **WHEN** a neighborhood or edge read takes longer than about a second or fails
- **THEN** progress is shown while it runs and any failure surfaces as a toast and a console log

### Requirement: Anchor selection is a typeahead over real nodes

The explorer SHALL let the user choose an anchor only by selecting a real node from a typeahead, never by submitting free text. As the user types, the system SHALL suggest nodes whose read-time label matches the query — persons by contact name (falling back to the stored name for unresolved identities), chats by chat name, and everything else by title — ranked by salience, each suggestion carrying a stable node id so the chosen anchor is unambiguous even when several nodes share a name. Claim-ish kinds (commitment/question/event/fact) and merged stubs SHALL be excluded. Selecting a suggestion SHALL anchor by that node id. The suggestion search SHALL be a server-side contract implemented in both repositories with identical results.

#### Scenario: Typing suggests matching nodes and selection anchors by id

- **WHEN** the user types into the anchor search and selects one of the suggested nodes
- **THEN** the explorer anchors on exactly that node by its id, and two nodes that share a display name remain separately selectable

#### Scenario: Free text cannot anchor

- **WHEN** the user types text that matches no node and attempts to submit
- **THEN** no anchor change occurs and the surface indicates there are no matching nodes

#### Scenario: A 1:1 chat is not offered separately from its person

- **WHEN** the query matches both a person and that person's direct (1:1) chat
- **THEN** only the person is suggested, because the neighborhood folds a 1:1 chat onto its counterparty person; group chats remain suggestible in their own right

#### Scenario: Both backends agree on suggestions

- **WHEN** the same query runs against the SQLite and in-memory repositories over identically seeded data
- **THEN** both return the same set of suggested nodes — same kinds, labels, and identities

### Requirement: Evidence click-through to the thread

The explorer SHALL let the user move from a rendered edge to its evidence to the underlying conversation: selecting an edge SHALL open its claims and citations, and activating a citation SHALL navigate to the thread view centered on the exact cited message, reusing the existing thread deep-link and scroll-to-message machinery.

#### Scenario: Edge to citations to thread

- **WHEN** the user selects an edge and then activates one of its citations
- **THEN** the app navigates to that citation's chat centered on the cited message, and the message is scrolled into view

### Requirement: Query-layer mirror parity

The neighborhood traversal and the edge-evidence read SHALL be implemented in both the SQLite repository (recursive CTE) and the in-memory repository (equivalent traversal), and the two SHALL return identical results — the same nodes, edges, ordering, caps, labels, and disambiguation — for the same inputs. This parity SHALL be verified by executing the same scenarios against both backends.

#### Scenario: Both backends agree

- **WHEN** the same neighborhood request runs against the SQLite and in-memory repositories over identically seeded data
- **THEN** both return the same anchor, node set, edge set, hop distances, labels, truncation flag, and totals

### Requirement: Neighborhood read is a reusable server-side primitive

The neighborhood read SHALL be a server-side contract whose meaning (bounds, labels, evidence coordinates, DTO) lives in shared types, so the same answer can serve the explorer UI, the deep retrieval path, and an agent tool without re-deriving graph semantics on any client. No consumer SHALL be required to issue a model call to read a neighborhood.

#### Scenario: One contract, multiple consumers

- **WHEN** a non-UI consumer (a retrieval path or an agent tool) needs a bounded neighborhood
- **THEN** it can call the same repository method / endpoint and receive the same shaped DTO, with zero model calls, without duplicating traversal, label, or disambiguation logic
