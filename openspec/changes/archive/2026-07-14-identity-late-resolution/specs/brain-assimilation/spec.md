## MODIFIED Requirements

### Requirement: Staleness Propagation
Message edits, deletions, and interpretation upgrades affecting already-assimilated messages SHALL mark dependent episodes stale and enqueue regeneration tasks; staleness SHALL be visible in brain status. Name resolution SHALL also be a staleness source, but with a deterministic-repair-first policy: when an identity that appears as an unresolved participant in committed episodes gains a resolved name (or a known number where only a LID token was baked), the affected episodes SHALL first be repaired deterministically with no model call (token substitution in prose, stamp update, re-projection, and participant recompute, per the Deterministic Identity Prose Repair requirement) rather than being marked stale. Name resolution MAY additionally enqueue low-priority regeneration tasks as a quality upgrade so the model can weave the newly named person into context, but regeneration SHALL never be the mechanism that clears the resolution debt and SHALL never block the deterministic repair; the brain SHALL remain correct with regeneration disabled.

#### Scenario: Edit invalidates episode
- **WHEN** a live edit changes a message cited by a committed episode
- **THEN** the episode is marked stale and a regeneration task is enqueued

#### Scenario: Deletion invalidates episode
- **WHEN** a message cited by a committed episode is deleted
- **THEN** the episode is marked stale and a regeneration task is enqueued

#### Scenario: Name resolution repairs deterministically, not by staleness
- **WHEN** an identity that appears as an unresolved participant in committed episodes gains a resolved name
- **THEN** the affected episodes are repaired deterministically with no model call and are not marked stale merely because of the name resolution

#### Scenario: Regeneration after resolution is an optional upgrade
- **WHEN** name resolution enqueues optional low-priority regeneration for the repaired episodes and regeneration is disabled or unbudgeted
- **THEN** the episodes remain correctly repaired by the deterministic pass and the resolution debt is already cleared for the resolved identity

## ADDED Requirements

### Requirement: Deterministic Identity Prose Repair
When an identity recorded in a committed episode's `unresolved_participants` stamp gains a better label, the system SHALL repair that episode with no model call. The improved label is either a genuine resolved name or, for the merge variant, a known phone number replacing an opaque LID token. Repair SHALL: substitute, in the episode's `summary` and in every claim's text, the number or LID token the evidence pack baked for that identity — the token being derived deterministically from the identity's JID, including any collision-disambiguation suffix — with the improved label; recompute the episode's participant list; and re-project the episode's Markdown from the database. When the improved label is a genuine name the identity SHALL be removed from the episode's unresolved-participants stamp; when the improvement is only a number (still no name), the token SHALL be substituted but the identity SHALL remain stamped so it stays counted as unresolved and remains repairable when a name later arrives. Repair SHALL be per-identity: an episode with several unresolved participants SHALL repair only those that improved and leave the others stamped. Repair SHALL apply to extractive episodes as well as model-generated ones. Citations SHALL remain byte-identical to the raw messages regardless of substitution coverage, so an episode stays fully checkable against its evidence even when a token is missed.

#### Scenario: Number token replaced by the resolved name
- **WHEN** an episode's summary and claims refer to a participant by a baked `+E.164` number token and that number is later saved as a contact name
- **THEN** the summary and claim text render the saved name in place of the number token, with no model call

#### Scenario: Stamp cleared only for the resolved identity
- **WHEN** an episode stamped with two unresolved participants has one of them resolved to a name
- **THEN** the resolved identity is removed from the episode's unresolved-participants stamp and the other identity remains stamped

#### Scenario: Merge yields a number but not a name
- **WHEN** a LID participant baked as a `lid:` token merges into a phone identity that still has no saved name
- **THEN** the `lid:` token is substituted with the now-known `+E.164` number and the identity remains stamped as unresolved

#### Scenario: Citations are unchanged by substitution
- **WHEN** a claim's prose is substituted from a number token to a name
- **THEN** the claim's citations still resolve to the same raw messages, whose bodies are unchanged, so the claim remains checkable

#### Scenario: Extractive episode is repaired too
- **WHEN** an extractive-fallback episode carries an unresolved-participant stamp and that participant is resolved
- **THEN** its prose and projection are repaired deterministically the same way a model-generated episode's are

### Requirement: Resolution Debt Surface
Brain status SHALL expose, computed with no model call, the resolution debt: the count of `current` episodes carrying one or more unresolved participants and the count of distinct unresolved identities across them, with those identities ranked by the message volume behind each so the contact saves that would repair the most brain content surface first. The counts SHALL decrement as identities resolve and their episodes are repaired, and a completed repair SHALL emit a status update so the surface refreshes without a reload.

#### Scenario: Debt is surfaced and ranked by volume
- **WHEN** committed episodes involve unresolved participants
- **THEN** brain status reports how many episodes involve unresolved participants and how many distinct numbers, ranked by message volume so the highest-value saves appear first

#### Scenario: Resolving an identity decrements the debt
- **WHEN** an unresolved participant is saved as a contact and its episodes are repaired
- **THEN** the resolution-debt counts decrease accordingly and the repaired episodes no longer count that identity, with no model call
