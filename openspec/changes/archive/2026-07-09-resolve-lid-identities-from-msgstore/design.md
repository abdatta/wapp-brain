# Design: Resolve LID Identities From msgstore.db

## Context

The 2026-07-07 identity-integrity change built all the downstream machinery this change needs: persisted `identity_links` with first-write-wins semantics ([sqliteRepository.ts](../../../src/server/db/sqliteRepository.ts) `recordIdentityLinks`), JID canonicalization at every ingest point (`canonicalJid` in `upsertContacts`/`upsertChats`, `resolveChatSourceId` in the importer message path), idempotent `mergeIdentity` for late-learned links, a bounded background sweep (`sweepUnmergedIdentities`, 3 identities per recovery tick), name propagation from contacts to DM chats (`propagateContactNamesToDmChats`), and retroactive JID-join read paths. What is missing is purely the *source*: the parser's only backup-side link source is a LID column on `wa_contacts` rows ([parser.ts:337-354](../../../src/server/import/parser.ts)), and the real backup's `wa.db` has zero contact rows.

Measured facts from the real archive and decrypted backup (2026-07-09):

- `msgstore.db` `jid_map` (`lid_row_id`, `jid_row_id`, `sort_id`): 3,966 rows, all resolving to well-formed LID→PN pairs through the `jid` table.
- `msgstore.db` `lid_display_name` (`lid_row_id`, `display_name`, `username`): 2,646 rows with non-empty, text-like display names (zero digit-only values) — the phone's own display cache for LID users, i.e. exactly the names the user sees on the phone.
- Coverage of the 577 unresolved LID DM chats: 234 get name+phone, 136 name only, 207 phone only, **0 uncovered**. All 189 unresolved LID group senders are also covered.
- The parser already builds `jidMap` (jid `_id` → raw JID string) for message iteration, so both new readers are cheap lookups over structures that already exist.

Constraints: parser stays schema-defensive (every table/column presence-checked, per `hasTable`/`hasColumns`/`pickColumn` conventions); import remains idempotent; progress must be visible for any operation ≥~1s; no schema or identity-version changes.

## Goals / Non-Goals

**Goals:**

- A re-import of the existing backup names or phone-labels every currently-unresolved LID identity that the phone itself can name — completing within the import run, not over background ticks.
- Identity-link provenance is truthful per link source.
- Enrichment from the new sources is visible in the import summary.

**Non-Goals:**

- No changes to live sync, app-state handling, or re-pair flows (verified dead end for departed contacts).
- No use of `lid_display_name.username` (contact records have no username field).
- No schema migration or identity-version bump: `identity_links` and `contacts` absorb the new data as-is.
- No removal of the `wa.db` link source (harmless when empty, still valid on other backups).

## Decisions

### D1: `jid_map` is read into `identityLinks` through the existing `jidMap` structure

A new parser step `readMsgstoreIdentityLinks(msgstoreDb, msgInspection, jidMap, identityLinks)` runs right after `buildJidMap`: for each `jid_map` row, look up both `_id`s in the in-memory `jidMap`, keep pairs where the LID side satisfies the existing LID-form predicate (`@lid` / `@hosted.lid`, same as `isLidFormJid`) and the other side ends in `@s.whatsapp.net`, and push `{lid, pn}`. Guarded by `hasTable`/`hasColumns` like every other sidecar read — legacy msgstores without `jid_map` skip silently.

*Alternative considered:* SQL join `jid_map × jid` inside SQLite — rejected; `jidMap` is already fully materialized in memory for message iteration, so a join adds a second scan for nothing.

### D2: `lid_display_name` names enter `contactMap` keyed by LID JID, after `wa.db`

