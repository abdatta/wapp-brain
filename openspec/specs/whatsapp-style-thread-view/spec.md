## Purpose

Define the local archive thread browsing experience, including collapsed import controls, WhatsApp-like message rendering, newest-message anchoring, and automatic older-message loading.

## Requirements

### Requirement: Collapse import controls after archive data exists
The UI SHALL render import and re-import as a guided action entry point rather than inline raw path fields. When archive data exists, the archive browser remains the primary workspace and import/re-import opens the guided import wizard.

#### Scenario: Archive with data opens in browse mode
- **WHEN** the app loads and `/api/status` reports existing archive data or a previous import run
- **THEN** the import fields are hidden behind an explicit import/re-import action that opens the guided import wizard

#### Scenario: Empty archive shows onboarding import action
- **WHEN** the app loads and `/api/status` reports no archive data and no previous import run
- **THEN** the app shows a first-run onboarding surface with import backup as the primary action rather than raw path fields

#### Scenario: User opens import wizard
- **WHEN** the user activates the import/re-import action
- **THEN** the guided import wizard opens without clearing any already selected wizard state for the current session

#### Scenario: Successful import returns to browse mode
- **WHEN** an import completes successfully
- **THEN** the wizard completes, archive browsing controls remain available, and onboarding advances to the next setup action

### Requirement: Render messages in a WhatsApp-like thread
The UI SHALL render message records with a conversation layout that distinguishes incoming, outgoing, system, and unknown messages in a WhatsApp-like style. When a message's media is available in the archive, the UI SHALL render the media itself — image and video thumbnails that open to full size, an inline player for voice/audio, and a document row — rather than a text placeholder. When media is not available, the UI SHALL show a placeholder that names the real message kind and states the honest availability reason (still downloading, expired/unrecoverable, not captured, or missing from import). View-once media SHALL be visibly badged as view-once. Placeholder labels MUST name the real message kind when it is knowable (poll, event, view-once photo, business template, photo album…) and MUST state the reason when it is not (encrypted update whose key is not held, legacy message of an unrecognized type); a bare "Unsupported message" is not an acceptable rendering.

#### Scenario: Incoming and outgoing bubbles are aligned
- **WHEN** a selected chat contains incoming and outgoing messages
- **THEN** incoming messages appear as left-aligned bubbles and outgoing messages appear as right-aligned bubbles

#### Scenario: Group sender names are shown
- **WHEN** a selected group chat contains incoming messages with sender metadata
- **THEN** each incoming group message bubble shows the sender display name above or within the bubble

#### Scenario: System messages are compact and centered
- **WHEN** a selected chat contains system/status/event messages
- **THEN** those messages appear as compact centered system chips rather than normal incoming or outgoing bubbles

#### Scenario: Available media renders as viewable media
- **WHEN** a message has archived media
- **THEN** the UI renders the media — image/video thumbnail that opens full size, inline audio player, or document row — instead of a text placeholder

#### Scenario: Media loads lazily in long threads
- **WHEN** a long thread contains many media messages
- **THEN** media is loaded lazily as bubbles approach the viewport rather than all at once

#### Scenario: View-once media is badged
- **WHEN** an archived view-once photo, video, or voice note is rendered
- **THEN** the UI shows the media with a visible view-once badge

#### Scenario: Placeholder records remain understandable
- **WHEN** a message has no body or caption but represents deleted content, media, calls, or another supported placeholder
- **THEN** the UI shows a concise placeholder label naming the message kind, without exposing raw database fields

#### Scenario: Unavailable media states why
- **WHEN** a message is media but its bytes are not in the archive
- **THEN** the placeholder names the media kind and states the honest reason (downloading, expired/unrecoverable, not captured, or missing from import)

#### Scenario: Unreadable messages state why
- **WHEN** a message cannot be interpreted — an encrypted update whose key the archive does not hold, or a legacy row of an unrecognized type
- **THEN** the placeholder states the reason ("Encrypted edit — key not held", "Legacy message") instead of a bare "Unsupported message"

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

### Requirement: Consecutive Media Groups Into A Grid

The UI SHALL collapse runs of four or more consecutive media messages from the same sender within a short time window into a WhatsApp-style grid (with a "+N" overflow tile), instead of rendering each as a full-width bubble. Grouping SHALL be display-only: each item in the grid remains individually openable, and underlying messages are unchanged.

#### Scenario: Media spam collapses into a grid

- **WHEN** a sender posts many media items in quick succession
- **THEN** the thread shows them as a compact grid with an overflow count rather than a long scroll of separate media bubbles

#### Scenario: Grid items open individually

- **WHEN** the user taps an item or the overflow tile in a media grid
- **THEN** the individual media opens for full viewing, including the items beyond the overflow count

### Requirement: Deleted Messages Show Content With A Deletion Indicator

When a deleted message's content was captured before deletion, the UI SHALL render that content — text and media alike — decorated with a clear deletion indicator, rather than replacing it with a bare "Deleted message" label. The label-only rendering SHALL appear only when no content was captured.

#### Scenario: Deleted text keeps its content

- **WHEN** a message whose text was archived is deleted by the sender
- **THEN** the bubble still shows the text with a visible deleted marker

#### Scenario: Deleted media keeps its media

- **WHEN** a message whose media was archived is deleted by the sender
- **THEN** the media remains viewable in the thread with a visible deleted marker

#### Scenario: Uncaptured deletions stay placeholders

- **WHEN** a deleted message has no captured content
- **THEN** the UI shows the "Deleted message" placeholder

### Requirement: Links Are Clickable With Offline Preview Cards

The UI SHALL detect URLs in message text, highlight them, and make them clickable (opening outside the archive UI). When a message carries stored link-preview data (title/description/thumbnail), the UI SHALL render a compact preview card from the stored data without contacting the link target.

#### Scenario: URLs are clickable

- **WHEN** a message body contains a URL
- **THEN** the URL is visually highlighted and clicking it opens the link

#### Scenario: Stored previews render offline

- **WHEN** a message has stored link-preview data
- **THEN** the UI renders a preview card from stored data without any remote fetch

### Requirement: Edited Messages Show State And History

The UI SHALL mark edited messages with an "edited" indicator, and when prior revisions are held, SHALL offer a way to view the message's edit history in order. When no revisions are held, the indicator appears without a history view.

#### Scenario: Edited marker is shown

- **WHEN** an edited message is rendered
- **THEN** the bubble carries an "edited" indicator

#### Scenario: Edit history is viewable when held

- **WHEN** the user opens edit history on a message with retained revisions
- **THEN** prior versions display in order with their edit times

#### Scenario: No fabricated history

- **WHEN** an edited message has no retained revisions
- **THEN** the UI shows the edited indicator without offering a history view
