## 1. Dependency And Spike

- [x] 1.1 Add an optional Baileys dependency behind the live-maintainer feature boundary and pin it to a reviewed safe version.
- [x] 1.2 Add a dependency safety check that refuses known-vulnerable Baileys versions and reports status in `npm run doctor`.
- [x] 1.3 Build a small local proof command that pairs a test account, receives `messages.upsert`, receives `messaging-history.set`, and records whether on-demand history requests work in the current environment.
- [x] 1.4 Document the spike result and tune initial backfill defaults before enabling the maintainer path.

## 2. Live Data Model

- [x] 2.1 Add SQLite schema/tables for live sessions, live sync runs, per-chat checkpoints, gap windows, and event receipts.
- [x] 2.2 Extend repository interfaces and SQLite implementation with live session/run/checkpoint/gap/event methods.
- [x] 2.3 Add schema tests proving live tables are additive and existing backup import tables remain compatible.
- [x] 2.4 Add privacy-safe warning helpers for live sync diagnostics.

## 3. Client Adapter And Auth

- [x] 3.1 Define a `LiveWhatsAppClient` adapter interface for connection state, pairing, history events, message events, update events, and shutdown.
- [x] 3.2 Implement a Baileys-backed adapter without launching browser automation.
- [x] 3.3 Implement project-owned local auth state storage under `.wapp-brain/` or SQLite-backed storage.
- [x] 3.4 Ensure auth state, QR/pairing data, and client logs are never printed or persisted outside the private workspace by default.
- [x] 3.5 Add reconnect handling with bounded backoff and privacy-safe error summaries.

## 4. Event Normalization

- [x] 4.1 Map Baileys contacts/chats/messages/history sync payloads into existing `ContactRecord`, `ChatRecord`, `ParticipantRecord`, and `MessageRecord` structures.
- [x] 4.2 Generate stable source-derived live message keys that converge with existing backup identities when possible.
- [x] 4.3 Ingest `messages.upsert` `notify` and `append` events idempotently.
- [x] 4.4 Ingest `messaging-history.set` chunks idempotently and update per-chat coverage evidence.
- [x] 4.5 Ingest supported deletes, edits, reactions, receipts, and call/system updates with pending-update handling when the base message is missing.
- [x] 4.6 Add unit fixtures for duplicate live events, backup/live overlap, group messages, from-me messages, deleted messages, and update-before-base-message cases.

## 5. Checkpoints And Gap Auditor

- [x] 5.1 Compute per-chat archive watermarks from existing messages and imported backup state.
- [x] 5.2 Persist latest live evidence, earliest verified coverage, audit status, retry counts, and next recovery time per chat.
- [x] 5.3 Create suspected gap windows from late maintainer startup, disconnect periods, stalled history sync, and per-chat watermark mismatches.
- [x] 5.4 Add tests for the 2:00 PM backup / next-day 6:00 PM maintainer-start scenario.
- [x] 5.5 Add tests for uneven chat activity where one chat needs deeper recovery than recently active chats.

## 6. Bounded Backfill

- [x] 6.1 Implement a recovery planner that selects gap windows by priority, retry eligibility, configured limits, and per-chat state.
- [x] 6.2 Implement one-at-a-time, rate-limited targeted history recovery through the adapter when supported.
- [x] 6.3 Mark gaps closed only when recovered history proves coverage back to the required lower bound.
- [x] 6.4 Mark gaps uncertain when the client cannot prove continuity.
- [x] 6.5 Mark gaps needs-user-action when message/day/retry limits are reached.
- [x] 6.6 Add tests for closed, uncertain, retryable, and limit-exceeded recovery outcomes.

## 7. Maintainer Orchestration

- [x] 7.1 Implement the live maintainer service loop for pairing, running, stopping, reconnecting, ingesting events, auditing, and recovering gaps.
- [x] 7.2 Persist live sync run totals, status, started/finished timestamps, warning counts, and failure summaries.
- [x] 7.3 Resume open runs/checkpoints/gaps after process restart without duplicating messages.
- [x] 7.4 Add integration tests with a fake `LiveWhatsAppClient` for disconnect/reconnect and crash-during-backfill flows.

## 8. Local CLI And API

- [x] 8.1 Add CLI commands for live pairing, start, stop, status, gaps, retry-gap, unlink, and cleanup-live-state.
- [x] 8.2 Add local API endpoints for live maintainer status, per-chat health, open gaps, retry scheduling, and unlink/stop operations.
- [x] 8.3 Ensure all endpoints remain bound to the local server boundary and return privacy-safe payloads.
- [x] 8.4 Add API/CLI tests for status, gap listing, retry behavior, and safe unlinking.

## 9. UI

- [x] 9.1 Add live maintainer status indicators to the local UI.
- [x] 9.2 Add per-chat health badges for healthy, catching_up, uncertain, disconnected, and needs_user_action states.
- [x] 9.3 Add an open-gaps view that shows affected chat, time window, retry status, and recommended action without exposing hidden raw protocol payloads.
- [x] 9.4 Add UI controls for retrying a gap and unlinking/stopping live sync where appropriate.
- [x] 9.5 Run the local app and inspect the UI after frontend/API changes.

## 10. Documentation And Verification

- [x] 10.1 Update architecture, importing/data model, security/privacy, roadmap, and testing docs for the live maintainer.
- [x] 10.2 Document Baileys tradeoffs, unsupported browser-automation clients, WhatsApp Web reliability limits, and the meaning of uncertain sync states.
- [x] 10.3 Add synthetic fixtures for live protocol event normalization and gap recovery without real WhatsApp data.
- [x] 10.4 Run `npm test` and `npm run doctor`.
- [x] 10.5 Run `npm run build` after API/frontend/production-serving changes are in place.
