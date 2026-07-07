# Design: Make Live Sync Trustworthy

## Context

The live maintainer (`src/server/live/*`) has a well-specified architecture — per-chat checkpoints, gap windows, bounded recovery — but several links between its parts were never wired:

- `LiveMaintainer.runRecoveryOnce()` is only invoked by the CLI `live-start --once` flag ([cli.ts:250](../../../src/server/cli.ts)). The server-managed maintainer and the long-running CLI mode never run recovery.
- `BaileysLiveWhatsAppClient.fetchHistory` fires Baileys' async on-demand history request and returns `{status: "partial", events: []}` immediately; the actual messages arrive later as `messaging-history.set` events. `recoverDueGaps` judges closure from the synchronous result, so no gap can ever be observed closed.
- The gap audit only runs on an in-process disconnect→reconnect transition, with `requiredLowerBoundAtMs: Date.now()` — so boot-time downtime is never audited, and when the audit does run it opens a gap for essentially every chat (the observed "3842 gaps" incident).
- No state reconciliation at server start: `live_sessions.status = 'connected'` and `live_sync_runs.status = 'running'` survive a crash and are served verbatim to the UI.
- The client never subscribes to `messages.update`, `messages.delete`, `messages.reaction`, `message-receipt.update`, `groups.update`, or `group-participants.update`, even though normalization (`normalizeDeleteUpdate`) and storage (`applyLiveMessageUpdates`, `live_message_updates` with pending/applied semantics) already exist.
- Live revocation events are stored as messages with `isDeleted` set on the event itself; reactions are stored as standalone messages.
- Per-event bookkeeping is O(archive): `refreshChatStats()` recomputes every chat on every event; `updateCheckpoints` loads all checkpoints per event; `computeArchiveWatermarks` issues 2 queries per chat.
- Errors thrown inside `ingestEvent` propagate into Baileys' emitter as unhandled rejections.

Constraints: local-first, privacy-safe logging (no bodies/keys), read-only socket guards stay, Baileys `7.0.0-rc13` API surface, SQLite CHECK constraints cannot be altered in place.

## Goals / Non-Goals

**Goals:**

- Recovery actually runs, gaps actually close (or become honestly uncertain), and the reported sync state is truthful at all times.
- Startup after downtime audits and recovers without user action.
- Gap counts reflect real, evidence-backed suspicion, not wall-clock arithmetic.
- Live edits/deletes/reactions/group changes reach the archive; deletes tombstone originals.
- Ingestion stays responsive on large archives and never dies silently on one bad event.

**Non-Goals:**

- Auto-start at login, auto-resume without a running server, and OS notifications (separate `autonomous-laptop-operation` backlog item).
- Contact/group naming resolution and LID identity merging (separate backlog item).
- UI signal-vs-noise filtering beyond what delete/reaction correctness fixes naturally (separate backlog items).
- Media download, receipts UI, or changing the read-only posture.

## Decisions

### D1: In-process recovery scheduler owned by LiveMaintainer

`LiveMaintainer.start()` starts a timer loop (`recoveryIntervalMs`, default 30s, config-backed) that calls `runRecoveryOnce()` with an overlap guard (skip tick if previous still running) and only while the connection state is `connected`. `stop()` clears it. The CLI long-running mode gets the same behavior for free because it uses the same maintainer.

*Alternative considered:* external scheduler (cron/Task Scheduler) — rejected; recovery is meaningless without a live socket, and the maintainer already owns that lifecycle.

### D2: Evidence-based gap closure at ingestion time

Keep `fetchHistory` fire-and-forget, but stop pretending its return value proves anything. Closure is evaluated where evidence actually appears:

- After `ingestEvent` persists messages for chat C, if C has gaps in `open`/`retrying` status, re-read C's archive watermark; if the archived coverage now reaches the gap's `requiredLowerBoundAtMs` (oldest archived ≤ lower bound, or messages exist spanning the window), mark the gap closed.
- The recovery loop still enforces retry limits and marks `uncertain` when repeated requests produce no new evidence (no watermark movement between attempts).

*Alternative considered:* correlating Baileys request IDs with history-sync responses — rejected; Baileys does not reliably correlate on-demand responses to requests, and watermark evaluation is idempotent and source-agnostic (evidence from any path counts).

### D3: Gaps open only on positive evidence; downtime audited globally

