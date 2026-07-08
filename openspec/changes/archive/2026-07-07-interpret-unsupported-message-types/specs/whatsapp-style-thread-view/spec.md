# Delta Spec: whatsapp-style-thread-view (interpret-unsupported-message-types)

## MODIFIED Requirements

### Requirement: Render messages in a WhatsApp-like thread
The UI SHALL render message records with a conversation layout that distinguishes incoming, outgoing, system, and unknown messages in a WhatsApp-like style. Placeholder labels MUST name the real message kind when it is knowable (poll, event, view-once photo, business template, photo album…) and MUST state the reason when it is not (encrypted update whose key is not held, legacy message of an unrecognized type); a bare "Unsupported message" is not an acceptable rendering.

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
- **THEN** the UI shows a concise placeholder label naming the message kind, without exposing raw database fields

#### Scenario: Unreadable messages state why
- **WHEN** a message cannot be interpreted — an encrypted update whose key the archive does not hold, or a legacy row of an unrecognized type
- **THEN** the placeholder states the reason ("Encrypted edit — key not held", "Legacy message") instead of a bare "Unsupported message"

#### Scenario: Date separators remain visible
- **WHEN** messages span multiple days
- **THEN** the UI groups them chronologically and displays compact date separators between day groups
