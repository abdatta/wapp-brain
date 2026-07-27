## Why

The brain assimilates chats the user actively does not care about (certain housing-related groups, WhatsApp Channels), spending model budget and polluting episodes, commitments, pages, and the graph with noise. The user needs to mute chats from brain processing — starting from any past date, reversibly, through arbitrary mute → unmute → re-mute sequences — without touching message/media ingestion, which must keep archiving everything. Muted-derived artifacts must hide (never delete) and return intact on unmute.

## What Changes

- New per-chat **mute intervals** data model: multiple independent `[from, until)` date ranges per chat, maintained as a canonical non-overlapping set by mute/unmute operations. "Currently muted" = an open interval exists. Any point in a chat's history is evaluable against its mute state.
- **Standing channel rule**: `@newsletter` chats (`chat_type='community'`) are born muted for their entire history — covering the 78 existing channels and any future subscription — with explicit per-channel unmute overriding the default.
- **Write-side suppression**: no brain or brain-subchild output derives from muted ranges — episodes, claims, commitments, graph nodes/edges, doc rollups, person co-citation suggestions, topic vocabulary offered to other chats' prompts, and memory (REM) consolidation. Queued tasks for a newly muted chat are dropped; a muted chat's watermark freezes, making the existing pending-count the "piled up since muted" metric for free.
- **Read-side hiding**: artifacts sourced from muted ranges disappear from all normal brain surfaces (episodes, commitments/lifecycle, graph queries, docs, vault projection) but are never deleted. Muted-ness is computed at query time from the interval set (instantly reversible), with a small materialized per-doc summary for the page tier.
- **Hybrid pages**: a page fed by both muted and non-muted claims keeps rendering normally; its source links into muted material route to the muted-items view. Exclusively-muted pages hide from normal UIs. Muting marks affected pages due, so normal dueness-driven rollups drain muted content from prose over time (no forced re-rolls).
- **Muted-items view**: a distinct `/brain/muted` page listing every muted chat — since when, how many messages/media piled up since the brain last processed it — with drill-in to that chat's hidden artifacts and one-click unmute; plus controls to mute additional chats.
- **Unmute resume**: processing resumes from the frozen watermark; evidence selection skips still-muted holes; previously hidden artifacts for unmuted ranges reappear everywhere and become usable sources again.
- **Coverage honesty**: coverage/backfill denominators exclude muted-range messages so coverage can reach 100% and ETA math stays truthful.
- **Hard constraint honored**: ingestion is untouched — muted chats keep archiving every message and media blob exactly like any other chat.

## Capabilities

### New Capabilities
- `chat-brain-muting`: the mute-interval model, the standing channel default, write-side suppression across all producers, read-side hiding across all brain surfaces, hybrid-page behavior, the muted-items view, mute/unmute controls, and piled-up accounting.

### Modified Capabilities
- `brain-assimilation`: "Watermark Coverage Truth" — the visible-message universe that defines coverage and backlog now excludes muted-range messages, and a muted chat's frozen watermark must not read as permanent pending debt.

## Impact

- **Schema**: new `brain_mute_intervals` table (chat_source_id, start_ms, end_ms NULL=open), canonical-JID keyed, in `sqliteRepository.ts` schema statements + ordered table lists, mirrored in `memoryRepository.ts`.
- **Selection/producers**: `getBrainChatBacklog`, `buildEvidencePacks`/`listMemoryEvidenceMessages`, `enqueueEpisodeTasksForChats`/`auditCatchup`, `syncBrainGraphSignals`, `listCoCitedIdentityPairs`, `listBrainTopicVocabulary`, memory consolidation selection.
- **Read surfaces**: episodes/docs/graph/lifecycle/status routes in `server.ts`, `docScopeClaimIdsTx`, doc dueness, vault projection (`projection.ts`), `getBrainStatus`/`getBrainBackfillStats`.
- **API/UI**: mute/unmute endpoints; `ChatListItem`/`ChatListOptions` mute fields; ChatList + ThreadView controls; new `/brain/muted` page (CommitmentsPage as template); NavRail badge.
- **Sequencing**: depends on `excise-status-broadcast` landing first (status is hard-excluded, not muted). Must land before `brain-retrieval-pipeline` and `mcp-agent-surface`, which inherit the server-side mute scope for free.
