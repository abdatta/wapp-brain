# Delta Spec: browse-worthy-chat-list (make-live-sync-trustworthy)

## ADDED Requirements

### Requirement: WhatsApp-style conversation recency ordering
The system SHALL order the chat list by each chat's latest user-visible conversation message (incoming/outgoing exchanges, content-bearing messages, media, calls, and deleted placeholders). System, status, and reaction events MUST NOT advance a chat's recency or its displayed last-activity date, even though they remain visible inside the chat.

#### Scenario: System events do not reorder chats
- **WHEN** a chat receives only system events (membership changes, encryption notices) after its latest conversation message
- **THEN** the chat list keeps that chat sorted and dated by the latest conversation message

#### Scenario: New conversation messages reorder chats
- **WHEN** a chat receives a new incoming or outgoing message
- **THEN** the chat moves in the list according to that message's timestamp

#### Scenario: History sync noise does not shuffle the inbox
- **WHEN** live history sync ingests a large batch of system events across many chats
- **THEN** the relative order of chats by real conversation activity is unchanged