Replace the `Date.now()` lower bound with two distinct mechanisms:

1. **Watermark mismatch (per-chat, evidence-backed):** platform chat metadata (`conversationTimestamp` from `chats.upsert`/`chats.update`/history sync — already normalized into `rawMetadata.timestampMs`) is compared against the chat's latest archived message. Gap opens only when platform recency > archive watermark, bounded by exactly that window. Reason: `watermark_mismatch`. Quiet chats produce no mismatch, hence no gap — this alone eliminates the gap storm.
2. **Downtime audit (startup + reconnect):** compute downtime as `[live_sessions.last_connected_at, now]`. On `connected` (first connect of the process included — drop the `lastDisconnectedAtMs != null` precondition), record a downtime audit and let WhatsApp's offline delivery + history sync flow in; after a settle period (first recovery tick ≥ N seconds after connect), run the watermark-mismatch audit so anything the offline queue did not cover becomes a per-chat evidence-backed gap. Reason: `late_start` on first-start, `disconnect` otherwise.

Chats whose mismatch window exceeds `maxBackfillPerChatDays` go to `uncertain` (grouped), not `needs_user_action`, unless a fresher-backup import would provably help (window overlaps what a backup could contain — i.e., always true — so the distinction is: `needs_user_action` only when retry limits were hit on a *recoverable* window; platform-horizon windows are `uncertain`).

### D4: Grouped uncertainty in status; no schema change for gap grouping

`getLiveStatus()` gains aggregate counts by `(status, reason)` computed at query time; `/api/live/gaps` keeps returning individual rows but the UI leads with the grouped summary ("N chats unprovable due to platform history limits") and only lists actionable gaps individually. No new tables.

### D5: Boot reconciliation runs before the server listens

On server start (and CLI `live-status`/`live-start` init), a `reconcileLiveState(repository)` step:

- `live_sessions.status IN ('connected','pairing')` → set to `'stopped'` with `lastError = null` (creds intact) — truthful "paused" rather than fake "connected".
- `live_sync_runs.status = 'running'` → `failed` with error code `INTERRUPTED_BY_RESTART` (reuses existing CHECK values; no schema change).

### D6: `logged_out` becomes a first-class session state (small table rebuild migration)

Baileys disconnect close is inspected: `lastDisconnect.error` Boom `statusCode === DisconnectReason.loggedOut (401)` → stop reconnecting, set session status `logged_out`. `LiveConnectionState` gains `"logged_out"`; the `live_sessions` CHECK constraint must be rebuilt (SQLite cannot alter CHECKs): at init, if `sqlite_master.sql` for `live_sessions` lacks `'logged_out'`, rebuild the table (create new, copy, drop, rename) inside a transaction. Onboarding maps it to a "Re-pair WhatsApp" primary action.

*Alternative considered:* reuse `error` + a sentinel `lastError` string — rejected; state drives UI actions and deserves a real enum value, and the migration is contained.

### D7: Subscribe to the missing events; deletes and reactions become updates, not messages

- `messages.update`: protocol revokes and edits → `normalizeDeleteUpdate` / new edit normalizer → `applyLiveMessageUpdates` (already handles tombstone + pending).
- In `messages.upsert`, a `protocolMessage` with REVOKE type is converted to a delete **update** targeting `protocolMessage.key.id` instead of being stored as a message with `isDeleted` on itself.
- `messages.reaction` → `reaction` updates (stored in `live_message_updates`, metadata carries emoji + sender; no message row).
- `message-receipt.update` → `receipt` updates, recorded but not surfaced in UI (cheap, keeps evidence).
- `groups.update` + `group-participants.update` → chat subject upserts / participant upserts through existing repository paths.
- The recovery tick also retries unapplied (`applied = 0`) updates, satisfying "update arrives before base message".

### D8: Error containment and O(affected-chats) bookkeeping

- `ingestEvent` body wrapped: on error → `liveWarning` recorded against the current run, totals.warnings incremented, trace recorded; the emitter never sees the throw.
- `refreshChatStats(chatSourceIds?)`: incremental variant updating only affected chats; full recompute stays for import runs.
- `updateCheckpoints` reads only the affected chats' checkpoints (`WHERE chat_source_id IN (...)`).
- `computeArchiveWatermarks` becomes one grouped SQL query (`GROUP BY chat_id` over messages joined to chats).

