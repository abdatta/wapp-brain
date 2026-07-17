# brain-evaluation — Delta Spec

## ADDED Requirements

### Requirement: Golden Query Set
The system SHALL maintain a golden query set of real retrieval queries, each carrying a stable id, a query class (`paraphrase`, `person`, `commitment`, `temporal`, `code-mixed`, extendable), the query text, and the expected result as stable message identifiers (chat id + message id). The set SHALL live in a local file under the user data directory, excluded from version control (real archive content is never committed), and SHALL be self-versioned: a monotonic version plus a content hash that every eval run records, so runs are comparable only when their golden hash matches. A synthetic example file SHALL ship in-repo as scaffold and test fixture.

#### Scenario: Golden set scaffolded on first use
- **WHEN** an eval run is requested and no golden set file exists
- **THEN** the system creates (or points the user to) a scaffold with the class vocabulary and example entries, and the run refuses with a clear message rather than measuring an empty set

#### Scenario: Golden edits change the hash
- **WHEN** the user adds or edits a golden query and runs the eval again
- **THEN** the new run records a different content hash and version, and comparisons against runs from a different hash are labelled as cross-version

#### Scenario: Real queries stay out of git
- **WHEN** the golden set contains queries referencing real archive content
- **THEN** the file resides under the user data directory covered by the existing ignore rules, and only the synthetic example lives in the repository

### Requirement: Retrieval Recall Measurement
The system SHALL execute every golden query against the archive search path — the same ranked query pipeline user search uses, not a parallel reimplementation — and compute recall@k per query (fraction of expected message identifiers present in the top k) for one or more configured k values, aggregated per class and overall. A full eval run SHALL make zero model calls and complete without blocking the server event loop.

#### Scenario: Recall computed per class
- **WHEN** an eval run executes over a golden set spanning multiple classes
- **THEN** the run produces recall@k per class and overall, with per-query detail (found/missing identifiers and their ranks) persisted for inspection

#### Scenario: Zero LLM cost
- **WHEN** an eval run executes
- **THEN** no model provider is invoked and no token ledger entries are written

#### Scenario: Deleted expected message
- **WHEN** a golden query's expected message no longer exists in the archive
- **THEN** the run flags that query as invalid-expectation rather than scoring it as a retrieval miss

### Requirement: Persisted Comparable Eval Runs
Every eval run SHALL persist a `brain_eval_runs` row recording when it ran, the golden set version and hash, the retrieval target (initially archive search; extensible to future brain retrieval modes), the k values, per-class and per-query results, and totals. Runs SHALL be listable and diffable so any retrieval or contract change shows its recall delta against a chosen baseline run.

#### Scenario: Delta against baseline
- **WHEN** a run completes and a prior run with the same golden hash exists
- **THEN** the run report shows per-class deltas against the most recent such run (or an explicitly chosen baseline), marking regressions

#### Scenario: Runs survive brain resets
- **WHEN** brain derived data is wiped or regenerated
- **THEN** eval runs (and claim grades) are preserved — measurement history and human labels are user-authored ground truth, not rebuildable derived data

### Requirement: Single-Writer-Safe Execution
Eval runs and grading writes SHALL respect the one-writer constraint on the archive database: when the server is running, eval executes inside the server process (HTTP API, usable from the Brain panel and CLI alike); the CLI SHALL detect a running server and delegate to it, opening the database directly only when no server holds it.

#### Scenario: CLI with server up
- **WHEN** `brain-eval` runs while the local server is listening
- **THEN** the CLI performs the run through the server API and prints the same report, without opening a second writable database connection

#### Scenario: CLI with server down
- **WHEN** `brain-eval` runs with no server listening
- **THEN** the CLI opens the database via the shared repository module and executes the identical runner code path

### Requirement: Deterministic Citation-Precision Sampling
The system SHALL produce a grading sample of committed claims drawn only from `current`, model-generated episodes, stratified per model stamp, ordered by a deterministic stable hash of claim identity (not insertion order, not randomness), and prioritizing ungraded claims. The same archive state and parameters SHALL always yield the same sample.

#### Scenario: Deterministic sample
- **WHEN** a grading sample of N claims per model is requested twice with no intervening grades or commits
- **THEN** both requests return the same claims in the same order

#### Scenario: Superseded episodes excluded
- **WHEN** episodes are regenerated and marked superseded
- **THEN** newly requested samples draw only from current episodes, and previously recorded grades keep referencing the stamps they were graded under

### Requirement: Manual Claim Grading
The system SHALL render each sampled claim beside the full text of its cited messages and accept a one-click grade — `supported` (citations establish the claim), `partial` (grounded but imprecise or overstated), `unsupported` (citations do not establish it), `unclear` (cannot judge) — persisted in `brain_claim_grades` with the grade time and the episode's generator, model, effort (when recorded), and extraction version denormalized onto the grade row, plus the claim text and citation keys, so grades remain meaningful after the claim's episode is superseded or deleted. Re-grading a claim SHALL overwrite its previous grade.

#### Scenario: One-click grade persists
- **WHEN** the user grades a claim in the Brain panel grading strip
- **THEN** the grade row persists with denormalized stamps and the strip advances to the next sampled claim without a page reload

#### Scenario: Grades outlive regeneration
- **WHEN** a graded claim's episode is later superseded by regeneration
- **THEN** the grade row remains queryable under its recorded model and extraction version, and per-model aggregates still include it

### Requirement: Per-Model Quality Aggregates
The system SHALL aggregate, per model stamp and extraction version: citation precision from grades (strict precision counting `supported` only, plus the full grade distribution), the extractive-fallback rate (fallback episodes over attempted episodes, from existing episode columns), and validation-issue and anchoring-lint warning rates from existing issue rows. Aggregates SHALL be served by the API and rendered in the Brain panel next to the existing validation and media-gap surfaces, with sample sizes shown so thin data is never mistaken for signal.

#### Scenario: Per-model precision table
- **WHEN** grades exist for episodes generated by two different models
- **THEN** the Brain panel shows a per-model table with grade counts, strict precision, fallback rate, and issue rates, each with its denominator

#### Scenario: Fallback rate without grades
- **WHEN** no manual grades exist yet
- **THEN** the fallback-rate and issue-rate lines still render from existing episode data, labelled as the free interim signal

### Requirement: Eval Gate Reporting
The system SHALL expose a machine-readable gate verdict comparing a run's per-class recall against a designated baseline run, so downstream phase gates can require "golden-set recall@k per class meets or exceeds the recorded baseline" instead of anecdotal spot queries, and so the embedding-rerank follow-up decision has an actual data producer.

#### Scenario: Gate passes
- **WHEN** a gate check runs and every class's recall@k meets or exceeds the baseline within the same golden hash
- **THEN** the verdict reports pass with per-class figures

#### Scenario: Gate fails on regression
- **WHEN** any class's recall@k falls below the baseline
- **THEN** the verdict reports fail naming the regressed classes and the offending queries
