# Tasks: Make Live Sync Trustworthy

## 1. Truthful State Foundations

- [x] 1.1 Add `"logged_out"` to `LiveConnectionState` in `src/shared/types.ts` and add the guarded `live_sessions` CHECK-rebuild migration in `sqliteRepository.ts` (inspect `sqlite_master`, rebuild in a transaction, idempotent).
- [x] 1.2 Implement `reconcileLiveState(repository)`: stale `connected`/`pairing` sessions → `stopped`; stale `running` live runs → `failed` with code `INTERRUPTED_BY_RESTART`. Call it at server startup before listening and from CLI live commands.
- [x] 1.3 Detect `DisconnectReason.loggedOut` in `baileysClient` connection close handling: stop the reconnect loop, emit `logged_out` state; map it in `LiveMaintainer` to session status and in `onboarding.ts` to a "Re-pair WhatsApp" primary action.
- [x] 1.4 Unit tests: reconciliation corrects stale rows; logged-out close does not schedule reconnect; migration adds `logged_out` without data loss and is a no-op on second run.
- [x] 1.5 Auto-resume on server start: after reconciliation, start the maintainer when registered creds exist, session is not `not_configured`/`logged_out`, and `LIVE_AUTO_RESUME` (new config, default true) is enabled; remove the dead `LIVE_WHATSAPP_ENABLED` flag.
- [x] 1.6 Scope the baseline age gate to linking only: `/api/live/resume` and auto-resume skip `assertLiveBaselineReady`; `too_old` remains advisory in status. Tests: resume proceeds with a stale baseline; initial link without baseline still refuses; auto-resume skips when creds are absent or session is logged out.

## 2. Event Coverage And Update Semantics

- [x] 2.1 Subscribe in `baileysClient` to `messages.update`, `messages.delete`, `messages.reaction`, `message-receipt.update`, `groups.update`, and `group-participants.update`; normalize each into `LiveMessageEvent.updates` / chat / participant records (extend `normalize.ts` with edit and reaction normalizers alongside `normalizeDeleteUpdate`).
- [x] 2.2 In `normalizeBaileysMessage`, stop marking revocation `protocolMessage` events as deleted messages; convert REVOKE protocol messages in `messages.upsert` into delete updates targeting the original message key, and drop the event-message row.
- [x] 2.3 Stop storing reactions as message rows: route `reactionMessage` content (upsert path) and `messages.reaction` events into `reaction` updates with emoji/sender metadata.
- [x] 2.4 Extend `applyLiveMessageUpdates` for edits (update body, set edited flag in `raw_metadata_json`) and verify tombstone semantics preserve identity/timestamps; keep unmatched updates pending (`applied = 0`).
- [x] 2.5 Add a pending-update retry pass (unapplied updates re-attempted) to the recovery tick.
- [x] 2.6 Tests with synthetic Baileys-shaped events: delete tombstones the original; delete-before-base stays pending then applies; edit updates body; reaction attaches without creating a message; group subject/participant updates land on the chat.

## 3. Evidence-Based Auditing

- [x] 3.1 Capture platform chat recency: persist `conversationTimestamp` (already normalized as `rawMetadata.timestampMs`) onto chats as a comparable `platform_recency_ms` value on chat upserts.
- [x] 3.2 Rewrite `auditChatGaps` inputs: replace wall-clock `requiredLowerBoundAtMs` with per-chat watermark-vs-platform-recency mismatch; open gaps only on positive mismatch evidence, bounded by `[archiveWatermark, platformRecency]`.
- [x] 3.3 Trigger audits at the right times: on every `connected` transition including process first-start (drop the in-process-disconnect precondition), using downtime `[last_connected_at, now]` for reason selection (`late_start` vs `disconnect`); schedule the mismatch audit on the first recovery tick after a settle period post-connect.
- [x] 3.4 One-time cleanup on first new-audit run: close legacy no-evidence gaps (reason `disconnect`/`late_start`, lower bound equal to own watermark) with a "superseded by evidence-based audit" note.
- [x] 3.5 Replace `computeArchiveWatermarks` per-chat query loop with a single grouped SQL query.
- [x] 3.6 Tests: quiet chat with matching recency opens no gap; platform recency ahead of archive opens one bounded gap; boot-after-downtime triggers audit without an in-process disconnect; legacy gap cleanup runs once.

## 4. Recovery That Runs And Closes

