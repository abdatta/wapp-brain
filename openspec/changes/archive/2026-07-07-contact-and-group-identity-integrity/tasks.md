# Tasks: Contact And Group Identity Integrity

## 1. Identity Model Foundations

- [x] 1.1 Add `identity_links` table and `schema_meta` with `identity_version`; refuse opening archives without the current version, with the re-init/re-import/re-pair message (server, CLI, importer entry points).
- [x] 1.2 Add repository identity API: `recordIdentityLinks(links)`, `resolveIdentity(jid)` (persisted-link canonicalization), `listUnmergedLidIdentities()`; implement in both repositories.
- [x] 1.3 Unify message identity: `wa|<canonical chat>|<key_id>` keys and raw `key_id` as `source_message_id` in `normalize.ts` (drop participant/fromMe segments) and `parser.ts` (drop hashed source-prefixed keys); surrogate `row:<adapter>:<rowid>` for keyless legacy rows; update `liveMessageKey`/decoders/anchor construction accordingly.
- [x] 1.4 Tests: same message via backup-shaped and live-shaped ingestion converges to one row; LID vs phone delivery converges; legacy keyless rows stay idempotent across re-import; old-version archive is refused with the remedy message.

## 2. Mapping Capture And Canonicalization

- [x] 2.1 Feed `identity_links` from history-sync `lidPnMappings`, `lid-mapping.update`, and contact records carrying both LID and phone forms (live path).
- [x] 2.2 Canonicalize all importer JIDs through `resolveIdentity`; investigate and, if present, extract LID↔phone data from `wa.db` as a link source.
- [x] 2.3 Tests: link learned from each source persists across restart and canonicalizes subsequent ingestion of either form.

## 3. Late Identity Merge

- [x] 3.1 Implement `mergeIdentity(lid, pn)` in the repositories: chats (message move + `(chat,id)` conflict collapse keeping richer row), contacts (COALESCE-merge), participants, checkpoints, gap windows; delete husks; route removed message ids through memory staleness.
- [x] 3.2 Trigger merge on first learn of a link; add a bounded per-tick sweep in the maintainer for archived LID identities that have links (covers offline-learned links).
- [x] 3.3 Tests: split DM merges with both histories under one chat; duplicate message rows collapse to richer; checkpoints/gaps follow the merge; merge is idempotent when re-run.

## 4. Importer Unification And Visible Enrichment

- [x] 4.1 Import summary gains `contactsRead / contactsMatched / namesImproved`; propagate contact names to senders and DM chats retroactively (by-JID join makes message senders live-updating; verify chat propagation covers group senders' display).
- [x] 4.2 Tests: importing `wa.db` after messages improves displayed names without re-importing messages, and the summary reports the counts.

## 5. Group Naming Pass

- [x] 5.1 Add `fetchGroupMetadata?(jid)` to `LiveWhatsAppClient` (Baileys `groupMetadata`); confirm it is absent from the read-only blocklist.
- [x] 5.2 Naming pass in the recovery tick: bounded unnamed-group fetches per tick with per-chat backoff; store subject + participants (`membership_source: "source"`).
- [x] 5.3 Tests: unnamed group gets subject/participants after a tick; fetch failures back off and keep the group in health counts; pass is bounded.

## 6. Display Rules And Identity Health

- [x] 6.1 Read paths join contacts by JID and resolve display as name → push name → phone digits → NULL, with resolved/unresolved flags in chat and message DTOs; never emit a raw JID as the display name.
- [x] 6.2 `getLiveStatus()` gains `identityHealth { unnamedGroups, unresolvedLids, samples }`; UI renders "Unresolved contact" / "Unnamed group" labels, client-side phone formatting, and an identity-health alert in the Live panel + guided setup when counts are non-zero.
- [x] 6.3 Tests: display fallback chain per scenario (push name, phone, unresolved); identity health counts and quiet-when-healthy behavior.

## 8. Group Sender Attribution (added during 7.2)

- [x] 8.1 Read the sender from `key.participant ?? message.participant` in the live normalizer; for group chats, never fall back to the chat JID (unknown sender stays null); resolve the top-level participant through the JID resolver.
- [x] 8.2 Never create message-derived contact records for a sender equal to the chat itself.
- [x] 8.3 Read paths (both repositories): a group message whose stored sender equals the chat JID displays as unresolved, covering legacy rows.
- [x] 8.4 Tests: history-shaped group message with top-level participant attributes correctly; group message with no participant stays unresolved (and no group-jid contact appears); legacy group-jid senders render unresolved.

## 9. Mention Display Resolution (added during 7.2)

- [x] 9.1 Shared mention-token helpers (`src/server/identity/mentions.ts`): extract `@<digits>` tokens and apply resolved labels to display text.
- [x] 9.2 Resolve mention labels in both repositories' `listMessages` read paths (body and caption): digits → phone/LID JID candidates → canonical identity → contact display chain; leave unresolved tokens unchanged; stored rows untouched.
- [x] 9.3 Tests: LID-digit mention resolves via identity link to the contact's name; phone-digit mention resolves; unknown digits stay raw; stored body unchanged.

## 10. Mention Highlighting (added during 7.2)

- [x] 10.1 Message DTO carries the applied mention labels (`mentions`); both repositories populate it from the read-path label resolution (body and caption).
- [x] 10.2 Client wraps mention tokens — resolved labels (exact-match, longest-first) and raw unresolved `@digits` — in a WhatsApp-style accent span in bubbles and system chips.
- [x] 10.3 Tests: DTO mention labels cover body and caption and exclude unresolved digits, in both repositories.

## 7. Verification

- [x] 7.1 Full suite green; every delta-spec scenario mapped to at least one test; update existing tests broken by the key change.
- [x] 7.2 Real-device end-to-end: `init-db` fresh → import latest backup → re-pair → verify the previously duplicated group thread shows single rows with named senders, unnamed-group alert lists real cases, and a second import of the same backup plus live overlap creates zero duplicates. (Verified 2026-07-07 on the real archive: v2 format, re-paired live session connected, 103 unnamed groups / 732 unresolved LIDs alerting, second import of the same 325,413-message backup added zero rows and zero duplicates.)
- [x] 7.3 Docs: README/ARCHITECTURE identity section; delete the absorbed backlog todo on archive.
