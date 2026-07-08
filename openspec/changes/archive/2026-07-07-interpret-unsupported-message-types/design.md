# Design: Interpret Unsupported Message Types

## Context

Two populations render as "Unsupported message". Backup-imported rows fall through `messageTypeFromCode` (a bare switch over ~16 Android codes) to `unknown_<code>`; the live normalizer's `detectMessageType` similarly falls through to `unknown_<key>` for polls, events, albums, lists, buttons, and payment invites. The user has identified 24 of 27 unknown backup codes by checking real examples on their phone; the remaining 3 (82, 88, 116 — one message each) could not be located and are accepted as permanently unidentified.

Schema inspection of the real decrypted `msgstore.db` (table names and counts only) established facts the todo left open:

- **`message_secret` exists: 71,926 rows** (`message_row_id → secret BLOB`). The backup carries per-message secrets, so import can backfill secrets for nearly every message — late decryption of secret-encrypted updates is achievable, not hypothetical.
- **`message_add_on` (45,085 rows)** carries typed sub-tables: `message_add_on_reaction` (42,277), `message_add_on_poll_vote` (1,138) + `..._selected_option` (1,207), `message_add_on_event_response`, `message_add_on_pin_in_chat`. Backup reactions and poll votes are stored **already decrypted by the phone**.
- **`message_edit_info` (1,668 rows)** carries edit history.
- Content sidecar tables exist for the newly-identified types: `message_poll` + `message_poll_option`, `message_event` + `message_event_invite`, `message_template` + `message_template_button`, `message_ui_elements(_reply)`, `message_group_invite`, `message_payment*`, `message_view_once_media`.

On the live side, reactions, edits, and revokes are already modeled as **state updates targeting the original message** by `(chat, key_id)` — and thanks to the canonical-identity change, backup `message_add_on` rows (which carry `chat_row_id`, `key_id`, `parent_message_row_id`) can resolve to exactly the same targets.

User decisions (confirmed 2026-07-07): store per-message secrets **by default**; **retain** undecryptable secret-encrypted payloads for late decryption.

## Goals / Non-Goals

**Goals:**

- One type vocabulary shared by backup and live ingestion; the same real-world message gets the same type string from either source.
- Historical rows are fixed by a **normal re-import** — no archive re-initialization, no identity change.
- Backup reactions, edits, poll votes, and event responses converge into the same state-update apply path live sync uses.
- Message secrets: captured live, backfilled from backup, used to decrypt retained secret-encrypted payloads when possible — now or later.
- The unknown-code worksheet becomes regenerable on demand, preserving the user's annotations, so the remaining blanks shrink over time.
- Every unreadable message states *why* it is unreadable.
- Interpretation is consumable by every downstream layer — thread view, second-brain evidence, and the planned search/embedding, MCP chat-reader, and agent-harness surfaces — from one server-side source of truth (user directive, 2026-07-07).

**Non-Goals:**

