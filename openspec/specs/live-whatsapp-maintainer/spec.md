## Purpose

Define the local-only live WhatsApp maintainer that links as an opt-in companion device, ingests supported live events, detects gaps, and exposes privacy-safe controls.

## Requirements

### Requirement: Opt-In Local Pairing
The system SHALL provide an explicit opt-in flow for linking a WhatsApp account as a companion device, and SHALL store all resulting live-session state locally under the configured private workspace.

#### Scenario: Pairing creates local session state
- **WHEN** the user starts live maintainer pairing and completes WhatsApp linked-device authorization
- **THEN** the system records a live session locally without uploading auth state, contacts, messages, or metadata to a remote service

#### Scenario: Pairing is not implicit
- **WHEN** the user imports a backup without starting live pairing
- **THEN** the system does not connect to WhatsApp Web or create live session credentials

### Requirement: Code-Level WhatsApp Web Client
The system SHALL use a code-level WhatsApp Web protocol client for live maintenance and MUST NOT use browser automation for live ingestion.

#### Scenario: Maintainer starts without browser automation
- **WHEN** the live maintainer starts
- **THEN** the system connects through the selected protocol-client adapter without launching or controlling a browser

#### Scenario: Unsupported client is configured
- **WHEN** configuration selects a browser-automation based WhatsApp client
- **THEN** the maintainer refuses to start and reports that browser automation is outside this capability

### Requirement: Idempotent Live Event Ingestion
The system SHALL normalize live WhatsApp contacts, chats, participants, messages, and message state updates into the archive using stable source-derived keys.

#### Scenario: Duplicate live message event
- **WHEN** the same WhatsApp message is received through real-time sync and later through history sync
- **THEN** the archive contains one message record updated with the best available metadata rather than duplicate messages

#### Scenario: Backup and live source overlap
- **WHEN** a message already imported from backup is later observed by live sync with matching WhatsApp identity
- **THEN** the system upserts the existing archive message instead of creating a second copy

### Requirement: Live Sync Run Tracking
The system SHALL track live maintainer runs, connection state, event counts, warning counts, and failure summaries separately from backup import runs.

#### Scenario: Maintainer run completes normally
- **WHEN** the user stops a healthy live maintainer run
- **THEN** the system records the run status, timestamps, totals, and warning count without changing prior backup import run records

#### Scenario: Maintainer run fails
- **WHEN** the live maintainer crashes or disconnects with an unrecoverable local error
- **THEN** the system records a failed live run with a privacy-safe error summary and preserves restartable checkpoints

### Requirement: Per-Chat Checkpoints
The system SHALL maintain per-chat checkpoints for latest archived message, earliest verified covered message, latest live evidence, audit status, retry count, and next recovery attempt.

#### Scenario: Chats have different recovery windows
- **WHEN** one chat is missing ten hours of possible messages and another chat is missing one hour
- **THEN** the system records separate checkpoint and recovery windows for each chat

#### Scenario: Checkpoints survive restart
- **WHEN** the maintainer restarts after processing some chats
- **THEN** it resumes auditing from persisted per-chat checkpoints instead of starting from only a global timestamp

### Requirement: Gap Detection
The system SHALL detect suspected missing windows by comparing per-chat archive watermarks, imported backup bounds, live/offline event evidence, and connection downtime.

#### Scenario: Maintainer starts after backup import
- **WHEN** a backup was imported at 2:00 PM and the maintainer first starts the next day at 6:00 PM
- **THEN** the system evaluates each chat back to that chat's latest imported backup message and creates recovery windows where live/history evidence does not prove continuity

#### Scenario: Quiet chat requires deeper audit
- **WHEN** most chats have recent live messages but one chat's latest archived message is older than the required recovery lower bound
- **THEN** the system schedules deeper recovery for the older chat without forcing unnecessary backfill for the already-current chats

### Requirement: Bounded Backfill Recovery
The system SHALL attempt bounded, rate-limited backfill for suspected gaps using supported history-sync mechanisms and SHALL stop before configured per-chat limits are exceeded.

