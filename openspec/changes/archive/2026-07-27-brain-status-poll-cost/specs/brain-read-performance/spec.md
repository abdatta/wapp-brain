## ADDED Requirements

### Requirement: Poll-Path Endpoints Answer Within A Budget
Every endpoint the application shell polls SHALL answer within a stated latency budget on an archive of realistic scale (hundreds of thousands of messages, thousands of chats, thousands of episodes and lifecycle nodes). The budget SHALL be asserted by an automated test against a generated archive, not merely documented, so that an aggregate which becomes expensive as the archive grows fails the suite rather than silently degrading every page in the app. A read that cannot meet its budget SHALL be moved off the poll path rather than left to slow navigation everywhere.

#### Scenario: A newly expensive aggregate fails the suite
- **WHEN** a derived read on a polled endpoint grows past its budget as archive scale increases
- **THEN** the latency assertion fails, naming the endpoint and the measured cost, instead of the regression surfacing only as the app feeling slow

#### Scenario: Navigation costs only what the page shows
- **WHEN** the user opens a surface that does not display brain quality metrics
- **THEN** no model-quality, resolution-debt, regenerable-count, media-gap, or validation-issue aggregate is computed to serve that navigation

### Requirement: Hot Poll And Cold Dashboard Are Separate Reads
Derived aggregates that a user reads occasionally SHALL NOT be computed on an endpoint polled continuously by the shell. The status endpoint SHALL return only what the shell renders — coverage, backlog sample, task counts, usage, and run/scheduler/provider state — and dashboard aggregates SHALL be served by a separate endpoint requested by the surface that displays them, on its own cadence.

#### Scenario: Dashboard panels load independently
- **WHEN** the brain page opens
- **THEN** its quality panels are fetched separately from the polled status, each showing a loading shimmer until its own answer arrives, and a slow panel never delays the rest of the page

#### Scenario: Status stays immediate after a brain mutation
- **WHEN** a run commits, a reset completes, or a mute changes
- **THEN** the polled status reflects it on the next poll without waiting for any dashboard aggregate to recompute

### Requirement: Full-Population Counts Without Full-Population Hydration
A surface that reports counts over a whole population SHALL compute those counts set-based, and SHALL hydrate per-item detail only for the rows it returns. Applying a limit SHALL measurably reduce work: a request for one row SHALL NOT cost the same as a request for a full page.

#### Scenario: Limit actually limits
- **WHEN** the commitments list is requested with a limit of one versus a full page
- **THEN** the one-row request is materially cheaper, and both report identical full-population counts

#### Scenario: Counts stay exact
- **WHEN** counts are computed set-based rather than by folding every item
- **THEN** every chip — open, overdue, stale, fulfilled, dismissed, sweep-due — matches the per-item fold exactly for every status and flag combination

### Requirement: Derived Read Caches Share One Invalidation Signal
Any cache over derived brain reads SHALL be invalidated by the single existing brain-mutation signal rather than by an independent timer or a second signal, so cached reads can never disagree with each other or outlive the data they summarize.

#### Scenario: One signal clears every derived cache
- **WHEN** any brain mutation invalidates derived state
- **THEN** every derived read cache clears together, and no surface serves a value computed from data that no longer exists

### Requirement: Latency Work Preserves Responses Exactly
A change made for latency SHALL NOT alter what any endpoint returns. Equivalence SHALL be demonstrated by comparing complete responses before and after the change against a copy of a real archive, field by field.

#### Scenario: Same numbers, sooner
- **WHEN** a poll-path endpoint is restructured, cached, or newly indexed
- **THEN** its full response is byte-equivalent to the previous implementation's for the same archive state

### Requirement: Indexes Are Measured Against Write Cost
An index added to speed a read SHALL be justified by a query-plan improvement and evaluated for its effect on import and live-sync write throughput. An index that materially slows ingestion SHALL NOT be kept for a read win.

#### Scenario: A read win that slows ingestion is rejected
- **WHEN** a candidate index improves a read but measurably degrades message insert throughput
- **THEN** the index is not kept, and the read is addressed another way
