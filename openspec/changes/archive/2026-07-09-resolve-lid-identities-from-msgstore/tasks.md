## 1. Parser: new msgstore identity sources

- [x] 1.1 Add `readMsgstoreIdentityLinks(msgstoreDb, msgInspection, jidMap, identityLinks)` in `src/server/import/parser.ts`: presence-guarded read of `jid_map` (`lid_row_id`, `jid_row_id`), resolve both sides through the in-memory `jidMap`, push pairs where the LID side is `@lid`/`@hosted.lid` and the other side is `@s.whatsapp.net`; tag emitted links with their origin so the importer can record per-source labels (extend the `identityLinks` element type with a `source` field).
- [x] 1.2 Add `readLidDisplayNames(msgstoreDb, msgInspection, jidMap, contactMap)`: presence-guarded read of `lid_display_name` (`lid_row_id`, `display_name`), set `displayName` on the LID-keyed contact record only when empty, `rawMetadata.source: "lid_display_name"`; ignore the `username` column.
- [x] 1.3 Wire both into `parseWhatsAppSource` with precedence-by-ordering: `readWaContacts` (tag its links `source: "wa.db"`) → `readMsgstoreIdentityLinks` → `readLidDisplayNames` → `readJidContacts`.

## 2. Importer: per-source links, in-import merge, visible enrichment

- [x] 2.1 Replace the hardcoded `source: "wa.db"` at `recordIdentityLinks` call time in `src/server/import/importer.ts` with each link's own source label (`wa.db` / `msgstore.jid_map`).
- [x] 2.2 After recording links and before contact/chat upserts, run the identity-merge pass (implemented via `listUnmergedLidIdentities` — the still-split set, a superset of newly-learned links that is empty on fresh imports and post-heal re-imports); emit a progress step (`step: "identity-merge"`) with running counts, yielding between merge batches.
- [x] 2.3 Extend the `CONTACT_ENRICHMENT` summary warning: context gains `jidMapLinks`, `lidNamesRead`, per-source link counts, and `identityMerges`; message text mentions msgstore-derived enrichment so an empty `wa.db` no longer reads as zero enrichment.

## 3. Tests

- [x] 3.1 Parser test: synthetic `msgstore.db` with `jid`, `jid_map`, and `lid_display_name` tables → `parseWhatsAppSource` emits the expected identity links (with sources) and LID-keyed contacts with display names; msgstore without those tables emits neither and no warnings.
- [x] 3.2 Precedence test: same identity named in both `wa.db` (`wa_contacts` row with LID column) and `lid_display_name` → the `wa.db` name wins on the canonical contact after import (also fixed memory-repo batch precedence to mirror SQLite first-in-batch-wins).
- [x] 3.3 Importer heal test: archive pre-seeded with a LID-keyed chat + messages and no link; import a backup whose `jid_map` maps that LID → after import, one canonical PN chat holds both histories, the LID husk is gone, and no duplicate `(chat, key_id)` rows exist; re-import is a no-op (zero new rows, zero merges).
- [x] 3.4 Enrichment summary test: import with empty `wa.db` but populated msgstore tables → `CONTACT_ENRICHMENT` context reports `jidMapLinks` / `lidNamesRead` counts.

## 4. Verify on the real archive (user checkpoint)

- [x] 4.1 Run the full test suite and typecheck (158/158 tests pass; only pre-existing unrelated `gpt-oauth-client` typecheck error remains).
- [x] 4.2 Re-import the real backup (CLI merge-mode import alongside the running server, archive backed up first): 3,966 jid_map links read, 2,646 LID names read, 2,273 split identities merged, 0 skipped rows, 0 duplicate (chat, key_id) pairs; unresolved LID DMs 577 → 0, unresolved LID senders 189 → 0, named PN DMs 583 → 2,050.
- [x] 4.3 User try-it checkpoint: verified — unresolved LID DMs and senders are healed (0 remain); the one chat still showing "Unresolved contact" turned out to be an unnamed phone-keyed chat surfaced through the search deep-link display bug, fixed in section 5 (correct display for it is its phone number; naming it would require an address-book import, noted as possible follow-up).

## 5. Search deep-link display integrity (found during checkpoint)

- [x] 5.1 Global-search hits (FTS path, `sqliteRepository.ts` searchMessages) apply the phone-number display fallback to `chatDisplayName` instead of returning NULL for unnamed phone-keyed chats; memory repository search path fixed identically.
- [x] 5.2 Thread header no longer shows a fabricated "0 messages" when a chat was opened from a search hit that isn't in the loaded chat-list page (count segment hidden when unknown/zero).
