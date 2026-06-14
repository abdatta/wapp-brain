## Why

The current archive UI exposes technical import and paging mechanics more than the familiar WhatsApp browsing experience users expect after data is loaded. Event-only chats, always-visible import fields, manual older-message loading, and generic system-message styling make it harder to validate an imported archive quickly.

## What Changes

- Hide chats that contain no user-visible message exchanges by default, while preserving access to chats that have text, media, call, deleted, or otherwise meaningful message records.
- Collapse the import form once the local archive already contains data, leaving import/re-import available on demand without occupying the default browsing surface.
- Restyle the chat thread to more closely match WhatsApp conversation behavior, including incoming/outgoing bubbles, compact centered system messages, date separators, and a conversation-focused layout.
- Anchor newly selected chats at the newest messages near the bottom of the thread.
- Replace the manual "Load older messages" action with automatic older-page loading when the user scrolls upward near the top of the thread, while preserving scroll position as older messages are prepended.
- Keep all browsing and import behavior local to the existing local API and SQLite archive.

## Capabilities

### New Capabilities
- `browse-worthy-chat-list`: Defines which chats appear in the default chat list and how users can still reach event-only conversations when needed.
- `whatsapp-style-thread-view`: Defines the collapsed import experience, WhatsApp-like message rendering, bottom anchoring, and automatic older-message loading behavior.

### Modified Capabilities
- None.

## Impact

- Affected client code: `src/client/App.tsx`, `src/client/styles.css`, and `src/client/api.ts`.
- Affected API/repository code: `/api/chats`, `ArchiveRepository.listChats`, `SqliteArchiveRepository.listChats`, and the in-memory repository used by tests.
- Affected shared types: chat list query options and, if needed, chat/message metadata for visible-message counts or event-only classification.
- Affected tests: synthetic importer/repository tests for hidden event-only chats, chat list filtering, initial import panel collapse state, bottom-anchored thread loading, and automatic older-message paging.
- No new external services or remote data movement are introduced.
