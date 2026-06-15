## Context

Wapp Brain currently imports a user-supplied Android backup into a local SQLite archive. That gives the archive a reliable historical baseline, but new messages after the backup are not captured unless the user imports another backup.

The live maintainer should fill that gap by linking as a WhatsApp companion device and ingesting WhatsApp Web protocol events into the same archive. This is privacy-sensitive: WhatsApp auth state, chats, contacts, message bodies, media metadata, checkpoints, gap reports, and logs all remain local under `.wapp-brain/` by default.

Current ecosystem findings:

- Baileys is the best fit for the requested "pure code, no browser automation" approach. Its docs describe it as a TypeScript WhatsApp Web API library that talks over WhatsApp Web's WebSocket protocol rather than controlling a browser, and it links via WhatsApp Linked Devices rather than the WhatsApp Business API. See https://baileys.wiki/docs/intro/.
- Baileys exposes `messaging-history.set` for old chats/messages, `messages.upsert` for offline sync and real-time messages, and update/delete/reaction/receipt events for follow-on state changes. See https://baileys.wiki/docs/socket/history-sync/ and https://baileys.wiki/docs/socket/receiving-updates/.
- Baileys documents on-demand history fetch through `fetchMessageHistory`, but recent project issues show this path can be inconsistent depending on protocol/version/server behavior. The maintainer must feature-probe and flag uncertainty rather than assuming arbitrary scrollback is always available.
- `whatsapp-web.js` and `open-wa/wa-automate` are useful alternatives but center on a browser runtime through Puppeteer/Playwright/other drivers, so they do not satisfy the "purely via code, not browser automation" constraint. See https://wwebjs.dev/guide/ and https://github.com/open-wa/wa-automate-nodejs.
- The official WhatsApp Business Platform is not a good source for personal chat archive maintenance: it is hosted/cloud-oriented, business-account scoped, and webhook/API based rather than a personal linked-device archive reader.

## Goals / Non-Goals

**Goals:**

- Keep the imported archive eventually consistent with the user's WhatsApp account within explicit, configurable recovery bounds.
- Ingest real-time, offline, and initial history sync events into the existing archive idempotently.
- Detect per-chat missing windows by comparing archive watermarks, imported backup bounds, live events, and history sync evidence.
- Backfill missing windows with bounded, rate-limited, per-chat recovery requests when the selected client supports it.
- Persist enough local state to survive restarts, disconnects, crashes, and late maintainer startup.
- Surface sync health in the CLI/API/UI so the user can distinguish healthy chats from chats that need more recovery or manual action.
- Preserve the project's privacy posture: no hosted services, no browser automation, no remote logs, no raw private data in default logs.

**Non-Goals:**

- No WhatsApp Web scraping via a browser or browser automation.
- No bypassing WhatsApp protections, no account recovery, and no ingestion without the user's linked-device authorization.
- No hosted WhatsApp gateway, hosted vector database, remote Postgres, hosted LLM, or cloud sync by default.
- No guarantee of infinite historical backfill. The maintainer only guarantees consistency inside the protocol/library limits it can verify.
- No automated outbound messaging, bot behavior, or bulk messaging.
- No media file downloading in the first implementation unless explicitly added later; preserve media metadata and missing-media status only.

## Decisions

### Use Baileys Behind A Narrow Adapter

Use Baileys as the first live client, hidden behind a `LiveWhatsAppClient` adapter owned by Wapp Brain.

Rationale:

- It matches the requested code-level, non-browser approach.
- It is Node/TypeScript native and event-driven, which fits the existing runtime.
- The adapter lets us isolate protocol churn, security fixes, auth storage, and a future replacement client.

Alternatives considered:

- `whatsapp-web.js`: rejected for this change because it launches and controls WhatsApp Web with Puppeteer.
- `open-wa/wa-automate`: rejected for this change because its current runtime options are browser-driver based even when exposed as a local API.
- WhatsApp Business Platform: rejected for personal archive sync because it does not read an existing personal WhatsApp account history and introduces hosted/cloud dependencies.

### Treat Live Sync As A Separate Source Feeding The Same Archive

Add live sync run tables and checkpoint tables, but continue writing normalized contacts, chats, participants, and messages through repository methods.

Proposed storage additions:

- `live_sessions`: local auth/session metadata, linked-device identity, status, created/updated timestamps, last connection state, and privacy-safe error summaries.
- `live_sync_runs`: maintainer lifecycle runs with start/end/status/totals/warning counts.
- `live_chat_checkpoints`: per-chat source JID, latest archived timestamp/key, earliest archived timestamp/key, latest seen live timestamp/key, oldest verified synced timestamp/key, last audit status, retry counters, and next recovery time.
- `live_gap_windows`: per-chat suspected missing windows with start/end timestamps, reason, recovery status, request count, last attempted time, and confidence.
- `live_event_receipts`: dedupe/replay ledger for processed protocol events by source event key/type, without dumping full message bodies outside the normalized message table.

Rationale:

- Backup imports remain understandable and replayable.
- Live maintenance can be paused, retried, and audited independently.
- Per-chat checkpoints handle the user's example where one chat has a 10-hour gap while another only needs 1 hour.

### Compute Per-Chat Watermarks, Not Global Watermarks

The recovery planner MUST operate per chat. For each chat it compares:

