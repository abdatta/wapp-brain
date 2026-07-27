## Why

WhatsApp Status (`status@broadcast`) is not a real chat, but nothing in the system treats it that way: live sync ingests every status post as an ordinary message, media download has pulled 325 status blobs (848 MB) into the store, and the brain has already spent model budget synthesizing 3 episodes from status content. The existing guards test `message_type = 'status'` — a value only the backup importer produces — so live status posts (typed `image`/`video`/`text` by content) pass every filter. Status is pure ephemeral noise; the user wants it gone everywhere, unconditionally, independent of the upcoming per-chat mute mechanism.

## What Changes

- Live sync drops all `status@broadcast` events at the platform boundary, before normalization and persistence — no messages, no media descriptors, no chat row, no checkpoints. This is a deliberate exception to "ingest everything."
- Media download never fetches status media; nothing status-shaped ever enters the download queue or the content-addressed store.
- One-time excision of existing status data: 376 stored messages, the 325 media blobs (~848 MB on disk), the `chats` row, its checkpoints, FTS entries, and its brain artifacts (3 episodes + watermark) via the existing chat-scoped brain reset.
- Defense-in-depth: brain evidence/backlog selection predicates additionally exclude the status chat by identity (chat JID / `chat_type='status'`), not just by `message_type`, so status content can never be brain-processed even if a row slips in through a future ingestion path (e.g. a backup import).
- The chat list UI's now-dead `status` filter tab is removed.
- **BREAKING** (data): existing status messages and media are permanently deleted. This is explicitly requested; status is exempt from the "never lose chat data" rule that governs every real chat.

## Capabilities

### New Capabilities
- `status-broadcast-exclusion`: the system-wide invariant that WhatsApp Status is not a chat — never ingested, never stored, never media-downloaded, never brain-processed, never surfaced in any UI; plus the one-time excision of previously stored status data.

### Modified Capabilities
- `live-whatsapp-maintainer`: "Idempotent Live Event Ingestion" gains the status exception — `status@broadcast` events are the one event class deliberately dropped before normalization instead of persisted.
- `media-archival`: "Complete Media Capture From Live Sync" gains the status exception — "every incoming live media message" explicitly excludes status posts.

## Impact

- **Live sync**: `src/server/live/baileysClient.ts` (event handlers) / `src/server/live/normalize.ts` — drop status events pre-normalize; `src/server/live/maintainer.ts` — no chat upsert, media enqueue, stats refresh, or checkpoints for status.
- **Brain selection**: `visibleExchangePredicate` and backlog/evidence queries in `src/server/db/sqliteRepository.ts` (+ `memoryRepository.ts` mirror) — add chat-identity guard.
- **Excision migration**: one-time cleanup deleting status rows from `messages`, `media_assets` (+ blob files under the media root), `chats`, `live_chat_checkpoints`, FTS index entries, and invoking `resetBrainDerivedData('status@broadcast')`.
- **UI**: `src/client/pages/chats/ChatList.tsx` — remove the `status` filter tab.
- **Tests**: live normalize/maintainer tests, brain selection tests, excision migration test.
- **Sequencing**: lands before the `mute-chats-from-brain` change; that change's mute mechanism explicitly does not apply to status (hard-excluded here instead).
