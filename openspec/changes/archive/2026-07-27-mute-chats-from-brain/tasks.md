## 1. Schema and interval algebra

- [x] 1.1 Add `brain_mute_intervals` DDL (chat_source_id, start_ms, end_ms NULL, origin, created_at; index on chat_source_id+start_ms) to `sqliteRepository.ts` schema statements, ordered table lists, and additive-column migration list; mirror in `memoryRepository.ts`
- [x] 1.2 Repository ops `muteChat(chatSourceId, fromMs, origin)` / `unmuteChat(chatSourceId, fromMs)` implementing canonical merge + tombstone truncation, canonical-JID keyed; unit tests covering A/B/C sequences, backdated unmute erasure, overlap merge, tombstone non-resurrection
- [x] 1.3 `listMuteIntervals` / `getMuteState(chatSourceId)` reads + `MuteInterval` DTO in `shared/types.ts`
- [x] 1.4 Channel default hook in chat upsert: first-seen `community` chat with zero interval rows gets `[0,∞)` origin `channel-default`; one-time seed for existing channels; test that a user unmute is never resurrected by the hook

> **Deviation (1.1) — `brain_mute_intervals` is deliberately NOT in `DELETE_TABLE_ORDER` / `ARCHIVE_TABLES`.**
> Mute is user *intent*, not derived data — the same class as `brain_claim_grades` and
> `brain_eval_runs`, which are likewise absent from both lists. This is also a correctness
> requirement, not a preference: Decision 1's tombstones exist so the channel-default hook can
> key on "this chat has zero interval rows ever". If a clear-and-replace import wiped the table,
> every explicit channel unmute would silently resurrect as muted on the next sync. Mute state
> therefore survives `resetBrainDerivedData` and a re-import; a test covers the reset case.

> **Deviation (1.4) — the channel default is applied at startup as well as on chat upsert.**
> The spec says channels are born muted "with no seeding step". The upsert hook alone would only
> cover channels seen *after* this ships, so `ensureChannelMuteDefaults` also runs inside
> `ensureSchema`. The existing 78 channels are muted the first time the new code opens the
> archive, with nothing for the user to run — which is what "no seeding step" means from where
> the user sits. Verified live: 78/78 channels muted on first open.

## 2. Write-side suppression

- [x] 2.1 `mutedRangePredicate(alias)` SQL fragment beside `visibleExchangePredicate`; apply to `getBrainChatBacklog`, `getBrainStatus`/`getBrainBackfillStats` aggregates, and `listMemoryEvidenceMessages` (covers evidence packs and memory consolidation); mirror in memoryRepository
- [x] 2.2 `enqueueEpisodeTasksForChats` refuses muted chats; `muteChat` drops the chat's queued brain tasks in the same transaction; test the task-race backstop (running task finds zero pending, commits nothing)
- [x] 2.3 Guard the bypass producers: `syncBrainGraphSignals`, `listCoCitedIdentityPairs`, `listBrainTopicVocabulary`; one targeted test each proving no muted-derived node/suggestion/vocabulary appears
- [x] 2.4 Watermark/resume semantics test: mute freezes watermark; unmute-from-B resumes with [A,B) hole never selected and watermark advancing past it; coverage arithmetic consistent throughout

> **Note (2.2)** — `enqueueEpisodeTasksForChats` refuses only *fully* muted chats. A chat muted
> from a date still has legitimate pre-mute history the brain should finish, and the message-level
> predicate already keeps the muted range out of its packs.

## 3. Read-side hiding

- [x] 3.1 Shared episode-span mute predicate (any-overlap) + inheritance joins for claims, lifecycle/commitments, media gaps, graph edge evidence — bulk queries only; generalize the `listBrainLifecycleItems` excludeChats pattern onto it
- [x] 3.2 Apply to all list/detail reads: `listBrainEpisodes`, lifecycle items/detail, graph stats/entity/search/neighborhood/unresolved/edge, `getBrainOverviewData`, status backlog samples; graph nodes hide only when all supporting claims are muted (chat_scope shortcut for fully muted chats)
- [x] 3.3 Vault projection: exclude muted from `listBrainDocsForProjection`/`listBrainEpisodeProjections`; async projection sweep on mute/unmute with visible progress; test file delete/restore round-trip via rebuild
- [x] 3.4 Grading sampler excludes muted claims; existing `brain_claim_grades` untouched and still aggregated

