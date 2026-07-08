# Tasks: Interpret Unsupported Message Types

## 1. Shared Type Vocabulary

- [x] 1.1 Extend `messageTypeFromCode` with the 24 user-confirmed codes → shared type strings (design table); the 3 permanently-unidentified codes (82, 88, 116) keep `unknown_<code>`; preserve `rawTypeCode` on every row. (Also retired the textless-unknown-implies-deleted parser heuristic — deletion now only from admin revocation facts — and made `hasMedia` type-accurate via `isMediaMessageType`.)
- [x] 1.2 Extend live `detectMessageType` to the same vocabulary: poll creation, event, album, list, list response, buttons/template variants, group invite, payment invite (+ `messageHistoryBundle` → history_share, `statusMentionMessage` → status_mention, `ptvMessage` → video); `pollUpdateMessage` → `encrypted_update` until the 4.4 state-update path; live text extraction for poll/event/invite/list/buttons content.
- [x] 1.3 Verified: upsert refreshes `message_type` with an unknown-never-downgrades guard (added same guard to memory repo); added scoped heal so textless-unknown rows mis-flagged deleted by the retired heuristic get un-deleted and accept extracted body on re-import (both repositories).
- [x] 1.4 Tests (tests/interpretation.test.ts): backup codes + live payloads share vocabulary; re-import upgrades `unknown_66` → `poll` in place with heuristic-deletion heal (memory + sqlite); weak types never downgrade; unconfirmed codes stay `unknown_<code>`.

