## ADDED Requirements

### Requirement: Automated Claim Groundedness Census
The system SHALL provide a resumable, budget-capped grading pass that judges committed claims against their cited evidence using a model, batched by episode so one call grades every claim of one episode from a single rendering of that episode's cited messages. The pass SHALL cover `current`, model-generated episodes, SHALL order its work so anchoring-flagged claims are graded first, and SHALL persist each verdict through the existing grade vocabulary and table. It SHALL reuse the established run machinery — progress reporting, cancellation, resume after interruption, per-run and daily budget ceilings, and the token ledger — so a census is operationally the same shape as a backfill. Grading SHALL NOT occur on the episode commit path: a generation run SHALL never block on a grader.

#### Scenario: Census grades an episode's claims in one call
- **WHEN** the census processes an episode holding several claims
- **THEN** one model call receives that episode's claims alongside the full text of their cited messages, and a grade row is persisted for every claim in that episode

#### Scenario: Flagged claims are graded first
- **WHEN** a census run begins while anchoring-flagged claims remain ungraded
- **THEN** those claims' episodes are processed before unflagged ones, so the lint's measured precision is available before the run completes

#### Scenario: Census resumes after interruption
- **WHEN** a census run is cancelled or interrupted partway
- **THEN** already-graded claims are not re-graded on resume, and the run reports how much of the population remains

#### Scenario: Commit path stays independent
- **WHEN** an episode is generated and committed while no census is running
- **THEN** the commit completes without any grading call, and the episode simply becomes eligible for the next census or incremental pass

### Requirement: Grader Provenance And Agreement
Every grade row SHALL record how it was produced: the grader kind (human or model) and, for model grades, the grading model and effort. Model grades and human grades SHALL NOT be silently combined into one figure. The system SHALL report grader agreement — the rate at which model grades match human grades on claims graded both ways — alongside any aggregate derived from model grades, so a census is never presented without an indication of how far the grader can be trusted. Where both providers are available, the census SHALL prefer a grading model different from the model that wrote the claim, and SHALL record which arrangement applied.

#### Scenario: Grades are attributed
- **WHEN** a claim is graded by the census and another is graded by a human in the grading strip
- **THEN** each row records its grader kind, the model grade also records grading model and effort, and aggregates can report either population separately

#### Scenario: Agreement reported with the census figure
- **WHEN** the quality surface shows a groundedness rate derived from model grades
- **THEN** it also shows the grader-agreement rate and the size of the human-graded subset it was computed from

#### Scenario: Self-grading is avoided and recorded
- **WHEN** the census grades a claim written by a model that is also available as a grader, and a different grading model is available
- **THEN** the different model performs the grading and the row records that writer and grader differed

### Requirement: Groundedness Reporting And Repair Queue
The system SHALL report claim groundedness as a rate with its denominator, its as-of time, and the full grade distribution, per model stamp and extraction version, never as a bare percentage and never as a per-episode boolean. Claims graded `unsupported` SHALL be exposed as an actionable queue identifying their episodes, so re-derivation can target them, and the recorded grade reason SHALL be available to the regeneration path as feedback. Grades whose episode is later superseded SHALL be excluded from current-state figures while remaining queryable under their recorded stamps.

#### Scenario: Rate carries its denominator
- **WHEN** the quality surface reports groundedness
- **THEN** it shows the grade distribution, the number of claims graded, the total eligible, and when the figure was computed

#### Scenario: Ungrounded claims are actionable
- **WHEN** claims have been graded `unsupported`
- **THEN** the surface lists their episodes as a repair queue and offers regeneration scoped to them

#### Scenario: Regeneration clears a graded failure
- **WHEN** an episode carrying an `unsupported` claim is re-derived and re-graded
- **THEN** the superseded episode's grades leave the current-state figure, the replacement's grades enter it, and the historical rows remain queryable
