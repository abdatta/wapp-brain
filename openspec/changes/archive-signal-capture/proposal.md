# Archive Signal Capture

> Proposal-level seed (2026-07-13). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

A decrypted-archive audit (2026-07-13, real `msgstore` — 288 tables) found the importer reads a focused subset and silently drops several *populated, high-value* source tables. Each is a deterministic identity link, a graph entity/edge, an extraction-evidence signal, or an engagement measure the second brain currently cannot see:

| Signal | In archive | Captured today | Consumer |
|---|---|---|---|
| Phone-number changes (`message_system_number_change`) | 457 (all JID-resolvable) | No | `two-level-person-model` (5) |
| Structured @mentions (`message_mentions` + quoted) | 5,639 / 4,525 msgs (+2,378) | Weak — backup only regexes @digits from text | `knowledge-graph` (9), `retrieval-hardening` (8) |
| Group membership timeline (`group_participant_user` + past) | 7,431 / 158 groups (+50 left) | No (join dates, admin rank, departures) | `two-level-person-model` (5), `knowledge-graph` (9) |
| Group subject/description/photo history (`message_system_value_change`/`_photo_change`) | 291 + 100 | No | chat-name late-binding; `knowledge-graph` (9) |
| Shared locations (`message_location`) | 153 (lat/long, place name/address) | No | `knowledge-graph` (9), evidence |
| Shared vCards (`message_vcard` + `_jid`) | 177 (72 JID-resolved) | No | `two-level-person-model` (5), `knowledge-graph` (9) |
| Link previews on backup import (`message_text` url/title/desc) | 3,121 / 4,931 | Live-only — backfilled msgs get none | `retrieval-hardening` (8), evidence |
| Message edits (`message_edit_info`) | 1,668 | Partial | evidence honesty |
| Deletions-for-everyone (`message_revoked`) | 1,279 | No | evidence honesty |
| Read/delivery engagement (`receipt_user`/`_device`) | ~480k | No (deliberately, until now) | salience (9), `browse-worthy-chat-list` |
| Media accessibility labels / transcriptions (`message_media`, `transcription_segment`) | 207 / 3 | No | `media-interpretation` demand signal |

Like `reply-quote-recovery` (21), most of these feed extraction evidence or identity repair, so **capture must precede `historical-backfill` (14)** — grabbing them after the one-shot extraction would force the re-import the roadmap exists to avoid. This change stops the drop and lands every signal in the archive with a clean shape; deep utilization is owned by the consumer changes named above (whose seeds are updated to consume it).

## What Changes

- **System-message decode**: parse `message_system` action types into typed rows — **number changes** (`old_jid → new_jid`, a certainty-grade person auto-connect source), **group membership events** (add / remove / join / leave), and **subject / description / photo-change history** (chat-name provenance over time). Achieves backup/live parity (live already sees some of these as events).
- **Structured @mentions**: import the source `message_mentions` / `message_quoted_mentions` (authoritative JID references) on backup import instead of relying on backup-side @digit regex, reconciled with the live path's structured `mentionedJids`.
- **Group participant timeline**: `group_participant_user` + `group_past_participant_user` — join timestamps, admin rank, and departures, as a membership history keyed to identity JIDs (read-time person aggregation, never a hard merge).
- **Shared locations & vCards**: `message_location` (coordinates + place name/address, incl. live-location) and `message_vcard` (+ `message_vcard_jid`) as structured attachments on their messages — explicit place and people references.
- **Link previews on backup import**: capture `message_text` url/title/description into the existing `message_link_previews` table (generalize the live-only path to backup), so historical shared links carry their context.
- **Edit & deletion honesty**: full edit history (`original_key_id`, edited timestamps) and revoke markers (who/when) so evidence shows the current text with an "edited" marker and renders deletions as an explicit `[deleted]` state rather than a silent gap.
- **Engagement aggregates (privacy-scoped)**: derive per-chat / per-contact signals from receipts (read-rate, median response latency) as **aggregates**, not the ~480k raw rows; local-only, excluded from logs/DTOs/exports, and available as a relationship-strength input.
- **Media interpretation crumbs**: capture populated `raw_transcription_text` / `transcription_segment` (only 3 today) and `accessibility_label` (207) as media interpretation labels — cheap, additive to the D13 media-gap signal, no model spend.
- **Evidence rendering + versioning**: mentions, locations, link previews, edits, and deletions render in evidence packs; this changes stored evidence, so `EXTRACTION_VERSION` bumps and `brain regenerate` picks up existing episodes.
- **Late-binding stamps**: each captured signal records its anchor + stamp + repair path per Standing Principle 3 (number-change and chat-name history fill two open inventory rows).
- **Checkpoint**: re-import a real backup — a spot-check confirms a number-change, a structured mention, a group join with its timestamp, a shared location, a shared vCard resolving to a JID, a backfilled link preview, an edit, and a deletion each land correctly; an evidence pack shows a mention/location/link/edit; the number-change feeds a person auto-connect suggestion.

## Utilization by consumer (updated seeds)

- **`two-level-person-model` (5)**: number-changes and vCard JIDs become certainty-grade / suggested auto-connect sources; the group-participant timeline powers succession detection.
- **`knowledge-graph-foundation` (9)**: `mentions` → mention edges; locations → place nodes; vCards → person references; group membership → `participates_in` edges with first/last-seen; engagement aggregates weight node salience.
- **`retrieval-hardening` (8)**: structured mentions feed the entity boost (its seed already assumes `message_mentions`, which this finally populates); link-preview title/description and quoted text become searchable.
- **`browse-worthy-chat-list`**: engagement aggregates inform chat ranking.
- **evidence (`brain-assimilation`)**: mentions/locations/link previews/edits/deletions render in packs (this change), riding the contract-v2 regeneration path.

## Capabilities

### Modified Capabilities

- `message-interpretation`: source-table capture extended to system messages, structured mentions, locations, vCards, link previews, edits, deletions, and media interpretation labels — with backup/live parity.
- `brain-assimilation`: Evidence Selection Policy amended to render the new signals; `EXTRACTION_VERSION` bump with regeneration.
- (Consumer capabilities — `person-identity-model`, knowledge-graph, `archive-full-text-search` — are amended in changes 5 / 8 / 9, which own the utilization.)

## Impact

- **Code**: `src/server/import/parser.ts` (decode the dropped source tables), `src/server/db/sqliteRepository.ts` + mirror (schema for the new signals, evidence query, commit), `src/server/live/normalize.ts` (parity for signals live already sees), `src/server/brain/episodes.ts` (evidence rendering, version bump).
- **Schema**: typed system-event tables (number-change, membership, subject/photo history), message mentions/locations/vcards attachments, extended edit/deletion state, engagement-aggregate tables; no archive-layer wipe; derived brain tables regenerate via contract-v2.
- **Tests**: per-signal capture from a modern fixture, live/backup parity, evidence rendering, engagement-aggregate correctness + privacy canary (no raw receipts in DTOs), regeneration upgrades old episodes, graceful skip when a source table is absent (legacy/iOS).
- **Depends on**: `episode-contract-v2` (3) — evidence rendering, `EXTRACTION_VERSION`, regeneration. Ordering: **must precede `historical-backfill` (14)**; lands beside `reply-quote-recovery` (21) and **before its consumers** `two-level-person-model` (5), `retrieval-hardening` (8), `knowledge-graph-foundation` (9) so the data exists when they build on it.
