## 1. Chat List Filtering

- [x] 1.1 Extend shared chat-list query types and client API parameters with an `includeEventOnly` option.
- [x] 1.2 Update `/api/chats` to parse and pass the `includeEventOnly` option without changing existing search, type, limit, or offset behavior.
- [x] 1.3 Implement browse-worthy chat filtering in `SqliteArchiveRepository.listChats` before pagination is applied.
- [x] 1.4 Update the in-memory repository to match the SQLite browse-worthy filtering behavior used by tests.
- [x] 1.5 Add synthetic test coverage for default event-only chat hiding, explicit event-only inclusion, search/type compatibility, and stable pagination after filtering.

## 2. Collapsed Import Experience

- [x] 2.1 Add client state that derives the default import panel expanded/collapsed state from `/api/status` archive data and latest import information.
- [x] 2.2 Replace the always-expanded import form with a compact import/re-import control when archive data already exists.
- [x] 2.3 Preserve manual expansion behavior without clearing typed import paths or key-file values.
- [x] 2.4 Collapse the import fields after a successful import and refresh the archive status/chat list.
- [x] 2.5 Collapse the status section by default and reveal status details from its section header.

## 3. WhatsApp-Style Thread Rendering

- [x] 3.1 Refactor message rendering to distinguish normal bubbles from compact centered system/status/event chips.
- [x] 3.2 Improve placeholder labels for bodyless deleted, media, call, and supported non-text messages without exposing raw database fields.
- [x] 3.3 Update chat thread CSS for WhatsApp-like left/right alignment, compact date separators, readable bubble widths, and mobile-safe spacing.
- [x] 3.4 Keep group sender names visible for incoming group messages while preserving the existing privacy-safe data display.

## 4. Bottom Anchoring and Auto-Load

- [x] 4.1 Add message-list refs and reset markers so selecting a chat or changing message search scrolls to the newest messages at the bottom after render.
- [x] 4.2 Replace the manual older-message button with an automatic top-of-thread loader using scroll position or an intersection sentinel.
- [x] 4.3 Preserve viewport position when prepending older message pages by measuring scroll height before and after loading.
- [x] 4.4 Gate older-page requests while loading and stop auto-loading when the API returns fewer than the requested page size.

## 5. Verification

- [x] 5.1 Run `npm test` and update fixtures or assertions only with synthetic data.
- [x] 5.2 Run `npm run doctor`.
- [x] 5.3 Run `npm run build` for the frontend/API changes.
- [x] 5.4 Start the local app and inspect the UI in the browser for collapsed import controls, hidden event-only chats, bottom anchoring, and upward auto-loading.
