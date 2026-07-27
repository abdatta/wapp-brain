## 1. Shared guard

- [x] 1.1 Add `isStatusChatJid(jid)` helper beside `inferChatType` in `src/server/import/jid.ts` (canonical-JID aware, true only for `status@broadcast`), with unit tests
- [x] 1.2 Filter status events out of Baileys batch arrays in `src/server/live/baileysClient.ts` (`messages.upsert`, `messaging-history.set`) before media-descriptor capture, keeping the rest of each batch intact
- [x] 1.3 Backstop skip in `src/server/live/normalize.ts`: any status `chatSourceId` produces no message, chat, participant, receipt, or checkpoint output on any normalize path (including the ChatRecord minting at ~:1250)
- [x] 1.4 Skip status rows in the backup importer (`src/server/import/parser.ts`), counting them into a skipped-rows diagnostic

## 2. Defense-in-depth predicates

- [x] 2.1 Extend `visibleExchangePredicate()` in `src/server/db/sqliteRepository.ts` (~:14800) with the identity guard (`chat_source_id != 'status@broadcast'`) — implemented as a `NOT EXISTS` against `chats`, since `messages` keys on `chat_id` and carries no `chat_source_id` column
- [x] 2.2 Exclude `chat_type = 'status'` chats in `getBrainChatBacklog` (~:3059) and `listMemoryEvidenceMessages` (~:13343)
- [x] 2.3 Mirror 2.1–2.2 in `src/server/db/memoryRepository.ts` (including its `isEvidenceMessage`-adjacent filters at ~:8216)
- [x] 2.4 Tests: a seeded status chat with image/video/text messages is never selected as backlog, evidence, or memory evidence

## 3. Excision maintenance action

- [x] 3.1 Repository method `exciseStatusBroadcast()`: single transaction deleting status rows from `messages`, `media_download_queue`, `chats`, `chat_participants`, `chat_metadata_history`, `live_chat_checkpoints`, `live_gap_windows`, `live_event_receipts`, `engagement_aggregates`, and FTS entries; invokes `resetBrainDerivedData('status@broadcast')`; returns per-table row counts
  - Audit of the live archive found three chat-keyed tables the design's list missed, all holding real status rows: `message_secrets` (359), `live_message_updates` (40), `message_link_previews` (24). Added, plus `retained_encrypted_payloads`, `identity_number_changes`, `brain_validation_issues`, `brain_claim_grades`.
  - FTS entries need no explicit delete: `messages_fts` is maintained by the `messages_fts_ai/ad/au` triggers, so the message delete clears the index inside the same transaction (hand-deleting would double-delete).
- [x] 3.2 Blob deletion with dedup safety: unlink a `media_assets` blob file only when no non-status row shares its `sha256`/`storage_path`; delete the `media_assets` rows; report bytes reclaimed
- [x] 3.3 Expose as CLI command (`src/server/cli.ts`) and admin API route (`src/server/server.ts`) with a visible progress/result report (row counts, MB reclaimed)
  - CLI dry-runs by default and requires `--apply`; delegates to the server over HTTP when it is listening, so better-sqlite3's single writer stays in the server process.
- [x] 3.4 Idempotency test: second run deletes zero rows and zero bytes; dedup test: a blob shared with a real chat survives excision
  - Also isolated `config.media.rootDir` in `tests/setup/vault-isolation.ts`: excision is the first path that unlinks blobs, so an un-isolated test could have deleted real archived media.

## 4. UI

- [x] 4.1 Remove the `status` entry from the chat-list filter segmented control (`src/client/pages/chats/ChatList.tsx:41-47`)

## 5. Verify on the live archive

- [x] 5.1 Run the excision once against the real archive; confirm the report (~376 messages, ~325 assets, ~848 MB) and a clean second run
  - PASSED 2026-07-27 on the live archive, via `npm run excise-status -- --apply` (delegated to the running server, so the single DB writer stayed in-process). Report: 1,656 rows — messages 376, media_assets 325, media_download_queue 325, message_secrets 359, live_event_receipts 201, live_message_updates 40, message_link_previews 24, brain_validation_issues 4, live_chat_checkpoints 1, chats 1; 310 blobs deleted, 0 kept, **827.2 MB** reclaimed; 3 episodes, 1 watermark, 3 projected files.
  - 827.2 MB rather than the proposal's 848 MB is correct: 848 MB summed all 325 asset rows, but 15 duplicate a hash *within* status, so only 310 distinct files exist on disk.
  - Second run: "No status@broadcast data found — nothing to excise." Idempotent.
  - Backup taken first: `C:\Users\iamro\wapp-brain-backups\archive-2026-07-27-pre-excision.sqlite` (688 MB, `integrity_check` ok).
- [x] 5.2 Confirm no `status@broadcast` row remains in any table, the chat list renders without a status tab, and brain status/coverage math is unchanged apart from the removed watermark
  - Residual scan (read-only) over every `chat_source_id`-keyed table: **NONE**. Zero status/`chat_type='status'` chat rows, zero orphaned messages.
  - FTS stayed consistent without an explicit delete: `messages_fts` 327,257 = `messages` 327,257, confirming the trigger-maintained index.
  - Before→after deltas are exactly the status footprint and nothing else: messages 327,633→327,257 (−376), chats 4,145→4,144 (−1), media_assets 16,136→15,811 (−325), episodes 18,290→18,287 (−3), claims −11, watermarks 644→643 (−1), graph nodes −25 / edges −143 (those 3 episodes' contributions, as a scoped brain reset intends). Contacts unchanged at 11,449.
  - Coverage math reconciles: `totalVisibleMessages` 311,412→311,053 (−359) — the 376 removed rows minus 17 `system`-typed ones, which were never visible. Coverage 99.9%, provider healthy, no failed tasks.
  - UI at `/chats`: filter tabs render `all · dm · group · broadcast`, no status tab, no `status@broadcast` anywhere in the page, 60 chat rows normal, zero console errors.
  - Vault on disk: 12.34 GB → 11.54 GB.
