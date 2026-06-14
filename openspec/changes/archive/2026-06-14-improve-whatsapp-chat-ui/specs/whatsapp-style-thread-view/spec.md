## ADDED Requirements

### Requirement: Collapse import controls after archive data exists
The UI SHALL collapse upload/import fields by default when status data shows that the local archive already contains imported data or a previous import run.

#### Scenario: Archive with data opens in browse mode
- **WHEN** the app loads and `/api/status` reports existing archive data or a previous import run
- **THEN** the import fields are hidden behind an explicit import/re-import control

#### Scenario: Empty archive shows import fields
- **WHEN** the app loads and `/api/status` reports no archive data and no previous import run
- **THEN** the import fields are visible so the user can perform the first import

#### Scenario: User expands import controls
- **WHEN** the import fields are collapsed and the user activates the import/re-import control
- **THEN** the upload/import fields become visible without clearing any already entered values

#### Scenario: Successful import collapses controls
- **WHEN** an import completes successfully
- **THEN** the import fields collapse and the archive browsing controls remain available

### Requirement: Render messages in a WhatsApp-like thread
The UI SHALL render message records with a conversation layout that distinguishes incoming, outgoing, system, and unknown messages in a WhatsApp-like style.

#### Scenario: Incoming and outgoing bubbles are aligned
- **WHEN** a selected chat contains incoming and outgoing messages
- **THEN** incoming messages appear as left-aligned bubbles and outgoing messages appear as right-aligned bubbles

#### Scenario: Group sender names are shown
- **WHEN** a selected group chat contains incoming messages with sender metadata
- **THEN** each incoming group message bubble shows the sender display name above or within the bubble

#### Scenario: System messages are compact and centered
- **WHEN** a selected chat contains system/status/event messages
- **THEN** those messages appear as compact centered system chips rather than normal incoming or outgoing bubbles

#### Scenario: Placeholder records remain understandable
- **WHEN** a message has no body or caption but represents deleted content, media, calls, or another supported placeholder
- **THEN** the UI shows a concise placeholder label without exposing raw database fields

#### Scenario: Date separators remain visible
- **WHEN** messages span multiple days
- **THEN** the UI groups them chronologically and displays compact date separators between day groups

### Requirement: Collapse status controls by default
The UI SHALL render the status area as a collapsed sidebar section by default, with status details and maintenance actions hidden until the user expands the section.

#### Scenario: Status section opens collapsed
- **WHEN** the app loads
- **THEN** the status section header is visible and status metrics, warnings, initialization, and cleanup controls are hidden

#### Scenario: User expands status controls
- **WHEN** the user activates the status section header
- **THEN** status metrics, warnings, initialization, and cleanup controls become visible

### Requirement: Open selected chats at the newest messages
The UI SHALL load the newest message window for a selected chat and position the message pane at the bottom after the first page renders.

#### Scenario: Selecting a chat scrolls to bottom
- **WHEN** the user selects a chat with more messages than the first page size
- **THEN** the newest available messages are displayed and the scroll position is anchored near the bottom of the thread

#### Scenario: Message search resets to newest matching results
- **WHEN** the user changes the message search query for a selected chat
- **THEN** the loaded message window resets to the newest matching results and the scroll position moves near the bottom

### Requirement: Automatically load older messages on upward scroll
The UI SHALL automatically request older message pages when the user scrolls near the top of the loaded thread and more matching messages are available.

#### Scenario: Older messages auto-load at top
- **WHEN** the user scrolls near the top of the currently loaded message window and older messages are available
- **THEN** the app requests the next older page without requiring a manual load button

#### Scenario: Scroll position is preserved after prepend
- **WHEN** older messages are prepended to the rendered thread
- **THEN** the message that was visible before loading remains in approximately the same viewport position

#### Scenario: Auto-load is gated while request is in flight
- **WHEN** an older-message request is already loading
- **THEN** additional top-of-thread scroll events do not start duplicate requests for the same page

#### Scenario: End of history stops auto-loading
- **WHEN** the API returns fewer messages than the requested page size
- **THEN** the UI treats the loaded window as the beginning of the matching history and stops requesting older pages