> **Note (3.2)** — `listBrainEpisodes({ episodeId })` deliberately does not apply the filter:
> fetch-by-id is a direct reference (commit paths read back what they just wrote, and the muted
> view links to detail), not a listing. Muted items are also dropped *before* lifecycle counts and
> group facets are computed, so a hidden commitment can never inflate a count it cannot be clicked
> from. Graph nodes hide only when every supporting claim is muted, so a person seen in both a
> muted group and a live DM stays visible with only their muted evidence removed.

## 4. Doc tier: hybrid pages

- [x] 4.1 `brain_docs.muted_state` ('clean'|'hybrid'|'muted') + fed/muted claim counts; bulk classifier (revision claims → claims → episodes → intervals) run on mute state change and rollup commit; full-recompute repair path
- [x] 4.2 Exclude muted claims in `docScopeClaimIdsTx` so future rollups drain muted prose; mute state change marks affected docs due via existing dueness signal
- [x] 4.3 Doc list/detail routes: hide `muted` docs from normal surfaces; hybrid docs render with per-source link discrimination (muted-source citations route to the muted view); tests for clean/hybrid/muted classification and transitions

## 5. API and UI

- [x] 5.1 Routes: `POST /api/chats/:id/mute` (fromMs | entire-history), `POST /api/chats/:id/unmute` (fromMs), `GET /api/brain/muted` (per-chat: identity, muted-since, origin, piled-up message/media counts since watermark, hidden-artifact counts); client wrappers in `api.ts`
- [x] 5.2 `ChatListItem.muted` + `muted` filter through `ChatListOptions` → SQL WHERE builder (copy the includeEventOnly path); muted glyph in `ChatList` rows
- [x] 5.3 Thread-header mute/unmute control in `ThreadView` with default-now, backdate picker, entire-history preset
- [x] 5.4 `/brain/muted` page (route + NavRail-reachable from the brain page): muted-chat table with piled-up counts, drill-in to hidden episodes/commitments/pages, one-click unmute, mute-another-chat control; hybrid pages' muted links land here
- [x] 5.5 Brain page summary badge: N muted chats / M piled-up messages

> **Note (5.4)** — "mute another chat" is done from the chat's own thread header rather than a
> chat picker inside the muted view: the thread is where the user is when they decide a chat is
> noise, and it avoids a second identity-resolution surface. The muted view links back to each
> chat. Hybrid pages carry a "some sources muted" chip linking to `/brain/muted`.

## 6. Verification on the live archive

