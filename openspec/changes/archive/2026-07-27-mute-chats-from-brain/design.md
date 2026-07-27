## Context

Exploration (2026-07-26) mapped the full pipeline: every forward selection path funnels through `getBrainChatBacklog` (sqliteRepository ~:3059) driven by two shared predicates (`watermarkPendingPredicate`, `visibleExchangePredicate`); provenance is perfect at the episode tier (`chat_source_id` + span), 1–2 hops for claims/commitments, and absent at the doc tier (pages record only fed claim ids; entity/topic pages are cross-chat by construction). Three producers bypass episodes (graph signal sync, person co-citation, topic vocabulary), and `listMemoryEvidenceMessages` also feeds the separate memory/REM path. `listBrainLifecycleItems` already implements `excludeChats` — the pattern to generalize. Pending work is always derived from watermarks, never stored. The user's decisions: hide-never-delete, dueness-driven page draining, channels born muted by standing rule, ingestion untouched. `excise-status-broadcast` lands first; status is hard-excluded and outside this mechanism.

## Goals / Non-Goals

**Goals:**
- Interval-based mute state supporting arbitrary mute/unmute sequences, evaluable for any historical timestamp.
- One shared muted-range predicate enforced server-side, so every present and future consumer (UI, CLI, vault, MCP, retrieval) inherits identical semantics.
- Zero new stored counters: piled-up and coverage stay derived (watermark discipline).
- Instantly reversible hiding: computed at query time everywhere except a small materialized per-doc classification.

**Non-Goals:**
- Deleting or regenerating anything on mute (hide only; dueness drains pages naturally).
- Muting message ingestion, media download, FTS, chats UI, or message search.
- Re-slicing boundary-straddling episodes (any-overlap hides; the existing regenerate path can split them later if ever needed).
- Immediate graph-salience exactness on mute (recompute already runs post-run; weights lag one run).

## Decisions

1. **One interval table, canonical set, tombstone truncation.** `brain_mute_intervals(chat_source_id, start_ms, end_ms NULL=open, origin 'user'|'channel-default', created_at)`, canonical-JID keyed, indexed `(chat_source_id, start_ms)`. Mute inserts an open range and merges overlaps; unmute *truncates* affected ranges rather than deleting rows — a fully erased range collapses to a closed zero-length tombstone. Rationale: a single muted-ranges table keeps the shared predicate one EXISTS-join; tombstones let the channel-default hook (Decision 2) key on "chat has zero interval rows ever" without resurrecting defaults the user explicitly removed. Alternative rejected: signed muted/unmuted layered intervals (two-sided algebra, harder to reason about, no consumer needs it).

2. **Channel default is materialized at first sight, not implicit in the predicate.** A hook in chat upsert: when a `community`-type chat is seen and has no `brain_mute_intervals` rows (not even tombstones), insert `[0, ∞)` with `origin='channel-default'`; a one-time seed does the same for the existing 78. Rationale: keeps the predicate a pure table lookup with no type-based special case; unmute works through normal algebra; `origin` lets the UI label "muted by default (channel)". Alternative rejected: implicit "community ⇒ muted unless excepted" in SQL — every reader pays the special case and unmute needs an exception concept anyway.

3. **The message-level predicate does all write-side work; no "skip muted chats" clause exists.** `mutedRangePredicate(alias)` (a sibling of `visibleExchangePredicate`) excludes muted-range messages from `getBrainChatBacklog`, `getBrainStatus`/backfill aggregates, evidence selection (`listMemoryEvidenceMessages`, serving both brain packs and memory consolidation), and dueness. A fully muted chat then has zero pending → is never selected, never due, never in backlog samples — with no chat-level branch anywhere. Partially muted histories (post-unmute holes) fall out of the same predicate: packs skip hole messages, and the watermark advances on commit as usual. Defense in depth: `enqueueEpisodeTasksForChats` refuses muted chats and a mute action drops that chat's queued brain tasks; `executeEpisodeTask`'s per-task backlog re-read already re-checks cheaply.

4. **Bypass producers get explicit guards.** `syncBrainGraphSignals` skips chats whose full signal range is muted; `listCoCitedIdentityPairs` joins claims→episodes against the predicate; `listBrainTopicVocabulary` excludes topics whose only supporting episodes are muted. These are the three leak paths identified in exploration; each gets a targeted test.

