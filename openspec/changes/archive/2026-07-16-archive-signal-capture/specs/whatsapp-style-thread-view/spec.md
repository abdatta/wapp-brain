## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Edited Messages Show State And History

The UI SHALL mark edited messages with an “edited” indicator and SHALL offer one ordered edit-history view whenever edit metadata exists, regardless of whether prior text was retained. The history SHALL show original send time and every available edit time as distinct timestamps. Held prior versions SHALL show their text; metadata-only backup events SHALL show an explicit “Original text was not retained” timeline entry, a source explanation, and current content without pretending that unavailable text was recovered.

#### Scenario: Edited marker is shown

- **WHEN** an edited message is rendered
- **THEN** the bubble carries an “edited” indicator

#### Scenario: Edit history is viewable when held

- **WHEN** the user opens edit history on a message with retained revisions
- **THEN** original and edited versions display in order with their applicable send/edit times

#### Scenario: Metadata-only history remains viewable

- **WHEN** a backup proves an edit time but does not retain the original body or caption
- **THEN** the edited indicator opens a chronological timeline showing original send time, “Original text was not retained,” available edit time, current content, and the source of the edit record

#### Scenario: Missing timestamp stays unknown

- **WHEN** an edit event lacks its own source timestamp
- **THEN** the timeline labels that edit time unavailable and does not substitute original send time or import time
