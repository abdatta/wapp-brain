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
The system SHALL normalize live WhatsApp contacts, chats, participants, messages, and message state updates into the archive using canonical identity keys: chats by canonical JID, messages by canonical chat JID plus WhatsApp message id. Source- or sender-form variance MUST NOT fork identity.

#### Scenario: Duplicate live message event
- **WHEN** the same WhatsApp message is received through real-time sync and later through history sync
- **THEN** the archive contains one message record updated with the best available metadata rather than duplicate messages

#### Scenario: Backup and live source overlap
- **WHEN** a message already imported from backup is later observed by live sync with the same WhatsApp message id in the same canonical chat
- **THEN** the system upserts the existing archive message instead of creating a second copy

#### Scenario: Sender-form variance does not duplicate
- **WHEN** the same message arrives once under a sender's LID form and once under their phone form
- **THEN** the archive contains one message record

### Requirement: Live Sync Run Tracking
The system SHALL track live maintainer runs, connection state, event counts, warning counts, and failure summaries separately from backup import runs.

#### Scenario: Maintainer run completes normally
- **WHEN** the user stops a healthy live maintainer run
- **THEN** the system records the run status, timestamps, totals, and warning count without changing prior backup import run records

#### Scenario: Maintainer run fails
- **WHEN** the live maintainer crashes or disconnects with an unrecoverable local error
- **THEN** the system records a failed live run with a privacy-safe error summary and preserves restartable checkpoints

### Requirement: Per-Chat Checkpoints
The system SHALL maintain per-chat checkpoints for latest archived message, earliest verified covered message, latest live evidence, audit status, retry count, and next recovery attempt, keyed by canonical chat identity. When chats merge through a late identity mapping, their checkpoints and gap windows SHALL follow the merge instead of orphaning under the stale identity.

#### Scenario: Chats have different recovery windows
- **WHEN** one chat is missing ten hours of possible messages and another chat is missing one hour
- **THEN** the system records separate checkpoint and recovery windows for each chat

#### Scenario: Checkpoints survive restart
- **WHEN** the maintainer restarts after processing some chats
- **THEN** it resumes auditing from persisted per-chat checkpoints instead of starting from only a global timestamp

#### Scenario: Checkpoints follow identity merges
- **WHEN** a LID-form chat with checkpoints and open gaps merges into its canonical chat
- **THEN** auditing and recovery continue under the canonical chat without losing retry state or reopening resolved windows

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

### Requirement: Silent Companion Device With Media-Retry Exception

The live client SHALL behave as a silent companion device: it MUST NOT send message sends, read receipts, played receipts, presence, typing indicators, chat modifications, deletes, or group/profile writes. The ONLY outbound WhatsApp traffic the system may originate is a media re-upload request used to recover expired media. This exception MUST be implemented as an explicit, auditable allowance so that every receipt- and presence-related method remains blocked, preserving the property that archiving media never marks a view-once message as opened.

#### Scenario: Receipt and presence methods stay blocked

- **WHEN** any code path attempts to send a read receipt, played receipt, presence, typing, delete, or chat modification through the live client
- **THEN** the attempt is refused, exactly as before this change

#### Scenario: Media re-upload is the only permitted outbound

- **WHEN** the media layer needs to recover expired media
- **THEN** it may send a media re-upload request, and no other outbound WhatsApp method is enabled by that allowance

#### Scenario: Archiving does not mark messages opened

- **WHEN** the maintainer downloads media, including view-once media
- **THEN** no read or played receipt is sent, so the sender's and user's view-once state is unchanged

### Requirement: Live Ingestion Drives Media Download

Live ingestion SHALL, in addition to persisting message records, capture the media descriptor of media-bearing messages and enqueue them for background download through the durable media queue, on both real-time and history-sync event paths. Supporting media download without capturing the descriptor from the live event — where it is available before normalization — does not satisfy this requirement.

#### Scenario: Real-time media is enqueued

- **WHEN** a real-time media message is ingested
- **THEN** its descriptor is captured and enqueued for download

#### Scenario: History-sync media is enqueued

- **WHEN** media-bearing messages arrive through history sync
- **THEN** their descriptors are captured and enqueued for download the same way as real-time media