5. **Read-side hiding is an episode-span overlap join, inherited upward.** An episode is muted iff its `[start_at_ms, end_at_ms]` overlaps a muted range of its chat (any overlap — reversible, and straddlers stay reachable in the muted view). Claims, commitments/lifecycle items, media gaps, and graph evidence inherit via their episode/claim joins — all bulk queries, never per-row loops (the bulk-query-or-wedge lesson). Graph nodes follow the exclusively-vs-hybrid rule: hidden only when *all* supporting claims are muted (cheap shortcut: `chat_scope` nodes of a fully-muted chat). The `excludeChats` pattern in `listBrainLifecycleItems` generalizes into this shared episode predicate.

6. **Doc tier: materialized classification, refreshed on transitions only.** A `muted_state` ('clean'|'hybrid'|'muted') + fed/muted claim counts on `brain_docs`, recomputed in bulk (revision claims → claims → episodes → intervals) on every mute state change and on each rollup commit. Rationale: page lists render constantly; resolving fed-claim provenance per render is the N+1 shape that wedges the live server. Mute changes are rare; rollups already touch the doc row. Hybrid pages render normally with per-source link discrimination resolved at detail-read time; `docScopeClaimIdsTx` excludes muted claims so future rollups drain muted prose; mute changes mark affected docs due via the existing dueness signal.

7. **Vault projection excludes muted; reprojection is the restore path.** `listBrainDocsForProjection`/`listBrainEpisodeProjections` apply the predicates; a mute/unmute action triggers an async projection sweep with visible progress (never blocking the event loop), deleting/restoring projected files. The vault stays a pure projection — no muted subfolder.

8. **API/UI.** `POST /api/chats/:id/mute` `{fromMs|'epoch'}` and `/unmute` `{fromMs}`; `GET /api/brain/muted` returning per-chat: identity, muted-since, origin, piled-up messages/media since the frozen watermark (derived: watermark + `media_assets` join), and hidden-artifact counts. `ChatListItem.muted` + a `muted` filter in `ChatListOptions` (copy the `includeEventOnly` end-to-end path). Thread-header mute control (default now / backdate / entire-history), `/brain/muted` page modeled on CommitmentsPage, NavRail-style badge summary on the brain page. All responses server-filtered — no client-side muting logic.

9. **Eval grades are exempt.** `brain_claim_grades` remain untouched and visible in aggregates (user-authored ground truth, deliberately reset-proof); the grading *sampler* stops offering muted claims going forward.

## Risks / Trade-offs

- [Predicate cost on the 326k-message archive] → intervals are few and indexed; per-chat queries join a handful of rows; global aggregates hash-join a tiny table. Benchmark `getBrainStatus` on a copy of the live DB before/after; its TTL cache absorbs UI polling.
- [Doc classification drift] → recompute is transition-driven and idempotent; a full-recompute maintenance path exists for repair; rollup commit refreshes its own doc.
- [Projection churn when muting a huge chat] → async sweep with progress reporting (async-progress preference); projection is idempotent and resumable via full rebuild.
- [Task races: task enqueued just before mute] → mute drops queued tasks in the same transaction; a task already running re-reads backlog per-chat and finds zero pending, committing nothing from muted ranges (evidence predicate is the backstop).
- [memoryRepository mirror drift] → every predicate lands in both repositories with shared tests (vitest isolation per the tests-wiped-vault lesson).
- [Graph salience lags mute by one run] → accepted; post-run recompute already exists and covers it.

## Migration Plan

1. Schema: add `brain_mute_intervals` (+ `brain_docs.muted_state` columns) to schema statements, ordered table lists, and the additive-column migration list; mirror in memoryRepository.
2. Land predicates + producer guards + read filters + doc classification (behavior identical while the interval table is empty — safe deploy).
3. Seed channel defaults for the existing 78 `@newsletter` chats; verify the Akshat channel's 3 episodes hide (not delete) and coverage excludes its range.
4. Land API + UI (controls, muted view, badge).
5. Verify on the live archive: mute a real noisy group entire-history; confirm artifacts hide, hybrid pages show with redirected links, coverage stays 100%-reachable, piled-up counts tick as new messages arrive, unmute restores everything, and a full projection rebuild round-trips.

## Open Questions

None blocking — all user decisions captured (hide-never-delete, dueness-driven draining, standing channel rule, ingestion untouched, any-overlap straddler policy, vault exclusion).