#### Scenario: Gap closes within configured limits
- **WHEN** a suspected missing window can be covered by history sync before reaching configured message/day limits
- **THEN** the system ingests the recovered messages and marks the gap closed

#### Scenario: Gap exceeds configured limits
- **WHEN** a suspected missing window still extends beyond configured backfill limits
- **THEN** the system stops automated recovery for that window and marks the chat as needing user action

#### Scenario: History API cannot prove continuity
- **WHEN** the selected WhatsApp Web client accepts a history request but does not return enough evidence to close the gap
- **THEN** the system marks the gap as uncertain rather than healthy

### Requirement: Eventually Consistent Health States
The system SHALL expose live sync health states for the overall maintainer and for each chat, including healthy, catching_up, uncertain, disconnected, and needs_user_action.

#### Scenario: Healthy chat
- **WHEN** a chat has no open suspected gaps and its latest live evidence has been archived
- **THEN** the chat health is reported as healthy

#### Scenario: Recovering chat
- **WHEN** a chat has an open suspected gap that is still within configured recovery limits
- **THEN** the chat health is reported as catching_up

#### Scenario: User action required
- **WHEN** a chat cannot be proven complete because configured limits or client capability limits were reached
- **THEN** the chat health is reported as needs_user_action with the affected time window

### Requirement: Restart And Disconnect Resilience
The system SHALL automatically reconnect after transient disconnects and SHALL resume ingestion, auditing, and recovery from persisted local state.

#### Scenario: Temporary disconnect
- **WHEN** the network drops and later returns
- **THEN** the maintainer reconnects, processes offline/history events, and audits downtime-created gap windows

#### Scenario: Process crash during backfill
- **WHEN** the process exits while a chat recovery window is in progress
- **THEN** the next run reloads the open recovery window and continues or retries according to persisted retry state

### Requirement: Message State Updates
The system SHALL ingest supported live message updates, including edits, deletes, reactions, receipts, and call/system events, without requiring the original message to be re-imported from backup.

#### Scenario: Delete update arrives
- **WHEN** WhatsApp sends a delete event for an archived message
- **THEN** the system marks the archived message deleted while preserving its source identity and timestamp metadata

#### Scenario: Update arrives before base message
- **WHEN** a state update arrives before the base message is present in the archive
- **THEN** the system records the update as pending or warning-backed metadata and retries applying it after backfill or future ingestion

### Requirement: Privacy-Safe Diagnostics
The system SHALL provide maintainer diagnostics without logging backup keys, live auth secrets, message bodies, raw contact dumps, or raw protocol payload dumps by default.

#### Scenario: Sync warning recorded
- **WHEN** the maintainer records a history-sync warning
- **THEN** the warning contains severity, code, affected chat/message identifiers where safe, and recovery context without message bodies or auth material

#### Scenario: User requests detailed debug output
- **WHEN** the user explicitly enables debug diagnostics
- **THEN** the system stores diagnostics under the private workspace and warns that the output may contain sensitive WhatsApp data

### Requirement: Local Control Surfaces
The system SHALL expose local CLI and API controls for pairing, starting, stopping, inspecting health, listing gaps, retrying recovery, and unlinking live session state.

#### Scenario: Inspect sync health
- **WHEN** the user requests live maintainer status
- **THEN** the system returns connection state, run status, aggregate counts, open gap count, and per-chat health summaries from local state

#### Scenario: Retry a specific gap
- **WHEN** the user retries recovery for a chat gap that is still within configured limits
- **THEN** the system schedules that gap for another bounded recovery attempt

### Requirement: Dependency Safety Checks
The system SHALL refuse to run the live maintainer with known-vulnerable WhatsApp Web client versions and SHALL include dependency status in doctor checks.

#### Scenario: Known vulnerable client version
- **WHEN** the installed live client version is listed as known vulnerable by project-maintained checks
- **THEN** the maintainer refuses to start and reports the minimum safe version

#### Scenario: Doctor checks live dependency
- **WHEN** the user runs doctor checks
- **THEN** the output includes whether the optional live maintainer dependency is installed, supported, and not known vulnerable