### Requirement: Edit History Retention

When a live edit is applied to an archived message, the system SHALL first snapshot the message's current content as a retained revision (revision order, content, edit time) keyed to the message's canonical identity, so the pre-edit content is never lost. Applying multiple edits SHALL retain each prior revision in order. Revision retention applies to edits observed live; the system MUST NOT fabricate history for edits that predate observation.

#### Scenario: Edit preserves the prior version

- **WHEN** a live edit arrives for an archived message
- **THEN** the pre-edit content is stored as a revision before the message reflects the edited content

#### Scenario: Multiple edits accumulate revisions

- **WHEN** a message is edited more than once while observed live
- **THEN** each prior version is retained as an ordered revision

#### Scenario: Unobserved edits claim no history

- **WHEN** a message was already edited before the archive ever observed it
- **THEN** the message may carry an edited indication but presents no fabricated prior revisions

### Requirement: Live Reply Snapshot Capture
The live maintainer SHALL capture a reply's one-level quoted-message snapshot from Baileys `ContextInfo` on both real-time `messages.upsert` and `messaging-history.set` paths. It SHALL retain `stanzaId`, quoted `participant`, optional cross-chat `remoteJid`, and the available `quotedMessage` content; normalize the embedded message into the same durable quoted-snapshot contract used by backup import; canonicalize quoted sender/source-chat identities; preserve all available text without local truncation; and capture only embedded structured metadata and thumbnail bytes. It MUST NOT recursively retain a quoted message's own context or enqueue/download quoted media separately. When `quotedMessage` is absent or unsupported, live ingestion SHALL retain the pointer and continue without fabricating snapshot content.

#### Scenario: Real-time text reply captures its snapshot
- **WHEN** a `messages.upsert` message carries `contextInfo.stanzaId`, `participant`, and a text `quotedMessage`
- **THEN** the archived reply owns a quoted snapshot with the original key, canonical quoted sender, and complete available text without requiring a backup re-import

#### Scenario: History-sync structured reply captures its snapshot
- **WHEN** `messaging-history.set` delivers a reply whose `quotedMessage` is an image, location, contact, or other supported structured type
- **THEN** the snapshot stores its deterministic type context, caption or structured fields, and embedded thumbnail when present through the same normalizer used by real-time delivery

#### Scenario: Reply Privately retains its source chat
- **WHEN** a one-to-one live reply quotes a group message and `ContextInfo.remoteJid` names that group
- **THEN** the snapshot records the canonical group source-chat JID and quoted key without querying or moving the original into the one-to-one chat

#### Scenario: Context is found on non-text reply content
- **WHEN** WhatsApp attaches reply `contextInfo` to a supported visible content type other than extended text or the current media subset
- **THEN** generalized context discovery still captures the pointer and quoted snapshot instead of silently dropping them

#### Scenario: Quoted identities follow late canonicalization
- **WHEN** the quoted participant or source chat arrives in LID/device form and the same event teaches a canonical identity mapping
- **THEN** maintainer canonicalization applies the mapping to the snapshot just as it does to the outer message and no duplicate quoted identity is created

#### Scenario: Quoted owner is labelled as the archive owner
- **WHEN** a live snapshot's quoted participant is the linked WhatsApp account
- **THEN** downstream projection resolves that participant to the archive owner's label rather than an unresolved number or raw device JID

#### Scenario: Pointer-only live reply remains ingestible
- **WHEN** live `ContextInfo` contains `stanzaId` but no usable `quotedMessage`
- **THEN** the reply ingests with its pointer, no snapshot content is invented, and the bounded same-chat/generic fallback remains available

#### Scenario: Quoted media is not downloaded independently
- **WHEN** a live `quotedMessage` contains media metadata or an embedded thumbnail
- **THEN** the thumbnail and safe metadata may be stored locally but no media descriptor or remote download is created for the snapshot itself

#### Scenario: Repeated live and backup observations enrich one snapshot
- **WHEN** real-time, history-sync, or backup ingestion observes the same canonical reply more than once
- **THEN** the archive keeps one message and monotonically enriches its one owned snapshot without erasing previously captured fields