- [x] 1.5 (added during user review) Full audit of the pre-existing classic-code map against the real archive (mime distributions, sidecar joins, timestamp magnitudes). Confirmed correct: 0,1,2,3,4,5,7,9,13,14,16. Four folklore mislabels corrected, each proven structurally: 20 `product`→`sticker` (all webp media, no `message_product` links), 15 `sticker`→`revoked` (all 1,215 rows join `message_revoked`; sender-revoked + admin-revoked = exactly the table's 1,279 rows), 90 `status`→`call` (all 832 rows join `message_call_log`; call metadata — video flag, duration — extracted), 10 `call`→`missed_call` (all 279 rows join `missed_call_logs`). Also closed live-side gaps found by the audit: `productMessage`→product, `callLogMesssage`→call. Bonus identifications: code 82 (previously accepted-unknown) = `view_once_audio` — opus voice media joined to `message_view_once_media`, completing the 42/43 view-once family; code 88 = `bot_feedback` — 1:1 join with `message_bot_feedback` (thumbs up/down on a Meta AI response); code 8 corrected `audio`→`call` per forensic documentation (zero rows locally, so inert). Code 116 is the single remaining unknown (from-me textless group row, unique `view_mode=100`, no sidecar links — an invisible client control message) and stays honest. Re-import upgrades all rows in place.

## 2. Content Extraction From Sidecar Tables

- [x] 2.1 Parse `message_poll` + `message_poll_option` (options + vote totals → metadata; question already rides `message.text_data`), `message_event`(+`_invite`) (name → body, description → caption, time/location/link → metadata), `message_template` + `message_template_button` and `message_ui_elements` (text + button labels), `message_group_invite` (group name), `message_revoked` (admin + revoke time) — preloaded maps, guarded per-archive, typed placeholder as the floor.
- [x] 2.2 Investigated on the real archive: `message.timestamp` on code-64 rows is the original post time (revoke deltas positive when present, ≤ ~26h; `revoke_timestamp` often absent) — chronological ordering stays honest; the revoking admin and revocation time land in `rawMetadata.revoked`.
- [x] 2.3 Tests: poll question in body + options/votes in metadata; template text/buttons extracted (both `message_template` and `message_ui_elements` shapes); group invite and event content extracted; admin-revoked keeps post time with revocation metadata and `isDeleted`; album with no sidecar falls to the typed placeholder floor.

## 3. Backup Add-On Convergence

- [x] 3.1 Parse `message_add_on` + `message_add_on_reaction` into targeted reaction updates keyed by canonical `(chat, key_id)` with deterministic import event keys (`import:reaction:<key>:<actor>`); applied through `applyLiveMessageUpdates` in both repositories (CHECK-constraint migration rebuilds `live_message_updates` on older archives).
- [x] 3.2 `message_edit_info` handled at identity level (discovered: Android re-keys edited rows in place — current `key_id` is the edit's key): importer keys edited rows by `original_key_id` so backup and live copies converge on one row, with `edited`/`editedAtMs`/`latestEditKeyId` metadata.
- [x] 3.3 `message_add_on_poll_vote` + selected options → per-voter `poll_vote` updates merged into the poll row's `rawMetadata.poll.votes` (newest-wins per voter); `message_add_on_event_response` → `event_response` updates into `rawMetadata.event.responses`; shared merge in `src/server/db/interactions.ts` used by both repositories.
- [x] 3.4 Tests: backup reaction applies with the live metadata shape and double import stays idempotent; edited message archives under its original key with edit metadata; add-on on an edited message targets the original identity; poll votes attach with options; older interaction state never clobbers newer (unit).

## 4. Message Secrets And Late Decryption

- [x] 4.1 Additive storage keyed by canonical message key: `message_secrets` (secret blob + source, first-write-wins) and `retained_encrypted_payloads` (blob + iv + kind + target + actor, idempotent by event key); implemented in both repositories.
- [x] 4.2 Live capture: `messageContextInfo.messageSecret` persisted from incoming envelopes (top-level and unwrapped); maintainer records secrets per event and keeps the linked-device jid for "me" resolution.
- [x] 4.3 Import backfill: backup `message_secret` joined by identity-aware `key_id` (edited rows → original key); `SECRET_BACKFILL` import summary reports newly backfilled count and retroactive decryptions.
- [x] 4.4 Poll votes and event responses retained as payloads (no message rows) and decrypted via Baileys `decryptPollVote`/`decryptEventResponse` — immediately when the secret is held, retroactively on secret arrival, bounded pass per maintainer tick; sha256 option matching against archived poll options; raw actor jid preserved for HKDF fidelity (wrong-form identities fail closed and stay retained). `secretEncryptedMessage` keeps its honest row and is additionally retained (no public decryptor yet).
- [x] 4.5 README privacy section documents the deliberate default-on secret retention and payload retention.
- [x] 4.6 Tests: live secret captured from envelope; vote payload retained without secret, decrypted retroactively once the secret arrives (real HKDF+AES-GCM round trip against Baileys' decryptor); backup backfill keyed to original identity and idempotent across double import; secret material absent from status and message DTOs.

## 5. Interpretation Surface (UI And Downstream Consumers)

- [x] 5.1 Shared server-side interpretation module (`src/server/interpretation/messageInterpretation.ts`) mapping a stored message to `{ label, reason }` for every type, with honest reasons for view-once, waiting-for-message, encrypted updates, and `unknown_*` → "Legacy message (code N)"; structured-metadata keys documented at their definitions (poll options/votes, template buttons, event responses, revoked).
- [x] 5.2 Interpretation exposed through both repositories' message DTOs and memory-evidence entries; client renders server labels + reasons (placeholder + reason line) and its local placeholder map is reduced to a thin fallback — the bare "Unsupported message" string no longer exists in src.
- [x] 5.3 `encrypted_update` interpretation states the reason ("Encrypted with a key the archive does not hold"); decrypted poll votes/event responses never surface as encrypted rows at all (state updates), and retained ones stay honestly labeled.
- [x] 5.4 Tests: DTO interpretation per type (poll, view-once with reason, legacy with code, admin-deleted, plain text null); memory evidence self-describing for non-text messages; extracted poll question present in stored body.

## 6. Regenerable Worksheet

- [x] 6.1 CLI command (`npm run unknown-report`) regenerating `.wapp-brain/unknown-type-report.md` from the archive via `listUnknownTypeCodes()` (both repositories; chat labels follow the display rule — name → phone → explicit unnamed state, never a raw jid), merging existing "What is it?" annotations by code; `.wapp-brain/` confirmed gitignored.
- [x] 6.2 Tests: regeneration preserves annotations, mapped codes drop off, examples ordered newest-first, "do not commit" notice present.

## 7. Verification

- [x] 7.1 Full suite green (100 tests, 8 files); every delta-spec scenario mapped to at least one test (interpretation.test.ts covers vocabulary, upgrades/healing, extraction, add-on convergence, secrets round-trip, worksheet, consumer exposure; thread-view placeholder scenarios via DTO interpretation tests).
- [x] 7.2 Real-archive end-to-end (2026-07-07): re-import of the same backup upgraded 1,321 unknown-typed rows down to exactly 3 (codes 82/88/116, one row each); 1,025 heuristic-deleted rows healed; all 74 polls carry question text; 42,257 backup reactions + 1,138 poll votes + 1 event response applied to originals; 1,668 stale edit-key rows collapsed onto canonical identity (one converged with its live-archived copy); 71,513 secrets backfilled; `npm run unknown-report` regenerates with only the 3 accepted-unknown codes. (Also added during verification: `collapseSupersededMessages` — old archives held edited rows under edit keys, which would have duplicated on re-import.)
- [x] 7.3 Docs: README (secrets privacy decision, `unknown-report` command) and ARCHITECTURE (Message Interpretation section, new tables); the absorbed backlog todo is deleted on archive.
