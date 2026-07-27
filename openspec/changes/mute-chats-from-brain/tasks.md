## 1. Schema and interval algebra

- [ ] 1.1 Add `brain_mute_intervals` DDL (chat_source_id, start_ms, end_ms NULL, origin, created_at; index on chat_source_id+start_ms) to `sqliteRepository.ts` schema statements, ordered table lists, and additive-column migration list; mirror in `memoryRepository.ts`
- [ ] 1.2 Repository ops `muteChat(chatSourceId, fromMs, origin)` / `unmuteChat(chatSourceId, fromMs)` implementing canonical merge + tombstone truncation, canonical-JID keyed; unit tests covering A/B/C sequences, backdated unmute erasure, overlap merge, tombstone non-resurrection
- [ ] 1.3 `listMuteIntervals` / `getMuteState(chatSourceId)` reads + `MuteInterval` DTO in `shared/types.ts`
- [ ] 1.4 Channel default hook in chat upsert: first-seen `community` chat with zero interval rows gets `[0,∞)` origin `channel-default`; one-time seed for existing channels; test that a user unmute is never resurrected by the hook

## 2. Write-side suppression

- [ ] 2.1 `mutedRangePredicate(alias)` SQL fragment beside `visibleExchangePredicate`; apply to `getBrainChatBacklog`, `getBrainStatus`/`getBrainBackfillStats` aggregates, and `listMemoryEvidenceMessages` (covers evidence packs and memory consolidation); mirror in memoryRepository
- [ ] 2.2 `enqueueEpisodeTasksForChats` refuses muted chats; `muteChat` drops the chat's queued brain tasks in the same transaction; test the task-race backstop (running task finds zero pending, commits nothing)
- [ ] 2.3 Guard the bypass producers: `syncBrainGraphSignals`, `listCoCitedIdentityPairs`, `listBrainTopicVocabulary`; one targeted test each proving no muted-derived node/suggestion/vocabulary appears
- [ ] 2.4 Watermark/resume semantics test: mute freezes watermark; unmute-from-B resumes with [A,B) hole never selected and watermark advancing past it; coverage arithmetic consistent throughout

## 3. Read-side hiding

- [ ] 3.1 Shared episode-span mute predicate (any-overlap) + inheritance joins for claims, lifecycle/commitments, media gaps, graph edge evidence — bulk queries only; generalize the `listBrainLifecycleItems` excludeChats pattern onto it
- [ ] 3.2 Apply to all list/detail reads: `listBrainEpisodes`, lifecycle items/detail, graph stats/entity/search/neighborhood/unresolved/edge, `getBrainOverviewData`, status backlog samples; graph nodes hide only when all supporting claims are muted (chat_scope shortcut for fully muted chats)
- [ ] 3.3 Vault projection: exclude muted from `listBrainDocsForProjection`/`listBrainEpisodeProjections`; async projection sweep on mute/unmute with visible progress; test file delete/restore round-trip via rebuild
- [ ] 3.4 Grading sampler excludes muted claims; existing `brain_claim_grades` untouched and still aggregated

## 4. Doc tier: hybrid pages

- [ ] 4.1 `brain_docs.muted_state` ('clean'|'hybrid'|'muted') + fed/muted claim counts; bulk classifier (revision claims → claims → episodes → intervals) run on mute state change and rollup commit; full-recompute repair path
- [ ] 4.2 Exclude muted claims in `docScopeClaimIdsTx` so future rollups drain muted prose; mute state change marks affected docs due via existing dueness signal
- [ ] 4.3 Doc list/detail routes: hide `muted` docs from normal surfaces; hybrid docs render with per-source link discrimination (muted-source citations route to the muted view); tests for clean/hybrid/muted classification and transitions

## 5. API and UI

- [ ] 5.1 Routes: `POST /api/chats/:id/mute` (fromMs | entire-history), `POST /api/chats/:id/unmute` (fromMs), `GET /api/brain/muted` (per-chat: identity, muted-since, origin, piled-up message/media counts since watermark, hidden-artifact counts); client wrappers in `api.ts`
- [ ] 5.2 `ChatListItem.muted` + `muted` filter through `ChatListOptions` → SQL WHERE builder (copy the includeEventOnly path); muted glyph in `ChatList` rows
- [ ] 5.3 Thread-header mute/unmute control in `ThreadView` with default-now, backdate picker, entire-history preset
- [ ] 5.4 `/brain/muted` page (route + NavRail-reachable from the brain page): muted-chat table with piled-up counts, drill-in to hidden episodes/commitments/pages, one-click unmute, mute-another-chat control; hybrid pages' muted links land here
- [ ] 5.5 Brain page summary badge: N muted chats / M piled-up messages

## 6. Verification on the live archive

- [ ] 6.1 Benchmark `getBrainStatus` and chat backlog on a copy of the live DB with intervals present; confirm no regression under the status-poll cadence
- [ ] 6.2 Seed run: channels born muted (Akshat channel's 3 episodes hidden, not deleted; coverage unaffected); mute a real noisy group entire-history and verify hide/piled-up/unmute-restore end to end, including vault reprojection