- [x] 6.1 Benchmark `getBrainStatus` and chat backlog on a copy of the live DB with intervals present; confirm no regression under the status-poll cadence
- [x] 6.2 Seed run: channels born muted (Akshat channel's 3 episodes hidden, not deleted; coverage unaffected); mute a real noisy group entire-history and verify hide/piled-up/unmute-restore end to end, including vault reprojection

> **6.1 result — a real regression was found and fixed by this gate.**
> The first shape (one `NOT` clause per range, keyed on `messages.chat_id`) made SQLite abandon
> the `SCAN chats → SEARCH messages USING INDEX (chat_id=?)` plan for a full `SCAN messages` plus a
> temp B-tree GROUP BY: the chat backlog went 90ms → 626ms and `getBrainStatus` 777ms → 2074ms on
> the 327k-message archive. Four variants were measured; the winner keys chat identity on the
> **chats** alias and puts partial ranges behind a **single guard IN**, so only rows actually in a
> partially-muted chat pay for timestamp arithmetic. Equivalence was verified by comparing full
> un-LIMITed result sets across six partial-range shapes (open, closed, epoch-start).
> Final: `getBrainStatus` 777ms → 754ms (**−3%**, below baseline — muting removes rows from the
> scan); backlog 81ms → 98ms with channels muted, 142ms in a synthetic worst case of 10 partial
> ranges on the largest groups; the TTL-cached read the UI actually polls is 0.0ms.

> **6.2 result — run against a consistent copy of the live archive, served by a real server on an
> isolated port (`WAPP_WORK_DIR=.wapp-brain-verify APP_PORT=3620`), so the running live server kept
> its single writer throughout.** 78/78 channels born muted with no seeding step; a channel's 3
> episodes hidden with all 3 rows still stored and reachable from the muted view; coverage stayed
> truthful (311,048 counted vs 311,053 raw, assimilated ≤ total). A real noisy group (21,029
> messages, 450 episodes) muted entire-history removed 20,954 messages from the coverage universe,
> hid all 450 episodes with every row intact, dropped 269 commitments out of the counts (not just
> the list), and reported piled-up counts matching the watermark arithmetic exactly (30 = 30).
> Vault round-trip measured from a real baseline: **9,400 → 9,003 files (−397, exactly the muted
> chat's projectable episodes) → 9,400 restored on unmute**, with no regeneration. UI verified in
> the browser against that server: `/brain/muted` renders 79 cards with drill-in, the thread-header
> control round-trips mute → unmute → re-mute (origin correctly flipping `channel-default` → `user`),
> the chat DTO carries `muted`/`mutedOrigin`, the `muted=true|false` filters are exact, and the brain
> badge reads "Muted · 78 chats". Zero console errors; every request 200.

> **Post-implementation leak audit (mechanical, not by eye).** After `getBrainMediaGapSummary` was
> found unguarded by accident, every method in `sqliteRepository.ts` that reads a brain table was
> enumerated and classified by whether it applies a mute predicate — 84 methods, of which 34 are
> now guarded. Seven further leaks were found and fixed, **two of them on spend paths**:
>
> | leak | why it mattered |
> |---|---|
> | `listRegenerableBrainEpisodes` / `countRegenerableBrainEpisodes` | **spend** — regeneration would re-run a muted chat's episodes through a model, the exact budget muting exists to stop; the offered count also lied about the work |
> | `bulkLifecycleCandidatesTx` | **spend** — the closure sweep would review candidates drawn from a muted range, and could close an unmuted commitment on muted evidence |
> | `getBrainResolutionDebt` | asked the user to save contacts to repair prose nobody can open |
> | `getBrainOverviewData` (top-salience nodes) | hidden nodes surfaced on the overview |
> | `getBrainGraphEdgeEvidence` | a hybrid edge still listed citations from muted episodes |
> | `listBrainValidationIssues` / `getBrainValidationIssueSummary` | quality complaints about episodes the user cannot open |
> | `docCandidateRowsTx` | muted claims padded candidate counts past the rollup floor, offering a page with less real material than advertised |
>
> Also closed the last part of 4.3: `DocRenderClaimMeta.muted` now travels with each claim, so a
> hybrid page discriminates per source — the vault renders `(muted source)` instead of a wikilink
> to an episode file that is no longer projected (which would dangle), and `BrainDocStatementView`
> carries the flag for the web page.
>
> The residual unguarded reads are deliberate, each for a stated reason: the **run audit**
> (`listBrainRuns`, `getBrainRunEffects`, `attachBrainRunEffectCounts`) and `getBrainBackfillStats`
> are work logs — muting must not falsify what a past run actually did; `getBrainModelQualityAggregates`
> is exempt by Decision 9 (grades are user-authored ground truth); `repairBrainProseForIdentities`
> is a free mechanical substitution that keeps stored prose correct for unmute;
> `getBrainLifecycleItemDetail` and `listBrainValidationIssues({episodeId})` are fetch-by-id direct
> references the muted view links to; the rest are hydrators, resolvers, and commit-time internals
> whose callers are already guarded.

> **Coverage limit, stated honestly:** the live archive contains **0 committed doc revisions**, so
> the hybrid/muted *page* classification could not be exercised against real pages. It is covered by
> tests instead (clean → hybrid → muted transitions, projection inclusion/exclusion, dueness on mute
> without a forced re-roll, and idempotent recompute). The 500 rows `/api/brain/docs` returns on this
> archive are page *candidates* — nodes with no page yet — which by construction have nothing muted.
