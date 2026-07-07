## Purpose

Define which chats appear in the default archive chat list and how users can opt in to event-only conversations.

## Requirements

### Requirement: Hide event-only chats by default
The system SHALL exclude chats from the default chat list when every stored message for that chat is a system, status, or other non-exchange event.

#### Scenario: Event-only chat is hidden
- **WHEN** the archive contains a chat with only system/status/event rows and the user opens the default chat list
- **THEN** the chat list does not include that chat

#### Scenario: Chat with a user-visible exchange is shown
- **WHEN** the archive contains a chat with at least one incoming, outgoing, media, call, deleted, or content-bearing unknown message
- **THEN** the chat list includes that chat by default

#### Scenario: Empty archive remains empty
- **WHEN** the archive contains no imported chats or messages
- **THEN** the chat list remains empty and no event-only filtering error is shown

### Requirement: Preserve access to event-only chats
The system SHALL provide an explicit chat-list option that includes event-only chats without changing existing search, chat type, limit, or offset behavior.

#### Scenario: User includes event-only chats
- **WHEN** the user enables the include-event-only option
- **THEN** the chat list includes matching event-only chats along with browse-worthy chats

#### Scenario: Include option works with search
- **WHEN** the user searches for an event-only chat while the include-event-only option is enabled
- **THEN** matching event-only chats appear in the paginated search results

#### Scenario: Include option works with chat type filter
- **WHEN** the user selects a chat type filter while the include-event-only option is enabled
- **THEN** matching event-only chats of that chat type appear in the paginated results

### Requirement: Chat pagination remains stable after filtering
The system MUST apply browse-worthy filtering before limit and offset are applied.

#### Scenario: First page is filled from browse-worthy chats
- **WHEN** event-only chats sort ahead of browse-worthy chats in the archive
- **THEN** the default first page contains the next matching browse-worthy chats up to the requested limit

#### Scenario: Later pages do not skip browse-worthy chats
- **WHEN** the user loads additional chat pages while event-only chats are hidden
- **THEN** each page advances through the filtered result set without duplicating or skipping browse-worthy chats

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
