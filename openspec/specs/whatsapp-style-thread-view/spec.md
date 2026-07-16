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
The UI SHALL address the thread view as the route `/chats/:id` and load the newest message window
for that chat, positioning the message pane at the bottom after the first page renders. Selecting a
chat from the list SHALL navigate to `/chats/:id` rather than switching an in-component panel. A
specific message SHALL be addressable as `/chats/:id?at=<messageId>`, which loads a window centered
on that message and scrolls it into view instead of anchoring at the bottom.

#### Scenario: Selecting a chat scrolls to bottom
- **WHEN** the user selects a chat with more messages than the first page size
- **THEN** the app navigates to `/chats/:id`, the newest available messages are displayed, and the scroll position is anchored near the bottom of the thread

#### Scenario: Message search resets to newest matching results
- **WHEN** the user changes the message search query for a selected chat
- **THEN** the loaded message window resets to the newest matching results and the scroll position moves near the bottom

#### Scenario: Anchored deep link centers on a message
- **WHEN** the thread is opened at `/chats/:id?at=<messageId>` (by a search hit or a direct/reloaded link)
- **THEN** the UI loads a window centered on that message and scrolls it into view, and exiting the window ("Latest messages") returns to `/chats/:id` at the newest messages

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

When a deleted message's content was captured before deletion, the UI SHALL render that content—text, media, and structured attachments—decorated with a clear deletion indicator rather than replacing it with a bare “Deleted message” label. The label-only rendering SHALL appear only when no content was captured. Every deleted message SHALL offer a deletion-detail view when any provenance exists; that view SHALL show original send time, delete/revoke time, actor/admin and deletion kind when known, source observations, and whether content was retained or never captured. Unknown values SHALL be labelled unavailable rather than inferred.

#### Scenario: Deleted text keeps its content

- **WHEN** a message whose text was archived is deleted by the sender
- **THEN** the bubble still shows the text with a visible deleted marker

#### Scenario: Deleted media keeps its media

- **WHEN** a message whose media was archived is deleted by the sender
- **THEN** the media remains viewable in the thread with a visible deleted marker

#### Scenario: Uncaptured deletions stay placeholders

- **WHEN** a deleted message has no captured content
- **THEN** the UI shows the “Deleted message” placeholder and makes the existing Deleted state chip the available detail control, without adding a second deletion-detail button

#### Scenario: Deleted state chip reuses the detail action

- **WHEN** deletion provenance is available for any non-grid message bubble
- **THEN** the existing Deleted chip is keyboard-accessible and opens deletion details, matching the Edited chip interaction pattern

#### Scenario: Deletion detail compares send and delete times

- **WHEN** both original message time and deletion time are held
- **THEN** the detail panel shows both exact times distinctly and may show their elapsed duration

#### Scenario: Missing deletion fields are not guessed

- **WHEN** actor, deletion kind, or deletion time is unavailable
- **THEN** the detail panel marks that field unavailable and does not substitute the sender, owner, or message time

### Requirement: Links Are Clickable With Offline Preview Cards

The UI SHALL detect URLs in message text, highlight them, and make them clickable (opening outside the archive UI). When a message carries stored link-preview data (title/description/thumbnail), the UI SHALL render a compact preview card from the stored data without contacting the link target.

#### Scenario: URLs are clickable

- **WHEN** a message body contains a URL
- **THEN** the URL is visually highlighted and clicking it opens the link

#### Scenario: Stored previews render offline

- **WHEN** a message has stored link-preview data
- **THEN** the UI renders a preview card from stored data without any remote fetch

### Requirement: Edited Messages Show State And History

The UI SHALL mark edited messages with an “edited” indicator and SHALL offer one ordered edit-history view whenever edit metadata exists, regardless of whether prior text was retained. The history SHALL show original send time and every available edit time as distinct timestamps. Held prior versions SHALL show their text; metadata-only backup events SHALL show an explicit “Original text was not retained” timeline entry, a source explanation, and current content without pretending that unavailable text was recovered.

#### Scenario: Edited marker is shown

- **WHEN** an edited message is rendered
- **THEN** the bubble carries an "edited" indicator

#### Scenario: Edit history is viewable when held

- **WHEN** the user opens edit history on a message with retained revisions
- **THEN** original and edited versions display in order with their applicable send/edit times

#### Scenario: Metadata-only history remains viewable

- **WHEN** a backup proves an edit time but does not retain the original body or caption
- **THEN** the edited indicator opens a chronological timeline showing original send time, “Original text was not retained,” available edit time, current content, and the source of the edit record

#### Scenario: Missing timestamp stays unknown

- **WHEN** an edit event lacks its own source timestamp
- **THEN** the timeline labels that edit time unavailable and does not substitute original send time or import time