### D9: Auto-resume on server start (scope amendment, user-confirmed)

After boot reconciliation (D5), the server auto-resumes the maintainer when: registered Baileys creds exist in the auth dir, the session state is not `not_configured`/`logged_out`, and `LIVE_AUTO_RESUME` (new config, default `true`) is not disabled. This replaces the never-read `LIVE_WHATSAPP_ENABLED` flag, which is removed. Pairing-required flows still go through the UI; auto-resume never initiates pairing.

*Alternative considered:* keeping resume manual and deferring to `autonomous-laptop-operation` — rejected by the user; the minimum acceptable behavior is "restart the app → chat data syncs itself." OS-level autostart/notifications remain deferred.

### D10: Baseline existence gates linking; age never blocks anything

Linking (`/api/live/link`, CLI first pairing) requires an archive with messages to exist (`assertLiveBaselineExists`) so recovery has an anchor. Baseline *age* is advisory everywhere: with D3's evidence-based auditing, long downtime yields honest per-chat gaps and grouped uncertainty instead of a hard refusal — this also covers re-pairing after a device unlink when the archive is weeks stale. Resume and auto-resume perform no baseline check at all.

### D11: Credential corruption resilience (added after real-device verification)

Real-device testing surfaced a failure mode: Baileys writes `creds.json` non-atomically, and a process kill mid-write (e.g., a `tsx watch` restart) truncates it to 0 bytes, silently forcing a full re-pair while the client QR-churns in the background. Mitigations: (1) after every successful connect, a known-good `creds.json.bak` is saved; (2) at connect and before auto-resume, a corrupt/empty `creds.json` is restored from the backup when possible; (3) when unrecoverable, auto-resume marks the session `logged_out` with an explicit "re-link" message instead of silently spinning a QR flow nobody can see. Additionally, connection state now always outranks gap counts in the guided setup (a disconnected/pairing session must never be masked by "review gaps"), only actionable (non-uncertain) gaps drive attention states, and legacy wall-clock gap cleanup runs at server boot rather than only after a successful connect.

## Risks / Trade-offs

- [Baileys on-demand history is unreliable/undocumented] → closure never depends on it succeeding; every gap has a bounded retry budget and an honest `uncertain` terminal state; evidence from passive history sync also closes gaps.
- [`conversationTimestamp` may be absent or stale for some chat events] → mismatch audit treats missing platform recency as "no evidence" (no gap), never as proof of completeness; existing checkpoint health still reports `catching_up` during recovery.
- [Table rebuild migration for `live_sessions` CHECK] → guarded by inspecting `sqlite_master`, runs in a transaction, table is tiny (one row); rollback = restore from the transaction failure.
- [Reaction/receipt update volume grows `live_message_updates`] → keyed upserts (`event_key` PK) dedupe; receipts can be disabled by config if volume becomes a problem.
- [Reconciliation marks a healthy externally-run CLI maintainer as stopped if server restarts concurrently] → acceptable: single-user local app; document that server and CLI maintainer should not run simultaneously (already implicitly true — two sockets would compete for one session).
- [Settle-period heuristic before post-connect audit] → worst case we audit while history sync is still flowing and open gaps that close moments later via D2's ingestion-time closure; transient `catching_up`, not user-facing noise.

## Migration Plan

1. Schema: additive — `live_sessions` CHECK rebuild for `logged_out` (idempotent, guarded); no data loss.
2. Existing garbage gap rows from the old audit (wall-clock false positives): on first run of the new audit, close open gaps whose reason is `disconnect`/`late_start` and whose lower bound equals their chat's own watermark (self-referential no-evidence gaps) with note "superseded by evidence-based audit"; genuine mismatches reopen naturally.
3. No API removals; new fields are additive. UI changes render new grouped data but tolerate old shape during dev.

## Open Questions

- Should receipts be persisted by default or behind a config flag from day one? (Default-on proposed; flip if `live_message_updates` growth is noticeable.)
- Exact settle period before the post-connect mismatch audit (proposed: first recovery tick ≥ 60s after connect) — tune with the trace recorder against a real session.
- ~~Whether `baseline too_old` (>14 days offline) should keep blocking resume~~ — resolved: it does not (D10, user-confirmed scope amendment).
