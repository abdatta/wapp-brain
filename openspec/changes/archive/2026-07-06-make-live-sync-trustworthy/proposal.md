# Make Live Sync Trustworthy

## Why

The live maintainer's spec promises resumable, gap-audited, self-recovering sync, but the implementation has broken links that make the promise false in every normal run mode: gap recovery is never scheduled, gaps that do open can never be verified closed, downtime while the app is off is never audited, reconnect audits flag nearly every chat as a false-positive gap (thousands of "needs attention" entries), stale session rows report "connected" after a crash, and live edits/deletes/reactions are silently dropped. The user's core expectation — "when the app runs, the archive is verifiably in sync, and I am alerted only about real problems" — currently cannot hold.

## What Changes

- Run bounded gap recovery continuously while the maintainer is connected, instead of only behind a CLI-only `--once` flag.
- Close gaps from observed evidence: when history-sync events land and cover a gap window, mark the gap closed; stop judging closure from the synchronous request acknowledgement (which can never prove closure).
- Audit downtime at startup (`late_start`), not only after an in-process disconnect, so "laptop was off overnight" is detected and recovered.
- Use honest audit lower bounds (last verified live evidence / last connected time) instead of `Date.now()`, so quiet chats stop generating false gap storms.
- Classify unprovable quiet-chat windows as grouped "uncertain" status rather than thousands of individual `needs_user_action` alerts; reserve `needs_user_action` for genuinely actionable problems.
- Reconcile persisted session/run state on server start so the UI never reports "connected"/"running" when no maintainer is running.
- Detect the logged-out disconnect reason and surface a "re-pair required" state instead of blind infinite reconnection.
- Ingest live message state updates (edits, deletes, reactions, receipts) and group participant/subject updates by subscribing to the missing client events; apply delete updates as tombstones on the original message instead of flagging the revocation event itself.
- Make per-event ingestion resilient and performant: contain per-event errors as recorded warnings instead of unhandled rejections, and update chat stats/checkpoints incrementally for the affected chats instead of recomputing the whole archive per event.
- Auto-resume live sync when the server starts and previously-paired credentials exist, so restarting the app is enough to bring chat data back in sync with zero manual steps (opt-out via config).
- Allow resume after long downtime: the archive-age baseline gate applies only to initial linking; resume proceeds regardless of downtime length and represents unprovable windows as honest gaps/uncertainty instead of refusing to sync.

## Capabilities

### New Capabilities

None. All changes land in the existing live maintainer capability.

### Modified Capabilities

- `live-whatsapp-maintainer`:
  - Bounded Backfill Recovery — recovery MUST run automatically while the maintainer is connected; gap closure MUST be judged from observed ingested history evidence, not from the synchronous request result.
  - Gap Detection — startup MUST trigger a downtime audit; audit lower bounds MUST derive from last verified evidence rather than the current wall clock; quiet chats without expected missing data MUST NOT open gaps.
  - Eventually Consistent Health States — unprovable/platform-limited windows are reported as grouped uncertainty distinct from actionable `needs_user_action`; totals MUST distinguish the two.
  - Restart And Disconnect Resilience — add truthful-state reconciliation at process start and explicit logged-out ("re-pair required") handling.
  - Message State Updates — client subscription coverage becomes an explicit requirement (edits, deletes, reactions, receipts, group participant/subject updates); deletes tombstone the original message.
  - New requirements: Automatic Resume On Startup (previously-paired sessions reconnect on server start without user action) and Resume After Long Downtime (baseline age never blocks resume, only initial linking).
- `browse-worthy-chat-list`:
  - New requirement: WhatsApp-style conversation recency ordering — system/status/reaction events never advance a chat's position or last-activity date (added during real-device verification; absorbs the `inbox-sorting-includes-system-updates` backlog item).

## Impact

- Affected code: `src/server/live/*` (maintainer loop, client subscriptions, auditor lower bounds, recovery closure logic), `src/server/server.ts` (startup reconciliation, maintainer lifecycle), `src/server/db/sqliteRepository.ts` (incremental stat updates, gap grouping queries, pending-update handling), `src/shared/types.ts` (health/pairing state additions), `src/client/App.tsx` (grouped gap display, re-pair state).
- APIs: `/api/live/status` and `/api/live/gaps` responses gain grouped-uncertainty summaries and a re-pair-required state; no endpoint removals.
- Absorbs backlog items: `openspec/todos/deleted-messages-not-marked-on-originals.md`, `openspec/todos/live-sync-gap-count-for-older-chats.md` (both deleted in favor of this change).
- No new dependencies; continues using the existing Baileys adapter with read-only guards.