### Requirement: Render Reply Quote Previews
The thread UI SHALL render a reply's resolved quoted-message context as an offline WhatsApp-style preview above the reply's own content. The preview SHALL use the captured snapshot before a resolvable same-chat original, SHALL show the resolved quoted sender and complete available semantic context, and SHALL never fabricate unavailable content. Long preview text SHALL be line-clamped with an ellipsis by default and expandable in place without changing the full stored/API value. When the original is archived in the same chat, the preview itself SHALL be an accessible jump target through the existing anchor-centered thread route. Captured quote thumbnails and metadata SHALL be served only from the local archive and SHALL trigger no remote fetch.

#### Scenario: Text reply shows sender and quote bubble
- **WHEN** a thread message carries a captured text snapshot
- **THEN** a tinted quoted-message preview above the reply shows the resolved quoted sender and quoted text

#### Scenario: Live reply appears without backup re-import
- **WHEN** live sync archives a reply carrying an embedded quoted snapshot
- **THEN** the thread shows the same quoted-message preview shape used for backup-imported replies as soon as the archive change reaches the client

#### Scenario: Long quote expands without data loss
- **WHEN** captured quoted text exceeds the preview's default line clamp
- **THEN** the UI shows an ellipsis and a show-more control, expanding reveals the complete API-provided text, and collapsing changes only display state

#### Scenario: Structured quote has useful context
- **WHEN** a reply quotes an image, location, or vCard snapshot
- **THEN** the preview shows the captured caption/thumbnail or deterministic type-specific context instead of a bare unsupported-media marker

#### Scenario: Same-chat original is unobtrusively jumpable
- **WHEN** the quoted original resolves to an archived message in the reply's chat
- **THEN** the preview itself is an accessible jump target to `/chats/:id?at=<messageId>`, gains a subtle hover/focus treatment and pointer cursor without a visible jump button, and loads/highlights the original even when it is outside the current page

#### Scenario: Cross-chat or deleted original remains readable
- **WHEN** a snapshot exists but no original message resolves in the current chat
- **THEN** the preview remains readable from the snapshot with no fabricated jump target, hover treatment, or pointer cursor

#### Scenario: Pointer-only reply retains compatibility
- **WHEN** a reply has no captured snapshot but its legacy pointer resolves to an archived same-chat message
- **THEN** the thread shows a bounded preview from that original and preserves the jump action

#### Scenario: Missing context stays honest
- **WHEN** a reply has neither a captured snapshot nor a resolvable original
- **THEN** the thread does not invent a quoted sender, text, thumbnail, or jump target

#### Scenario: Quote preview is fully local
- **WHEN** a preview contains a captured thumbnail or structured metadata
- **THEN** rendering uses only local API data and local asset routes without contacting WhatsApp or the quoted content's origin

### Requirement: Structured Location And VCard Cards
The thread UI SHALL render message-owned locations and vCards as compact structured cards that are visually distinct from ordinary text. A location card SHALL identify static versus live location and show every available owner-visible field in a scannable hierarchy, including coordinates and timing/quality metadata. A vCard card SHALL show every captured card, its parsed properties, source/resolution status, and an available `.vcf` download action. Detail expansion MUST use only local archive data and MUST NOT automatically fetch map tiles, contact photos, or link targets.

#### Scenario: Static location is visibly structured
- **WHEN** a message owns a static location with coordinates and place context
- **THEN** the bubble renders a dedicated location card with a static-location label, coordinates, available name/address/URL/comment, and no text-message imitation

#### Scenario: Live location exposes all retained details compactly
- **WHEN** a message owns live-location state or observations
- **THEN** its card is visibly labelled live and exposes available accuracy, speed, heading, sequence, offset, duration/final time, caption, observation times, and coordinates through a compact summary plus detail expansion

#### Scenario: Generated location label is not repeated
- **WHEN** WhatsApp supplies a generated “Location” or “Live location” label for a message whose structured location card is available
- **THEN** the bubble shows the label only in the structured clickable card, while any genuine authored text or caption remains visible

#### Scenario: Multiple vCards remain distinct
- **WHEN** a message owns multiple vCards
- **THEN** the UI preserves their order, shows each card's complete local detail, and offers an individual download for every downloadable card

#### Scenario: Generated contact count is not repeated
- **WHEN** WhatsApp stores a generated body such as “2 contacts” for a message whose structured vCards are available and no caption exists
- **THEN** the bubble shows only the structured clickable contact card and does not repeat the generated count as ordinary message text

#### Scenario: Constructed vCard is labelled
- **WHEN** a `.vcf` download is constructed because no complete source body is held
- **THEN** the UI identifies it as constructed and does not imply that guessed or unavailable properties came from WhatsApp

