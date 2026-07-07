# Delta Spec: live-whatsapp-maintainer (make-live-sync-trustworthy)

## MODIFIED Requirements

### Requirement: Gap Detection
The system SHALL detect suspected missing windows by comparing per-chat archive watermarks, imported backup bounds, live/offline event evidence, platform-provided chat recency metadata, and connection downtime.

Suspected-gap lower bounds SHALL derive from verified evidence such as the chat's latest archived message, the platform-reported latest conversation activity, or the session's last connected time. The system MUST NOT use the current wall-clock time as a per-chat required lower bound, and MUST NOT open a gap for a chat when no evidence suggests that missing messages exist.

#### Scenario: Maintainer starts after backup import
- **WHEN** a backup was imported at 2:00 PM and the maintainer first starts the next day at 6:00 PM
- **THEN** the system evaluates each chat back to that chat's latest imported backup message and creates recovery windows where live/history evidence does not prove continuity

#### Scenario: Maintainer starts after downtime
- **WHEN** the maintainer process starts (including first start after machine boot) and the session was previously connected at an earlier time
- **THEN** the system audits the downtime window between the last connected time and now without requiring an in-process disconnect to have occurred

#### Scenario: Quiet chat requires deeper audit
- **WHEN** most chats have recent live messages but one chat's latest archived message is older than the required recovery lower bound
- **THEN** the system schedules deeper recovery for the older chat without forcing unnecessary backfill for the already-current chats

#### Scenario: Quiet chat with no missing evidence is not flagged
- **WHEN** the maintainer reconnects and a chat's latest archived message matches the platform-reported latest activity for that chat
- **THEN** the system does not open a gap for that chat

#### Scenario: Platform recency newer than archive opens a bounded gap
- **WHEN** platform chat metadata reports conversation activity newer than the chat's latest archived message
- **THEN** the system opens a gap bounded by the archive watermark and the reported activity time

### Requirement: Bounded Backfill Recovery
The system SHALL attempt bounded, rate-limited backfill for suspected gaps using supported history-sync mechanisms and SHALL stop before configured per-chat limits are exceeded.

Recovery SHALL run automatically on a periodic schedule while the maintainer is connected, without requiring a CLI flag or manual trigger. Gap closure SHALL be judged from history evidence actually ingested into the archive; a synchronous request acknowledgement alone MUST NOT close a gap.

#### Scenario: Recovery runs without user action
- **WHEN** the maintainer is connected and at least one gap is open and due
- **THEN** the system attempts bounded recovery for due gaps on its own schedule without any user or CLI interaction

#### Scenario: Gap closes when history evidence arrives asynchronously
- **WHEN** a history request is acknowledged and the requested messages later arrive through history-sync events that cover the gap's required lower bound
- **THEN** the system marks the gap closed after the covering evidence is ingested, not at acknowledgement time

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

The system SHALL distinguish actionable problems from unprovable uncertainty. `needs_user_action` SHALL be reserved for conditions a user can actually resolve. Windows that cannot be proven because of platform history limits or long-quiet chats SHALL be reported as grouped uncertainty summaries rather than as individual urgent alerts.

#### Scenario: Healthy chat
- **WHEN** a chat has no open suspected gaps and its latest live evidence has been archived
- **THEN** the chat health is reported as healthy

#### Scenario: Recovering chat
- **WHEN** a chat has an open suspected gap that is still within configured recovery limits
- **THEN** the chat health is reported as catching_up

#### Scenario: User action required
- **WHEN** a chat cannot be proven complete because configured limits were reached and a concrete user action (such as importing a fresher backup or retrying recovery) could resolve it
- **THEN** the chat health is reported as needs_user_action with the affected time window

#### Scenario: Many chats share the same platform limitation
- **WHEN** many chats cannot be proven complete because the platform provides no history evidence for old quiet windows
- **THEN** the health summary reports them as one grouped uncertainty count with a shared explanation instead of listing each chat as an individual urgent gap

### Requirement: Restart And Disconnect Resilience
The system SHALL automatically reconnect after transient disconnects and SHALL resume ingestion, auditing, and recovery from persisted local state.

At process start, the system SHALL reconcile persisted session and run state with reality: a session recorded as connected or a run recorded as running with no live maintainer actually running MUST be corrected before being reported. When the platform reports that the device has been logged out or unlinked, the system MUST stop automatic reconnection and report a re-pair-required state instead of retrying indefinitely.

#### Scenario: Temporary disconnect
- **WHEN** the network drops and later returns
- **THEN** the maintainer reconnects, processes offline/history events, and audits downtime-created gap windows

#### Scenario: Process crash during backfill
- **WHEN** the process exits while a chat recovery window is in progress
- **THEN** the next run reloads the open recovery window and continues or retries according to persisted retry state

