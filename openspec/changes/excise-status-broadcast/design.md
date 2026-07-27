## Context

`status@broadcast` currently flows through the system as an ordinary chat: 376 messages (100% from the live Baileys path), 325 media blobs totaling 848 MB, a chat row, live checkpoints, a brain watermark, and 3 model-generated episodes. The existing exclusion attempts test `message_type = 'status'`, which only the backup importer emits; live status posts are typed by content (`image`/`video`/`text`) and pass every filter. The user has ruled: Status is not a chat, ignore it altogether — drop new ingestion, purge existing data. This is the explicitly sanctioned exception to the project's "never lose chat data" rule.

## Goals / Non-Goals

**Goals:**
- No status event ever persists anything again, on any ingestion path (live real-time, live history sync, backup import).
- No status media is ever enqueued or downloaded again.
- All existing status data is permanently removed, including blob files on disk, with an idempotent, verifiable, re-runnable excision.
- Brain selection is immune to status rows by identity, independent of ingestion (defense in depth).

**Non-Goals:**
- The per-chat mute mechanism (separate change: `mute-chats-from-brain`); newsletters/channels are handled there.
- Removing `status` from the `ChatType` enum or the `chats.chat_type` CHECK constraint — classification stays so the guard has something to key on.
- Any UI for status beyond deleting the dead filter tab.

## Decisions

1. **Drop at the earliest boundary, guard again at normalize.** A single shared helper (`isStatusChatJid(jid)`, canonicalization-aware — `status@broadcast` is already canonical) filters status events out of the Baileys event batches in `baileysClient.ts` *before* media-descriptor capture, and `normalize.ts` skips any status `chatSourceId` as a backstop (covers `messages.upsert`, `messaging-history.set`, receipts, chat/contact upserts). Rationale: descriptor capture deliberately runs pre-normalization, so filtering only in normalize would still capture media descriptors; filtering only in the client would leave the funnel unguarded for future event sources. Two cheap checks beat one leaky one.

2. **Defense-in-depth in SQL predicates, keyed on identity.** `visibleExchangePredicate()` (sqliteRepository ~:14800) gains `AND <alias>.chat_source_id != 'status@broadcast'`; `getBrainChatBacklog` (~:3059) and the memory evidence read (`listMemoryEvidenceMessages`) exclude `chat_type = 'status'` chats. Mirrored in `memoryRepository.ts`. Rationale: these predicates are the single funnel for brain/memory selection; identity-keying closes the `message_type` hole permanently, and after excision the guards cost nothing (no matching rows).

3. **Excision is an explicit maintenance action, not a startup migration.** Exposed as a CLI command (`brain-excise-status` or similar) and an admin API route; run once, manually. Rationale: deleting ~850 MB of blobs and hundreds of rows inside the schema-migration path would couple boot time to a one-time cleanup and violate the project's async-progress preference (long ops need visible progress, never block the event loop). Idempotency (delete-where-exists, report counts) makes "run once" a convention, not a correctness requirement.

4. **Excision sweeps every chat-keyed table via one list.** `messages`, `media_assets`, `media_download_queue`, `chats`, `chat_participants`, `chat_metadata_history`, `live_chat_checkpoints`, `live_gap_windows`, `live_event_receipts`, `engagement_aggregates`, FTS entries, plus `resetBrainDerivedData('status@broadcast')` for the brain tier (episodes, claims, citations, graph contributions, watermark, queued tasks — already implemented and chat-scoped). Rationale: an explicit list mirrors the repository's existing ordered-table conventions and is testable; the brain reset primitive already exists and is transaction-safe.

5. **Blob deletion respects content-addressed dedup.** A status media file on disk is deleted only if no *other* `media_assets` row references the same `sha256`/`storage_path`. Rationale: the media store is content-addressed; an identical image forwarded into a real chat shares the blob, and excising status must not destroy another chat's media.

6. **Backup importer skips status rows** (same identity key) and reports a skipped count. Today's archive shows zero importer-sourced status rows, but the invariant must hold for future imports.

7. **UI: remove the `status` entry from the chat-list filter array** (`ChatList.tsx:41-47`). No other UI knows status exists once the chat row is gone.

## Risks / Trade-offs

- [Shared blob deleted with status] → reference-count check on `sha256` before unlinking (Decision 5); test covers a blob shared between status and a real chat.
- [Dropping events mid-batch breaks sibling processing] → the filter removes status items from batch arrays and lets the rest of the batch proceed; live-maintainer tests assert a mixed batch persists its non-status messages.
- [Gap detection treats vanished status chat as a gap] → excision deletes the status checkpoint and gap windows; recovery only audits chats with checkpoints, so status disappears from its universe. Verified in the excision test.
- [FTS left inconsistent after bulk delete] → delete FTS rows in the same transaction as message rows; the index is rebuildable (`fts_state`) as a fallback.
- [Irreversible data loss] → intended and explicitly sanctioned; excision logs row counts and bytes reclaimed so what was deleted is at least known. No rollback path by design.

## Migration Plan

1. Land ingestion guards + predicates + importer skip + UI tab removal (safe forward-only behavior).
2. Restart the live maintainer so guards are active (no new status rows can appear).
3. Run the excision command once; verify its report (expect ~376 messages, ~325 assets, ~848 MB reclaimed) and re-run to confirm idempotent zero.
4. Verify: no `status@broadcast` row in any table; `/chats` shows no status tab; brain status/coverage unchanged except the removed watermark.

## Open Questions

None — all decisions were resolved with the user during exploration (drop new + purge existing; unconditional, independent of the mute mechanism).