- [x] 4.1 Add `recoveryIntervalMs` to config (`LIVE_RECOVERY_INTERVAL_MS`, default 30000); run a guarded recovery timer inside `LiveMaintainer` while connected; clear on stop/disconnect.
- [x] 4.2 Implement ingestion-time gap closure: after persisting messages for a chat with open/retrying gaps, re-evaluate that chat's watermark and close gaps whose required lower bound is now covered.
- [x] 4.3 Rework `recoverDueGaps` terminal logic: synchronous `fetchHistory` acknowledgement never closes; mark `uncertain` when retries exhaust with no watermark movement between attempts; route platform-horizon windows (older than `maxBackfillPerChatDays`) to `uncertain` instead of `needs_user_action`, reserving `needs_user_action` for recoverable windows that hit retry limits.
- [x] 4.4 Tests: gap closes when covering history arrives asynchronously; gap goes uncertain after budget with no evidence; recovery ticks fire automatically and never overlap; needs_user_action only for recoverable-window exhaustion.

## 5. Resilient, Scalable Ingestion

- [x] 5.1 Wrap `ingestEvent` in per-event error containment: record `liveWarning` on the active run, bump warning totals, keep the maintainer alive; add a test that a poisoned event does not stop subsequent ingestion.
- [x] 5.2 Add incremental `refreshChatStats(chatSourceIds)` and use it on the live path (full recompute remains for imports); scope `updateCheckpoints` reads to affected chats.
- [x] 5.3 Sanity-check ingest cost on a large synthetic archive (existing large fixtures): per-event work is O(affected chats).

## 6. Status Surface And UI

- [x] 6.1 Extend `getLiveStatus()` with grouped gap summaries (counts by status+reason, e.g. actionable vs uncertain vs catching_up) and expose in `/api/live/status`; keep `/api/live/gaps` row-level.
- [x] 6.2 Update `LivePanel`/onboarding: lead with grouped summary ("N chats unprovable — platform history limit") and list only actionable gaps individually; add the `logged_out` → "Re-pair WhatsApp" flow with the pairing modal.
- [x] 6.3 UI reflects tombstoned deletes (WhatsApp-style "This message was deleted" on the original bubble) and no longer renders reaction rows as bubbles.
- [x] 6.4 Update docs: `docs/ARCHITECTURE.md` live flow, `README.md` live section, `.env.example` for the new config key.

## 7. Verification

- [x] 7.1 Full test suite passes; add regression coverage for every scenario in the delta spec (map each `#### Scenario:` to at least one test).
- [x] 7.2 Manual verification with a real linked device: surfaced and fixed the group-participants crash, the corrupted-creds/QR-masking incident (16-day outage diagnosed truthfully after fixes), 3842 legacy gaps closed at boot, re-pair flow completed, live messages flowing again with WhatsApp-style ordering and scroll behavior verified in the UI.

## 8. Real-Device Verification Follow-Ups (added during 7.2)

- [x] 8.1 Fix `group-participants.update` crash (Baileys v7 sends GroupParticipant objects, not JID strings); guard all JID choke points against non-strings; contain every client event handler so malformed payloads trace-and-drop instead of killing the process.
- [x] 8.2 Fix findings from the installed-typings audit: history-request timestamp unit (ms, not seconds — recovery was silently dead), FutureProof wrapper unwrapping (view-once/document-with-caption/edited), edits via both delivery channels, sender-perspective protocol target keys, no fabricated phone numbers from LID/group ids, stub messages as system events, delimiter-safe message keys, bounded receipt event keys, `hosted.lid` chat typing.
- [x] 8.3 Credential corruption resilience (D11): known-good `creds.json.bak` after each connect, restore-on-corruption, auto-resume marks unusable creds as `logged_out` with a re-link message instead of QR-churning invisibly.
- [x] 8.4 Guided setup truthfulness: connection state outranks gap counts; only actionable gaps drive attention; legacy gap cleanup runs at boot; baseline age gates nothing (existence gates first link only); sheen animates only while something runs.
- [x] 8.5 Treat Baileys `restartRequired` (515) after QR scan as an expected handshake step: no error surfaced during pairing, immediate reconnect.
- [x] 8.6 WhatsApp-style chat ordering: recency derives only from visible conversation messages (delta spec added for `browse-worthy-chat-list`); boot recomputes stats so existing archives reorder immediately.