#### Scenario: Existing link preview remains unchanged
- **WHEN** the same message or a neighboring message carries a stored link preview
- **THEN** its title, description, canonical URL, and embedded thumbnail continue to render through the existing offline preview card without a remote fetch

### Requirement: Inline Mentions Need No Count Footer
Resolved mentions SHALL continue to render inline with the existing blue/highlighted mention treatment, using authoritative structured identities where available. The thread SHALL NOT append a redundant structured-mention count row beneath the message. Unresolved mention tokens SHALL remain visible and MUST NOT be replaced by a count-only annotation.

#### Scenario: Resolved mentions stay highlighted
- **WHEN** a message contains one or more structured mentions that resolve to local labels
- **THEN** every corresponding inline token remains highlighted and no “N structured mentions” footer appears

#### Scenario: Unresolved mention stays honest
- **WHEN** a structured mention has no resolvable display label
- **THEN** its original inline token remains visible and the UI does not hide it behind a summary count

### Requirement: Expandable Source Interpretation Detail
When a message carries source-provided accessibility text, a complete transcription, or timed transcription segments, the thread SHALL render a concise accessible control that opens the complete local detail. The detail SHALL identify the source-provided kind, show untruncated text, preserve segment order and available start/end times, and distinguish it from model-generated interpretation.

#### Scenario: Transcript expands from the bubble
- **WHEN** a message has a source transcription
- **THEN** the bubble shows a compact “Transcript” control whose detail view displays the complete text and provenance

#### Scenario: Accessibility label expands from the bubble
- **WHEN** a message has a source accessibility label
- **THEN** the bubble shows a compact accessibility-detail control rather than only saying that a label was captured

#### Scenario: Timed segments are readable
- **WHEN** a transcript contains ordered timed segments
- **THEN** the detail view presents them in order with each available start/end time and does not truncate the stored segment text

### Requirement: Role-Correct System Events And Details
System-event chips SHALL describe the verified semantic action using distinct actor and affected-subject roles. “You” SHALL appear only for the role whose canonical identity is the archive owner. Other roles SHALL display a resolved name, otherwise a complete verified phone number, otherwise “Unknown.” LIDs and other internal identifiers do not count as a user-readable identity and MUST NOT appear in summaries. Missing roles MUST NOT silently become the owner. Each verified or generic system chip SHALL offer local details when additional retained fields exist, including exact event/send times, actor/participant identities, number-change endpoints, old/new metadata values, source observations, raw type, and raw parameters.

#### Scenario: Actor and subject are different people
- **WHEN** a verified event says one participant added, removed, promoted, or demoted another
- **THEN** the chip names the actor as the doer and the affected participant as the subject in the correct grammatical positions

#### Scenario: Unknown actor stays unknown
- **WHEN** an event identifies the affected participant but not the actor
- **THEN** the chip says that “Unknown” performed the action and never attributes it to “You”

#### Scenario: Phone is preferred over unknown
- **WHEN** a system role has no name but has a verified complete phone number
- **THEN** the chip and detail use the phone number so different unnamed people remain distinguishable

#### Scenario: Owner is only the affected participant
- **WHEN** another participant added or removed the archive owner
- **THEN** the chip says that participant added or removed “you,” not that “You” performed the action

#### Scenario: Unsupported event exposes honest details
- **WHEN** a system message has an unrecognized semantic type but retained raw type/parameters
- **THEN** the chip says “Unclassified system event” while its local detail view explains the uncertainty and exposes those retained raw fields without guessing a human action

### Requirement: Detail Views Stay Focused And Time-Honest
Each message-owned detail control SHALL open a view scoped to the signal family the user selected. A system, location, vCard, deletion, or source-interpretation view MUST NOT include an unrelated edit-history section merely because the same message owns edit metadata. Detail dialogs SHALL render in a top-level opaque surface so underlying thread text and controls cannot show through their content. Detail timestamps SHALL include enough precision to distinguish separate retained events, and a missing event timestamp MUST remain unavailable rather than reuse the message send time.

#### Scenario: Popup content is visually isolated
- **WHEN** any message detail or edit-history dialog opens over a busy thread
- **THEN** its content surface is fully opaque and is not dimmed or made translucent by the owning message bubble

#### Scenario: System event does not imply an edit history
- **WHEN** the user opens a system-event detail view
- **THEN** the view contains only that event or bundled event records and their source details, with no edit timeline

#### Scenario: Structured attachment opens its own detail
- **WHEN** the user opens location, vCard, deletion, transcript, or accessibility details
- **THEN** the view contains only the selected signal family even if the owning message has other structured signals

#### Scenario: Close event times remain visibly distinct
- **WHEN** send, edit, or delete events occur within the same minute and their source timestamps are available
- **THEN** the relevant view displays year and seconds so the retained times do not appear identical
