## 1. Shared masked-number predicate

- [x] 1.1 Add `isMaskedNumberLabel(value)` to the identity utilities (near `displayPhoneFromJid`): true when the string, ignoring a leading `+` and spaces, is composed only of digits and mask characters (`∙` U+2219, `•` U+2022, `·` U+00B7, `‧` U+2027, ASCII `.`) AND contains at least one mask character. Any letter disqualifies it.
- [x] 1.2 Unit-test the predicate against: masked forms (`+91∙∙∙∙∙∙∙∙86`, spaced variants), real names, names containing digits, and full/partial real numbers (which must be false).

## 2. Ingestion + write-path normalization

- [x] 2.1 In `src/server/import/parser.ts`, when resolving a contact's and a chat's display name from the backup, drop it to null if `isMaskedNumberLabel` holds — so the masked value never enters the archive.
- [x] 2.2 In `upsertContacts` (and the chat display-name write path) in `src/server/db/sqliteRepository.ts`, coerce an incoming masked `display_name` to empty before the COALESCE-preserving upsert, so live sync / Google enrichment / any writer cannot store a masked name.

## 3. Formatted `+E.164` phone fallback

- [x] 3.1 Introduce (or extend `displayPhoneFromJid` into) a shared display-resolution helper that yields, in order, a real name, a push name, then the complete `+E.164` number derived from `phone_number` or the phone-form JID — never bare digits or a mask.
- [x] 3.2 Apply it at the identity-resolution sites (the ~9 `COALESCE(display_name, push_name, phone_number)` queries in `sqliteRepository.ts`: evidence sender, reactor, quoted referent, search, thread view, nearby-context, …) so phone-form identities always render the full formatted number; confirm the brain path is unaffected (it already layers `displayPhoneFromJid`).

## 4. One-time backfill

- [x] 4.1 Add an idempotent migration that nulls `display_name` on `contacts` and `chats` wherever the value is a masked-number placeholder (predicate replicated in SQL or applied in a bounded scan), leaving `phone_number`, JIDs, and messages untouched. Log the counts cleared.
- [x] 4.2 **Recompute derived search state after the backfill** — `resolved_text` embeds the sender label, so nulling a masked `display_name` must recompute the affected senders' messages via `syncMessageDerivedState` (in-transaction, like the merge path) or a one-time `rebuildSearchIndex`; otherwise search keeps matching/showing the old masked label. (This is the same rename-recompute concern `retrieval-hardening` (#8) / `identity-late-resolution` (#4) generalize into a shared hook; demask needs its own trigger since it lands first.)
- [x] 4.3 Verify idempotency (a second run clears zero), that raw numbers/JIDs are intact, and that a former masked-label sender's messages now match its full number in search.

## 5. Tests

- [x] 5.1 Ingestion: importing a contact/chat whose backup display name is masked stores a null display name; resolution returns the formatted number.
- [x] 5.2 Write-path guard: `upsertContacts` with a masked `display_name` does not persist it (live-sync path covered).
- [x] 5.3 Phone fallback: a phone-form sender with no name resolves to `+E.164` (with `+`, full digits), for both `phone_number`-present and JID-only cases.
- [x] 5.4 Unmapped LID: a masked-only LID with no derivable number resolves to the explicit unresolved state and is counted in identity health, not labeled with the mask.
- [x] 5.5 Backfill: a seeded archive with masked contact + chat rows is cleaned on migration, is idempotent, and preserves numbers/JIDs.

## 6. Checkpoint

- [x] 6.1 Run the backfill on the real archive; confirm `contacts`/`chats` masked-name counts drop to ~0 and spot-check that former `+91∙∙∙∙∙∙∙∙86` senders now read as full numbers in search and the thread view.
- [x] 6.2 Re-assimilate (or reset + re-run) one previously-masked brain chat (e.g. Party @ Kelton `120363418904222042@g.us`) and confirm episode claims now carry full numbers or real names, with no `∙` masks.

## 7. Self-heal: a stored mask never blocks a learned name

- [x] 7.1 In `enrichContactsFromGoogle` (`sqliteRepository.ts`) and the in-memory adapter's equivalent, add `isMaskedNumberLabel(display_name)` to the overwrite-precedence ("weak") check, so a masked-number placeholder already stored as a display name is treated as no-name and a learned real name (Google Contacts today, any future name source) replaces it instead of being shadowed by the mask. This closes the last site that still read a mask as a strong saved name — the gap that left phone-form contacts (e.g. the real "Me US (Mint)" number) nameless when a sync ran while the mask was still present.
- [x] 7.2 Tests: enrichment overwrites a masked display name and heals the DM title + sender label to the learned name; a genuine saved name is NOT overwritten (boundary). Both adapters exercised via the shared repository API.
- [ ] 7.3 Checkpoint (forward-looking): confirm the loop self-heals with no manual re-sync — because the Google sync already auto-runs on each brain run ([server.ts](../../../src/server/server.ts)), a newly-nameless or masked phone-form contact that exists in Google Contacts should read as its real name after the next brain run. Spot-check against the previously-unresolved "already in Google Contacts" cohort (e.g. the UCLA senders surfaced 2026-07-13).