A new parser step `readLidDisplayNames(msgstoreDb, msgInspection, jidMap, contactMap)` sets `displayName` on the LID-keyed contact record (creating it if absent, `rawMetadata.source: "lid_display_name"`), only when the record has no display name yet. Ordering makes precedence structural: `readWaContacts` (address-book names, PN-keyed) runs first, `readLidDisplayNames` second, `readJidContacts` (bare stubs) last. When a LID contact and a PN contact canonicalize onto one identity inside `upsertContacts`, the batch merge prefers the earlier record's name — so a real `wa.db` address-book name beats the phone's LID display cache, which beats nothing. No repository changes needed.

The name lands in `display_name` (not `push_name`): `lid_display_name` is the phone's chosen label — for saved contacts the address-book name — and the archive's fidelity goal is "what the phone shows". The risk of it being a push name for unsaved contacts is acceptable: display order (`display_name → push_name → phone`) surfaces the same string either way.

*Found during implementation:* the memory repository's `upsertContacts` was last-non-empty-wins within a batch, unlike SQLite's first-in-batch-wins dedup — a LID cache name canonicalizing onto a PN identity would have clobbered its wa.db name on that adapter. Fixed to mirror the SQLite batch semantics so the precedence guarantee holds on both.

*Alternative considered:* storing as `push_name` to avoid conflating with saved names — rejected; it would lose to any stray push name already on the PN contact and misrepresent the phone's own labeling.

### D3: Importer merges the still-split set, sweep stays as backstop

After recording links with per-link `source` (`msgstore.jid_map` or `wa.db`, replacing today's hardcoded label at [importer.ts:145](../../../src/server/import/importer.ts)), the importer runs `listUnmergedLidIdentities` — the same "archived LID rows that now have links" query the background sweep uses — and calls `mergeIdentity(lid, pn)` for each, before contact/chat upserts, emitting progress (`step: "identity-merge"`, counts every 25 merges with event-loop yields) since a real heal exceeds 1s. *(Refined during implementation from "merge each newly-learned link": the still-split set is strictly better — it is empty on fresh imports and post-heal re-imports without any bookkeeping, and it also drains any sweep backlog from links learned while the archive was closed.)* Merging before ingest means the rest of the import writes into already-canonical rows, and the (chat, key_id) idempotency check sees the merged row — without this, re-imported messages for a LID chat would land in a fresh PN chat while old rows sit in the LID chat until the background sweep (at 3/tick, hours) collapses them, transiently duplicating history. The maintainer sweep is unchanged and still covers links learned while the archive is closed.

*Alternative considered:* raising the sweep batch size instead — rejected; it leaves the archive transiently duplicated after re-import and ties healing latency to live-session ticks, which don't run at all if the user doesn't pair.

### D4: Enrichment reporting gains per-source counts

The existing `CONTACT_ENRICHMENT` info warning keeps its shape and adds context fields: `jidMapLinks`, `lidNamesRead`, and the existing `identityLinks` total. The human-readable message mentions the msgstore-derived counts so an empty `wa.db` no longer reads as "enrichment did nothing".

## Risks / Trade-offs

- [`jid_map` could contain a wrong mapping, and links are irrevocable first-write-wins] → the table is the phone's own authoritative mapping (WhatsApp itself routes chats through it); malformed pairs are filtered by the same strict predicates `recordIdentityLinks` already enforces.
- [~441 `mergeIdentity` transactions lengthen the import] → each merge is a small per-identity transaction (the affected chats average ~6 messages); progress events keep it visible; merges only run for *newly* learned links so subsequent re-imports pay nothing.
- [`lid_display_name` may hold push names for unsaved contacts] → accepted (D2); the string is still what the phone displays.
- [A future backup format may rename/drop these tables] → both readers are presence-guarded and degrade to today's behavior with no warning noise beyond the enrichment counts reading zero.

## Migration Plan

No schema change. User-visible path: pull the change, re-run the backup import (idempotent), watch the enrichment summary and identity-health counts drop. No re-init, no re-pair. Rollback is a no-op: links and names already recorded are valid regardless of code version.

## Open Questions

- None blocking. (Verified during analysis: `jid_map` and `lid_display_name` exist with usable data in the real backup; `wa.db` is empty; coverage is 100%.)
