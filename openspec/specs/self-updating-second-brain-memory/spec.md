## Purpose

Define the local-first self-updating second-brain memory store, REM-style consolidation process, Codex opt-in provider boundary, and exact citation requirements for generated wiki pages.

## Requirements

### Requirement: Private Memory Store
The system SHALL store generated long-term memory artifacts, indexes, prompts, model outputs, citation maps, run ledgers, and OAuth session material only under the configured private workspace by default.

#### Scenario: Memory files are written locally
- **WHEN** a memory consolidation run commits generated wiki artifacts
- **THEN** the system writes those artifacts under `.wapp-brain/` or the configured private memory root and does not write them to public static assets or tracked source directories

#### Scenario: Generated memory is treated as sensitive
- **WHEN** doctor or cleanup checks inspect project-private data
- **THEN** generated memory artifacts are reported as private WhatsApp-derived data without printing message bodies, prompt bodies, raw model outputs, or credentials

### Requirement: Explicit Remote Model Opt-In
The system SHALL refuse Codex-backed or other remote model consolidation until the user explicitly enables a model provider and acknowledges that selected WhatsApp-derived evidence will be sent to that provider.

#### Scenario: Provider is disabled
- **WHEN** the user starts a consolidation run that requires remote reasoning and no provider opt-in exists
- **THEN** the run is refused with a privacy-safe message explaining that model setup is required

#### Scenario: User enables Codex provider
- **WHEN** the user completes Codex provider setup
- **THEN** the system stores provider session material locally in the private workspace and records that remote consolidation is enabled without logging tokens or message evidence

### Requirement: Codex High Reasoning Adapter
The system SHALL provide a narrow Codex model adapter that can request high-reasoning structured memory generation using local Codex OAuth credentials.

#### Scenario: Codex session exists
- **WHEN** a consolidation step requests a memory update from the Codex adapter
- **THEN** the adapter uses the locally stored session, refreshes it when needed, requests high-reasoning generation where supported, and sends only the selected evidence pack

#### Scenario: Codex session is missing or expired
- **WHEN** the adapter cannot authenticate or refresh the local Codex session
- **THEN** the consolidation job pauses or fails safely with a privacy-safe error and does not discard committed memory state

### Requirement: Consolidation Source Windows
The system SHALL consolidate archive messages through durable source windows with deterministic bounds, status, and source coverage metadata.

#### Scenario: Daily REM run selects completed window
- **WHEN** the user runs the default REM consolidation after the current local day has started
- **THEN** the system selects messages up to the end of the previous local day and leaves current-day messages unconsolidated

#### Scenario: Manual run overrides window
- **WHEN** the user starts a manual consolidation with explicit start and end bounds
- **THEN** the system records those bounds in the source-window ledger before generating memory updates

#### Scenario: Source window already committed
- **WHEN** the same source window has already been committed with the same source coverage
- **THEN** the system reports the window as already consolidated or creates a replacement revision without duplicating memory claims

### Requirement: Resumable Memory Runs
The system SHALL track memory consolidation runs, evidence packs, model calls, validation results, totals, warnings, and failure summaries so interrupted work can resume safely.

#### Scenario: Run is interrupted
- **WHEN** the process exits after some evidence packs are prepared but before all page revisions commit
- **THEN** the next resume command reloads the run ledger and continues from the last uncommitted safe step

#### Scenario: Run fails validation
- **WHEN** generated memory output fails citation or schema validation
- **THEN** the system records a failed or blocked step with a privacy-safe reason and does not commit the invalid page revision

### Requirement: Cited Wiki Page Revisions
The system SHALL commit long-term memory as wiki page revisions where every durable claim is backed by one or more exact archive message citations.

#### Scenario: Page revision passes validation
- **WHEN** a generated page revision contains only claims with valid citations to archive messages in the allowed source windows
- **THEN** the system commits the page revision, citation map, and updated page index atomically

#### Scenario: Page revision has unsupported claim
- **WHEN** a generated page revision contains a claim without a valid citation
- **THEN** the system rejects that revision and records the unsupported claim as a validation issue

### Requirement: Citation Resolution
The system SHALL preserve enough citation metadata for each memory claim to reopen the exact chat and messages that support it.

#### Scenario: Citation is recorded
- **WHEN** a memory claim cites an archive message
- **THEN** the citation stores the archive message row ID where available, `source_message_key`, `source_message_id`, `source_chat_id`, sender identifier, timestamp, and a short citation label

#### Scenario: Cited message disappears
- **WHEN** a cited archive message is removed by a replace import or archive rebuild
- **THEN** the system marks dependent memory pages or claims as stale until citations are repaired or the page is regenerated

### Requirement: Evidence Pack Privacy
The system SHALL construct model evidence packs from selected archive messages without logging message bodies, raw rows, prompts, or model outputs by default.

#### Scenario: Evidence pack is prepared
- **WHEN** the runner prepares a model prompt for a source window
- **THEN** default logs include only metadata such as run ID, pack ID, message counts, time bounds, and token estimates

#### Scenario: User requests dry-run preview
- **WHEN** the user runs a dry-run evidence preview
- **THEN** the system writes preview output only to the private workspace or terminal and warns that it contains WhatsApp-derived content

### Requirement: Scheduler-Ready REM Command
The system SHALL expose manual CLI controls that can also be called later by an external scheduler or app-level interval runner.

#### Scenario: User runs REM command
- **WHEN** the user runs the memory REM command
- **THEN** the system starts or resumes a consolidation job for the default completed window and reports the run ID, selected bounds, and status

#### Scenario: Scheduler invokes command while job is active
- **WHEN** a scheduled invocation starts while another memory job is running
- **THEN** the system refuses to start a second job and reports the active run ID

### Requirement: Memory Audit And Rebuild
The system SHALL provide validation commands that audit generated memory against citations and support rebuilding derived memory from the archive.

#### Scenario: Audit passes
- **WHEN** the user runs a memory validation command and all committed claims resolve to valid citations
- **THEN** the system reports the memory store as valid with page, claim, and citation counts

#### Scenario: User rebuilds memory
- **WHEN** the user requests a rebuild of derived memory artifacts
- **THEN** the system can regenerate long-term memory from archive source windows without changing the raw archive records
