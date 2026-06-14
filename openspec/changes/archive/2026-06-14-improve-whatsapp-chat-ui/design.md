## Context

Wapp Store currently has a single React/Vite UI backed by local Express endpoints and a SQLite archive repository. The chat list returns all chats by default, including chats whose only records are WhatsApp system/status/event rows. The import form is always expanded in the sidebar, even after an archive has been initialized and imported. Message browsing already requests newest pages from `/api/chats/:id/messages?order=desc`, sorts those pages chronologically in the client, and exposes a manual "Load older messages" button.

This change keeps the local-first architecture intact. It improves the default browsing experience without moving message data outside the local process or adding remote services.

## Goals / Non-Goals

**Goals:**

- Make the default chat list favor conversations with user-visible exchanges.
- Preserve access to event-only chats through an explicit UI/API option.
- Collapse import controls after archive data exists, while keeping re-import available.
- Render message threads closer to WhatsApp, including compact centered system messages and right/left aligned bubbles.
- Open chats at the newest messages and automatically load older pages as the user scrolls upward.
- Preserve scroll position when prepending older pages.

**Non-Goals:**

- No WhatsApp network sync, live ingestion, or WhatsApp Web scraping.
- No media file serving or copying beyond existing placeholders.
- No hosted search, LLM, vector database, or remote analytics.
- No large data migration unless a lightweight chat statistic is required for performant filtering.

## Decisions

1. Classify browse-worthy chats in the repository layer.

   The default `/api/chats` behavior should exclude event-only chats by asking the repository for chats with at least one meaningful user-visible record. A meaningful record is any message that represents a conversation exchange, such as incoming/outgoing text, captions, media placeholders, calls, deleted messages, or unknown message rows that carry user-facing content. Rows classified as pure system/status/event notifications do not make a chat browse-worthy by themselves.

   Alternative considered: filter event-only chats only in React after fetching. That would make pagination inaccurate because a page could contain fewer than the requested number of visible chats and could skip later browse-worthy chats.

2. Add an explicit include-event-only chat-list option.

   The UI should default to hiding event-only chats but offer a compact control to include them when the user wants to inspect import completeness. The API should accept a boolean query option rather than a separate endpoint so search, type filters, and pagination keep one code path.

   Alternative considered: create a separate "Events" chat category. That would complicate the existing chat type filter and blur the distinction between chat type and visibility policy.

3. Keep newest-first message paging at the API boundary.

   The existing message endpoint already supports descending paging efficiently and tests cover newest-window access. The client should continue requesting `order=desc`, merge and de-duplicate pages, sort the accumulated window chronologically for rendering, and use a top sentinel to load older pages.

   Alternative considered: switch the API to ascending keyset pagination. That could be cleaner long term, but it is a broader contract change and is not required to implement WhatsApp-like upward loading.

4. Manage scroll anchoring in the message pane.

   When a chat or message search changes, the client should render the newest page and scroll the message list to the bottom after layout. When older messages are prepended, the client should measure scroll height before and after the load and adjust `scrollTop` by the delta so the visible messages do not jump.

   Alternative considered: rely on browser scroll anchoring alone. It is inconsistent when grouped date separators, skeleton rows, and async React renders are involved.

5. Drive import panel collapse from status data.

   The import panel should start collapsed when `/api/status` reports existing archive data or a previous import run. It should remain expanded for an empty initialized archive so first-time setup is still obvious. Users can manually expand it for re-imports or enrichment imports.

   Alternative considered: persist collapse state only in local component state. That would not reliably reflect a newly imported archive after refresh or in another browser session.

## Risks / Trade-offs

- Event classification could hide a chat the user expected to see by default -> provide an "include event-only chats" control and keep search/type filters compatible with it.
- Counting browse-worthy messages dynamically could slow chat-list queries on large archives -> prefer a maintained aggregate if query profiling shows joins are too expensive, and cover it through `refreshChatStats`.
- Scroll restoration can be brittle across React renders -> isolate message list refs and verify with browser-level tests/manual inspection on long synthetic threads.
- Auto-loading older pages can over-fetch when users fling-scroll upward -> gate requests with `loadingMessages`, `messageHasMore`, and a top sentinel threshold.

## Migration Plan

- No destructive migration is required.
- If a new aggregate such as `visible_message_count` is added to `chats`, initialize it during database setup and refresh it through the existing `refreshChatStats` path.
- Existing archives should continue to open; the app can compute or backfill the new visibility statistic the next time stats are refreshed.
- Rollback is straightforward: remove the include-event-only option and return `/api/chats` to the existing all-chat query.

## Open Questions

- Should the event-only visibility control be a small toolbar toggle near chat filters or an option in the chat type segmented control? The implementation should choose the least intrusive placement that fits the current sidebar.
