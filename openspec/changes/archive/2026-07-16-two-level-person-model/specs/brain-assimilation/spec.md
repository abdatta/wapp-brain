# brain-assimilation Specification (delta)

## ADDED Requirements

### Requirement: Person Aggregation Via Membership
Person-keyed brain surfaces (person views, salience, rollups, and any higher consolidation) SHALL aggregate identity-anchored derived knowledge — claims via their claim-entity identity anchors, engagement via identity-keyed aggregates — over person membership at read or rollup time. Hard person-node merges SHALL NOT exist in the brain: person membership edits MUST NOT insert, update, or delete episodes, claims, claim entities, citations, or watermarks, and redirect records SHALL exist only for externally-held person identifiers. Extraction SHALL continue to anchor entities at the identity level; no brain write path SHALL key durable state on a person identifier. Person-keyed derived surfaces that cache their aggregation SHALL re-derive on membership change.

#### Scenario: Connect widens the person view without brain writes
- **WHEN** two identities that each anchor committed claims are connected into one person
- **THEN** the person's aggregated view covers both identities' claims immediately, and no episode, claim, claim-entity, citation, or watermark row changed

#### Scenario: Disconnect re-derives cleanly
- **WHEN** an identity is disconnected from a person after person-keyed surfaces were derived
- **THEN** those surfaces re-derive to exclude that identity's knowledge, again with zero writes to episode, claim, or citation tables

#### Scenario: Consolidation inputs select by membership at run time
- **WHEN** a future rollup runs for a person whose membership changed since the previous rollup
- **THEN** its input predicate resolves current membership at run time and selects claims by the member identities' anchors, not by any person id stored on claims