- latest archived message timestamp/key from the imported archive;
- latest message timestamp/key seen through live events;
- earliest timestamp/key covered by initial or on-demand history sync;
- gap windows created by missed connection periods, late maintainer startup, stalled history sync, or suspicious sequence evidence.

Rationale:

- WhatsApp activity is uneven across chats.
- A global "last sync time" would miss quiet chats that need deeper recovery.
- Per-chat state lets active chats catch up quickly while quiet or stale chats receive slower targeted probes.

### Recover With Bounded Backfill And Explicit Uncertainty

The maintainer uses a tiered recovery strategy:

1. Live tail: process `messages.upsert` `notify` events immediately.
2. Offline append/history: process `messages.upsert` `append` and `messaging-history.set` events after reconnect.
3. Initial linked-device history: allow Baileys history sync during pairing/reconnect and ingest all received chats/messages.
4. Targeted backfill: if a chat's archive watermark is older than the live evidence requires, request older history around an anchor message using Baileys on-demand history APIs when feature-probed as working.
5. Stop condition: mark the gap closed when the maintainer has ingested messages back to or before the required lower bound, or when repeated requests return no older data with enough protocol evidence to consider the window exhausted.
6. Escalation: mark `needs_user_action` when the window exceeds configured limits or the client cannot prove the gap is closed.

Initial configurable defaults:

- `maxBackfillPerChatMessages`: 2,000
- `maxBackfillPerChatDays`: 14
- `maxConcurrentChatBackfills`: 1
- `minBackfillDelayMs`: 3,000
- `maxGapRetries`: 5

Rationale:

- The user wants strong eventual consistency, but WhatsApp Web history access is not an infinite database cursor.
- Bounded recovery protects the account from aggressive behavior and keeps UX honest.
- Chat-level alerts are more useful than silent partial sync.

### Use Idempotent Source-Derived Keys Across Backup And Live Sources

Live message normalization should produce stable keys from WhatsApp message identity: chat JID, message ID, participant/sender where relevant, from-me flag, and protocol key metadata. Existing backup records and live records should converge when they refer to the same WhatsApp message.

Rationale:

- The maintainer may see the same message through initial history, offline sync, live notify, on-demand backfill, and later backup re-import.
- Upsert-first storage is the only safe default.

Implementation note:

- Keep `source_table` style values such as `wa-web:messages.upsert`, `wa-web:history-sync`, and `wa-web:on-demand-history`.
- Preserve protocol identifiers in `raw_metadata_json`, but do not write raw protocol dumps to default logs.

### Make Auth State Local And Replace Demo Storage

Implement a project-owned Baileys auth store under `.wapp-brain/live/` or in SQLite with file permissions appropriate for local secrets. Do not use Baileys demo auth storage in production code.

Rationale:

- Baileys explicitly warns that demo multi-file auth state is not production storage.
- Linked-device credentials are effectively account access tokens and must be treated like secrets.

### Pin And Monitor The Live Client Dependency

Pin Baileys to a reviewed version and add doctor checks for known-vulnerable versions. As of June 14, 2026, the GitHub advisory GHSA-qvv5-jq5g-4cgg reports critical message/history sync spoofing in Baileys versions before `7.0.0-rc12` and `6.7.22`; the maintainer must not run with known-affected versions. See https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg.

Rationale:

- The live client touches private account data and protocol trust boundaries.
- Dependency drift can directly compromise archive integrity.

## Risks / Trade-offs

- WhatsApp Web protocol changes can break Baileys or history sync -> Hide Baileys behind an adapter, pin versions, expose a degraded state, and add doctor checks.
- On-demand history may fail or return incomplete results -> Treat it as a best-effort bounded recovery channel and mark uncertain gaps visibly.
- Linked-device auth state is sensitive -> Store locally, gitignore it, never print it, and add cleanup/relink commands.
- Aggressive backfill could trigger rate limits or account risk -> Use conservative defaults, one-at-a-time backfill, jitter, retries, and user-visible limits.
- Backup and live message IDs may not always match perfectly -> Preserve raw identifiers and add reconciliation tests that cover duplicate and near-duplicate cases.
- Deletes/edits/reactions may arrive after original message ingestion -> Store update events and apply state changes idempotently after base message upsert.
- Media history may be incomplete -> Preserve media metadata and missing-media markers, and defer media download/import to a later explicit change.

## Migration Plan

1. Add schema migrations/tables for live sessions, runs, checkpoints, gaps, and event receipts without changing current import tables destructively.
2. Add repository methods for live sync state while keeping existing importer APIs stable.
3. Add the Baileys adapter behind a feature flag/config gate.
4. Add CLI pairing and maintainer commands.
5. Add live event normalization and idempotent writes.
6. Add the gap auditor and bounded recovery planner.
7. Add API/UI status surfaces.
8. Update docs and doctor checks.

Rollback strategy:

- Stop the maintainer and unlink/remove local live session state.
- Existing backup archive data remains usable because live tables are additive.
- If needed, provide a local cleanup command to remove live-only tables/events while preserving imported backup messages.

## Open Questions

- What exact backfill defaults feel right after real-device testing: messages, days, and retry delay?
- Should live auth state live only in SQLite, only in `.wapp-brain/live/`, or split between SQLite metadata and encrypted local files?
- How much raw protocol metadata is needed for reliable debugging without over-retaining sensitive payloads?
- Which Baileys major line should be pinned for the first implementation after a small proof-of-connection spike?
- Should the first UI include full maintainer controls or only status plus CLI-first controls?