#### Scenario: Stale connected status after crash
- **WHEN** the server starts and the persisted session says connected or a run says running, but no maintainer is active in this process
- **THEN** the system marks the session stopped (or interrupted) and the stale run as interrupted before serving status to any client

#### Scenario: Device logged out remotely
- **WHEN** the platform disconnect reason indicates the linked device was logged out or unlinked
- **THEN** the maintainer stops reconnecting, preserves the archive, reports a re-pair-required state, and offers re-pairing as the primary action

### Requirement: Message State Updates
The system SHALL ingest supported live message updates, including edits, deletes, reactions, and receipts, without requiring the original message to be re-imported from backup. The live client adapter SHALL subscribe to the platform events that carry these updates; supporting an update type in normalization or storage without subscribing to its source event does not satisfy this requirement.

Delete updates SHALL be applied as a tombstone on the original archived message, preserving its source identity, chat placement, and timestamp metadata. The revocation/system event itself MUST NOT be presented as if it were the deleted message. Reactions SHALL be applied as state on the target message rather than stored as standalone chat messages.

#### Scenario: Delete update arrives
- **WHEN** WhatsApp sends a delete event for an archived message
- **THEN** the system marks the archived original message deleted while preserving its source identity and timestamp metadata

#### Scenario: Delete cannot be matched
- **WHEN** a delete update arrives for a message that is not present in the archive
- **THEN** the system records an unmatched deletion update without pretending the original message is known, and retries applying it after later ingestion

#### Scenario: Edit update arrives
- **WHEN** WhatsApp sends an edit for an archived message
- **THEN** the archived message reflects the edited content while preserving its identity and an indication that it was edited

#### Scenario: Reaction arrives
- **WHEN** WhatsApp sends a reaction to an archived message
- **THEN** the reaction is recorded against the target message and does not appear as a separate standalone message bubble

#### Scenario: Update arrives before base message
- **WHEN** a state update arrives before the base message is present in the archive
- **THEN** the system records the update as pending or warning-backed metadata and retries applying it after backfill or future ingestion

## ADDED Requirements

### Requirement: Automatic Resume On Startup
The system SHALL automatically resume live sync when the server process starts and previously-paired linked-device credentials exist locally, without requiring any user action. Automatic resume MUST NOT trigger for sessions that were never paired, were explicitly unlinked, or are in a logged-out state, and the user SHALL be able to disable automatic resume via local configuration.

#### Scenario: Server restart with paired credentials
- **WHEN** the server starts and valid linked-device credentials from a prior explicit pairing exist
- **THEN** live sync resumes automatically, connects, and begins downtime auditing and recovery without user interaction

#### Scenario: No prior pairing
- **WHEN** the server starts and no linked-device credentials exist
- **THEN** the system does not connect to WhatsApp and waits for the user to explicitly link

#### Scenario: Logged-out session does not auto-resume
- **WHEN** the server starts and the persisted session state is logged out
- **THEN** the system does not attempt to connect and reports that re-pairing is required

### Requirement: Resume After Long Downtime
The archive-age baseline check SHALL apply only to initial linking. Resuming an existing paired session SHALL proceed regardless of how long the system was offline; windows that cannot be recovered or proven after long downtime SHALL be represented as gaps or grouped uncertainty rather than blocking sync.

#### Scenario: Resume after weeks offline
- **WHEN** the app resumes a paired session after being off longer than the configured backfill window
- **THEN** live sync connects, ingests what the platform provides, opens evidence-backed gaps for provable missing windows, and reports unprovable windows as grouped uncertainty instead of refusing to resume

#### Scenario: Initial linking still requires a baseline
- **WHEN** the user attempts to link WhatsApp for the first time without an imported archive baseline
- **THEN** the system still requires a backup import before linking

### Requirement: Live Chat Metadata Updates
The system SHALL ingest live group subject changes and group participant changes so archived group chats stay current without a re-import.

#### Scenario: Group subject changes
- **WHEN** a group's subject is changed while the maintainer is connected
- **THEN** the archived chat's display name is updated to the new subject

#### Scenario: Participants change
- **WHEN** participants are added to or removed from a group while the maintainer is connected
- **THEN** the archived participant records for that chat reflect the change

### Requirement: Resilient Event Ingestion
The system SHALL contain per-event ingestion failures so one bad event cannot silently kill live ingestion, and ingestion SHALL remain responsive as the archive grows.

#### Scenario: Malformed live event
- **WHEN** normalizing or persisting one live event throws an error
- **THEN** the system records a privacy-safe warning for that event, keeps the maintainer running, and continues processing subsequent events

#### Scenario: Large archive stays responsive
- **WHEN** the archive contains many chats and messages and live events arrive
- **THEN** per-event bookkeeping (stats, checkpoints) touches only the affected chats rather than recomputing the entire archive
