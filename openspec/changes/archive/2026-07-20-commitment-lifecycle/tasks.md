## 1. Lifecycle core: durable events, fold, writer, projections

- [x] 1.1 Add `brain_lifecycle_events` + `brain_lifecycle_event_cites` DDL (indexes `(claim_id, id)`, unique `(event_id, source_message_key)`) to the SQLite schema; verify schema-additivity on a real-archive copy
- [x] 1.2 Implement the pure fold + payload-projection helpers in `src/server/brain/lifecycle.ts` (status fold, resolvedAtMs, lastReviewedAtMs; shared types in `shared/types.ts`: statuses, event/cite records, transition inputs, lifecycle item DTOs)
- [x] 1.3 Implement `applyBrainLifecycleTransitions` in `sqliteRepository` (one transaction: validate open/closed preconditions + closed-world postdating cites for model-source terminals, insert events + cites, re-project node payloads, upsert `resolves` edges with `msg:<key>` evidence keyed per resolver person, scoped salience refresh for touched nodes) and mirror in `memoryRepository`
- [x] 1.4 Wire lifecycle state into graph maintenance: `rebuildBrainGraph` gains the lifecycle projection step (fold events per current lifecycle claim → payloads + `resolves` edges, zero model calls); `resetBrainDerivedData` wipes both lifecycle tables
- [x] 1.5 Implement supersede re-key in the regeneration/supersede transaction: events re-key onto the unique same-kind citation-intersecting replacement claim, else `orphaned_at_ms`; orphan count queryable
- [x] 1.6 Tests: fold determinism over interleavings (close→reopen→close, still_open stamps); postdating + closed-world + precondition validation rejections; atomic apply with edge projection; rebuild-preserves-closed-status (rebuild equals incremental including lifecycle); reset wipes; supersede re-key + ambiguous-orphan; closed node loses dormancy exemption and decays (salience); memory/sqlite parity

## 2. Deterministic candidates + L0 surface (checkpoint: see and manually close a commitment)

- [x] 2.1 Implement the candidate query (pure SQL, both repositories): postdating reactions from `live_message_updates` on anchor keys with resolved reactor labels; replies via quoted snapshot/pointer onto anchor keys incl. cross-chat Reply Privately; subsequent entity-overlapping model claims (JID, then normalized-name) top-K recency-ranked; due-passage context; per-node caps
- [x] 2.2 Implement the sweep-due predicate (candidate newer than max(anchor, lastReviewed), or due passed since last review) + aggregate counts (open/overdue/stale/sweep-due/orphaned) exposed via graph stats or brain status
- [x] 2.3 Implement `listBrainLifecycleItems` (filters status/kind/chat/holder, pinned ordering, overdue/stale flags from `WAPP_BRAIN_LIFECYCLE_STALE_DAYS` default 30, read-time chat/holder labels, candidateCount, closed items with resolution trail, asOfMs stamp) in both repositories
- [x] 2.4 Routes: `GET /api/brain/lifecycle`, `POST /api/brain/lifecycle/transition` (user close/cancel/reopen with note); SSE/status refresh on apply; CLI `brain:lifecycle` (list/close/reopen) in `cli.ts` + npm script
- [x] 2.5 Client: `/brain/commitments` lazily-loaded page (open list with overdue/stale chips, filters, closed view with citation click-through to thread, close/cancel/reopen controls with note); compact open/overdue strip on the Brain page linking to it
- [x] 2.6 Tests: candidate producers (late reaction, cross-chat reply, entity-overlap claim, postdating exclusion), sweep-due skip, list ordering/flags/as-of, transition routes; user try-it checkpoint: open `/brain/commitments`, see real open commitments with overdue/stale flags, close one manually and see it in the closed view

## 3. Model closure sweep (checkpoint: promise → reaction-acknowledged → cited closure)

- [x] 3.1 Implement the sweep prompt + response contract in `lifecycle.ts` (per-chat batches ≤8 due nodes, fenced injection-hardened candidate evidence lines with per-line keys and identity labels, absolute dates, conservative-closure stance; JSON `{resolutions:[{node,status,cites,note?}]}`; mechanical normalization; collect-all validation with single enumerated retry; no fallback — failures persist as `lifecycle` validation issues)
- [x] 3.2 Implement the `lifecycle` run kind in `runJob.ts` + `BrainRunKind`: direct chunked loop over sweep-due nodes grouped by chat (archive-wide or `chatSourceId`), provider gates + owner-name refusal, ledger purpose `lifecycle`, daily caps + per-run maxModelCalls/maxTokens as named stops, still_open review events for offered-unresolved nodes, progress + loud failures via run surfaces
- [x] 3.3 Routes + CLI + UI: sweep start/cancel via the run machinery (`POST /api/brain/lifecycle/sweep` or run-console integration), model/effort selection (default effort high for this rollup-class call), sweep control on `/brain/commitments` with live progress; `brain:lifecycle sweep` CLI
- [x] 3.4 Tests: prompt rendering bounds/fences, normalization salvage, validation rejections (unknown node, non-offered cite, backdated cite) collected into one retry, second-failure leaves nodes open + issues recorded, still_open stamps, ledger rows + named budget stops, run-kind lifecycle reporting

## 4. Verification gates and closeout

- [x] 4.1 Full suite green (`npm test`), tsc build clean
- [x] 4.2 Live checkpoint on the real archive: assimilate/select a chat where a promise was made and later acknowledged (including by reaction); run the sweep scoped to that chat; verify the commitment node opened, the sweep closed it with a postdating citation resolving to the acknowledgment, the `resolves` edge appears in the graph explorer neighborhood, and an unresolved commitment in a quiet chat shows `overdue` past its due date while surviving dormancy
- [x] 4.3 Verify rebuild + reset behavior live (`brain graph rebuild` preserves the closure; reset wipes and surfaces repopulate); run `npm run roadmap:sync`
