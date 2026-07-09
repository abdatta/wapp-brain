## ADDED Requirements

### Requirement: Progressive Disclosure Layers
Brain retrieval SHALL expose four layers — overview (archive-wide map with top-salience entities, open commitments, and freshness), pages (entity, topic, and chat documents), episodes (cited digests), and messages (exact archive rows with surrounding context) — where every layer's items resolve to the next layer down in one lookup and every claim resolves to exact message citations.

#### Scenario: Drill from overview to message
- **WHEN** a consumer starts at the overview and follows a topic page, then an episode, then a citation
- **THEN** each hop is a single request and the final hop returns the exact archived message with surrounding thread context

#### Scenario: Citation resolves media
- **WHEN** a citation points at a media message
- **THEN** resolution includes the message's interpretation label and a reference to the archived media asset

### Requirement: Fast Query Path
The default query path SHALL rank matches across brain documents and raw messages using the text index with recency, entity, and graph-proximity boosts, require no model call, label every hit with its layer, and answer within 2 seconds on the reference archive scale.

#### Scenario: Cold keyword query
- **WHEN** a consumer queries a term with no model provider available
- **THEN** ranked layer-labeled hits with snippets and citations return in under 2 seconds

#### Scenario: Entity-aware boost
- **WHEN** a query term resolves to a known person
- **THEN** messages sent by or mentioning that person rank above incidental text matches

### Requirement: Deep Query Path
A deep query mode SHALL run as a progress-reporting background job that augments fast results with cached model query expansion, graph-neighborhood traversal, and optionally synthesis whose every statement must cite gathered message keys; deep results SHALL return the fast results immediately along with a job reference, and expansion SHALL be cached for reuse.

#### Scenario: Paraphrase query recovered
- **WHEN** a fast query returns weak results and deep mode runs
- **THEN** expansion terms and graph traversal surface matching content that shares no keywords with the original query, with citations intact

#### Scenario: Deep mode without provider
- **WHEN** no model provider is available
- **THEN** deep mode degrades to graph traversal only and labels the result set accordingly

### Requirement: Coverage-Qualified Answers
Every retrieval response SHALL carry coverage and freshness metadata — assimilation watermark coverage for the queried scope, index watermark, and last consolidation times — so consumers can distinguish "no evidence" from "not yet assimilated".

#### Scenario: Gap not presented as absence
- **WHEN** a query's scope includes chats whose watermarks lag the query's time range
- **THEN** the response states the unassimilated scope alongside any hits

### Requirement: Structured Server-Side Results
Retrieval SHALL return structured typed results (layer, title, snippet, score, citations, node and document references) defined in shared DTOs and consumed identically by the local UI, CLI, and agent surfaces; no consumer-specific meaning SHALL be computed client-side.

#### Scenario: Same result everywhere
- **WHEN** the same query runs via UI, CLI, and MCP
- **THEN** all three render the same hits, labels, and citations from the same DTO shape

### Requirement: Query Privacy Defaults
Fast queries SHALL involve no remote calls; deep queries SHALL use the model provider only under its existing opt-in, send only the minimal expansion or synthesis context, mark results that used remote synthesis, and never log query text with message bodies.

#### Scenario: Fast path is local
- **WHEN** a fast query executes
- **THEN** no data leaves the machine

#### Scenario: Synthesis labeled
- **WHEN** deep synthesis produces an answer
- **THEN** the answer is marked as remote-synthesized and every sentence carries citations
