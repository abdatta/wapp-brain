## 1. Shared guard

- [ ] 1.1 Add `isStatusChatJid(jid)` helper beside `inferChatType` in `src/server/import/jid.ts` (canonical-JID aware, true only for `status@broadcast`), with unit tests
- [ ] 1.2 Filter status events out of Baileys batch arrays in `src/server/live/baileysClient.ts` (`messages.upsert`, `messaging-history.set`) before media-descriptor capture, keeping the rest of each batch intact
- [ ] 1.3 Backstop skip in `src/server/live/normalize.ts`: any status `chatSourceId` produces no message, chat, participant, receipt, or checkpoint output on any normalize path (including the ChatRecord minting at ~:1250)
- [ ] 1.4 Skip status rows in the backup importer (`src/server/import/parser.ts`), counting them into a skipped-rows diagnostic

## 2. Defense-in-depth predicates

- [ ] 2.1 Extend `visibleExchangePredicate()` in `src/server/db/sqliteRepository.ts` (~:14800) with the identity guard (`chat_source_id != 'status@broadcast'`)
- [ ] 2.2 Exclude `chat_type = 'status'` chats in `getBrainChatBacklog` (~:3059) and `listMemoryEvidenceMessages` (~:13343)
- [ ] 2.3 Mirror 2.1–2.2 in `src/server/db/memoryRepository.ts` (including its `isEvidenceMessage`-adjacent filters at ~:8216)
- [ ] 2.4 Tests: a seeded status chat with image/video/text messages is never selected as backlog, evidence, or memory evidence

## 3. Excision maintenance action

- [ ] 3.1 Repository method `exciseStatusBroadcast()`: single transaction deleting status rows from `messages`, `media_download_queue`, `chats`, `chat_participants`, `chat_metadata_history`, `live_chat_checkpoints`, `live_gap_windows`, `live_event_receipts`, `engagement_aggregates`, and FTS entries; invokes `resetBrainDerivedData('status@broadcast')`; returns per-table row counts
- [ ] 3.2 Blob deletion with dedup safety: unlink a `media_assets` blob file only when no non-status row shares its `sha256`/`storage_path`; delete the `media_assets` rows; report bytes reclaimed
- [ ] 3.3 Expose as CLI command (`src/server/cli.ts`) and admin API route (`src/server/server.ts`) with a visible progress/result report (row counts, MB reclaimed)
- [ ] 3.4 Idempotency test: second run deletes zero rows and zero bytes; dedup test: a blob shared with a real chat survives excision

## 4. UI

- [ ] 4.1 Remove the `status` entry from the chat-list filter segmented control (`src/client/pages/chats/ChatList.tsx:41-47`)

## 5. Verify on the live archive

- [ ] 5.1 Run the excision once against the real archive; confirm the report (~376 messages, ~325 assets, ~848 MB) and a clean second run
- [ ] 5.2 Confirm no `status@broadcast` row remains in any table, the chat list renders without a status tab, and brain status/coverage math is unchanged apart from the removed watermark