- Delivery/read receipts (`message_add_on_receipt_*`, 39k+ rows) — sync noise, not archive content.
- Reaction/edit *display* treatment (decorating bubbles, edit badges' visual design) — owned by the thread-view signal-vs-noise backlog item.
- Newsletter, broadcast, and business-CRM sidecar tables.
- Recovering view-once media bytes (not present in backups by design).
- Changing recency/system-event ordering semantics — new system-ish types simply adopt the existing `browse-worthy-chat-list` rules.

## Decisions

### 1. Stored type strings: user-confirmed codes only

`messageTypeFromCode` grows a table for the 24 identified codes. Unidentified codes (82, 88, 116 — accepted as permanently unfindable, one row each) keep `unknown_<code>` in storage — we never guess — and the UI renders them as a quiet "Legacy message". If a future worksheet answer ever lands, the table grows and a re-import upgrades the rows.

| Code | Stored type | Notes |
| --- | --- | --- |
| 11 | `waiting_for_message` | Never decrypted on the phone; permanently unavailable, said honestly |
| 14 | `contact` | Contacts array; same display family as code 4 |
| 24 | `group_invite` | Group name extractable from `message_group_invite` |
| 25, 26, 27, 28, 32, 49, 55, 57, 62 | `template` | Business template family (incl. video variants and flow follow-ups); text + button labels from `message_template(_button)`; media kind from the row |
| 36 | `system` | Disappearing-timer change; renders as a system chip |
| 42 / 43 | `view_once_image` / `view_once_video` | Media absent by design; placeholder says so |
| 45, 46 | `list` | Choose-one option menus (list message and its multiple-choice button variant) |
| 51 | `payment_invite` | WhatsApp Pay invite |
| 64 | `admin_revoked` | Deleted by group admin; deleted-style display (timing caveat → investigation task) |
| 66 | `poll` | Question from `message_poll`, options from `message_poll_option` |
| 92 | `event` | Group event from `message_event`; responses from add-ons |
| 99 | `album` | Media-grid container row |
| 103 | `status_mention` | "Mentioned you in their status" |
| 118 | `history_share` | Past message history shared with a newly added group member |
| 20 | `sticker` | Audit correction: previously mislabeled `product`; every real row carries `image/webp` sticker media and none reference `message_product` |
| 15 | `revoked` | Audit correction: previously mislabeled `sticker`; every row joins `message_revoked` (deleted-for-everyone), rendered as a deletion |
| 90 | `call` | Audit correction: previously mislabeled `status`; every row joins `message_call_log` (video flag + duration extracted to metadata) |
| 10 | `missed_call` | Audit correction: previously the generic `call`; every row joins `missed_call_logs` |
| 82 | `view_once_audio` | Identified during audit (was accepted-unknown): opus voice-note media joined to `message_view_once_media` — completing the 42/43 view-once family |
| 88 | `bot_feedback` | Identified during audit (was accepted-unknown): 1:1 join with `message_bot_feedback` — the user's thumbs up/down on a Meta AI response |
| 8 | `call` | Corrected from `audio` per forensic documentation (whapa, which independently corroborates the 10/11/14/15/20 corrections); zero rows locally |
| 116 | *unknown* | The only remaining unidentified code: one from-me textless group row with a unique `view_mode=100` and no sidecar links — an invisible client control message; stays an honest `unknown_116` |

Live `detectMessageType` maps the corresponding payload keys to the same strings: `pollCreationMessage*` → `poll`, `eventMessage` → `event`, `albumMessage` → `album`, `listMessage` → `list`, `listResponseMessage` → `list_response`, `buttonsMessage`/`buttonsResponseMessage`/highly-structured variants → `template`, `paymentInviteMessage` → `payment_invite`, `groupInviteMessage` → `group_invite`, `pollUpdateMessage` → poll-vote state update (see Decision 4). Known divergence, accepted: live view-once arrives inside wrapper envelopes that unwrap to real media (we archive the actual photo/video), while backup view-once rows are tombstones — the backup-side `view_once_*` types describe what remains.

### 2. Content extraction from sidecar tables, typed placeholder as floor

For mapped types the importer extracts what the sidecar tables hold cheaply: poll question + options, event name/time, template body + button labels, group-invite group name. Extracted text lands in `body` (display + search benefit); structured extras (poll options, button labels, event time, RSVP counts) land in `rawMetadata`. When extraction finds nothing, the typed placeholder stands — never a bare "Unsupported message".

### 3. Backup add-ons ride the live state-update path

`message_add_on` rows are parsed into the **same targeted update objects** the live normalizer emits (`reaction` / `edit` / `delete` aimed at `(canonical chat, key_id)`), with deterministic event keys (`import:reaction:<key>:<reactor>` mirroring `wa-web:reaction:...`) so re-imports stay idempotent, and applied through the existing repository state-update machinery. Newest-timestamp-wins semantics already in that path resolve backup-vs-live conflicts. `message_edit_info` becomes edit history on the original row (metadata + edited marker). Poll votes (already plaintext in backups) attach voter + selected options to the poll row's metadata.

### 4. Message secrets: capture, backfill, decrypt late

- New additive storage keyed by canonical message key: secrets (`BLOB`, with source) and retained undecryptable payloads (raw blob + target key + kind).
- **Live capture (default on):** persist `messageContextInfo.messageSecret` from incoming envelopes.
- **Backup backfill:** join `message_secret` to message `key_id`s during import — retroactively arms ~72k historical messages.
- **Late decryption pass:** when a secret arrives for a message with retained payloads (or a payload arrives for a message with a secret), attempt decryption and apply the result as a normal state update; keep the payload until it decrypts. Baileys has first-class poll-vote decryption; event/edit secret payloads are decrypted where the library's message-secrets primitives allow (exact helper surface verified against the installed `.d.ts` during apply — Baileys payload shapes drift). What cannot be decrypted stays honestly labeled.
- Privacy: a documented, deliberate decision in the README — the archive already stores the corresponding plaintext locally; secrets never appear in logs, DTOs, or diagnostics.

### 5. Regenerable worksheet that preserves answers

A CLI command (`npm run unknown-report`) regenerates `.wapp-brain/unknown-type-report.md` from the archive: per-code counts and example locations, **merging the user's existing "What is it?" annotations by code** so iteration never loses work. The file stays in the private workspace (gitignore verified in apply).

### 6. Honest display reasons

The placeholder map names the kind when knowable ("Poll", "View once photo — media not kept in backups", "Business template message", "Photo album") and the reason when not ("Encrypted edit — key not held", "Waiting for a message that never arrived", "Legacy message — unrecognized type"). `humanizeMessageType` handles new snake_case types; special-cased labels only where the generic form reads poorly.

### 7. Interpretation as a server-side contract for downstream consumers

A shared server module (`src/server/identity`-style, e.g. `src/server/interpretation/`) owns the mapping from a stored message (type, flags, metadata) to `{ label, reason }`, and both repositories expose it through the read paths: message DTOs and memory-evidence entries carry the interpretation rather than leaving it to client string logic. The client renders what the server says (purely visual styling stays local). Rationale — three planned consumers must not reimplement or diverge from this logic:

- **Second brain**: evidence for a non-text message (poll, event, view-once) can say what the message *was* instead of presenting an empty row; extracted poll questions/event names are already real `body` text, so citations stay raw-stored-text faithful.
- **Full-text/semantic search**: extraction writes searchable text into `body`/`caption` (the exact fields FTS and embeddings will index), and structured extras (poll options, button labels, RSVP state, voters) use documented machine-readable metadata keys — queryable, embeddable, and stable.
- **MCP chat-reader / agent harness**: an agent reading the archive through a future MCP surface gets typed, self-describing messages (`messageType`, label, reason, structured metadata) — it can filter by type, quote honest placeholders, and never needs the web client to understand a message.

Alternative considered: keep placeholder strings in the React client (status quo, less code motion) — rejected because every future consumer would need to duplicate the honesty rules, and a bare type string like `unknown_82` would leak as the "meaning" to agents and search.

## Risks / Trade-offs

- [Baileys lacks a generic decryptor for some secret-encrypted kinds] → retain payloads regardless; decrypt poll votes now, others as library support allows; labels stay honest meanwhile.
- [45k add-on rows add import cost] → reuse the existing batched-write machinery; add-ons are a fraction of the 325k message volume already handled.
- [Backup edit/state data could clobber newer live state] → targeted updates carry timestamps and the existing apply path keeps the newest; verified by test.
- [Importer upsert might not refresh `message_type` on existing rows, breaking retroactive fixes] → verify early in apply; adjust the upsert so mapped-type and extracted-content fields refresh while richer live fields are preserved.
- [Code 64 rows may carry deletion time rather than post time] → user-flagged caveat; inspect real examples during apply, and if post time is unrecoverable, order honestly by what exists and note it in the placeholder.
- [Storing key material] → accepted deliberately (user decision, default on); local-only file that already contains the plaintext; excluded from every log/diagnostic path.

## Migration Plan

Additive tables only; no `identity_version` bump; existing archives keep working. The upgrade path for historical rows is a normal re-import of the latest backup (types, content, add-ons, and secrets all backfill). Rollback is a code revert — added tables are inert to older code.

## Open Questions

- Exact Baileys message-secrets helper surface (poll votes confirmed; event edits/`secretEncryptedMessage` TBD during apply).
- Code 64 timestamp semantics (deletion vs post time).
- ~~Unidentified codes~~ resolved 2026-07-07: the user annotated all findable codes; 82, 88, 116 (one row each) are permanently unidentifiable and stay honest `unknown_<code>` / "Legacy message" by design.
