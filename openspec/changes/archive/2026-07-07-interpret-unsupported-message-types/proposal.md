# Interpret Unsupported Message Types

## Why

About 1,400 backup-imported rows across 27 unmapped Android type codes — and every live poll, event, album, and business-template variant the live normalizer does not recognize — render as a bare "Unsupported message", even though their meaning is knowable: the user has now identified 24 of the 27 codes by checking real examples on their phone (the remaining 3 are single messages that could not be located). Separately, secret-encrypted live updates (message edits, event edits, poll votes) are honestly labeled but permanently unreadable because the archive keeps neither the per-message secret nor the encrypted payload. No message whose meaning is knowable should render as "Unsupported"; no message should be *permanently* unreadable when retaining a small secret would make it readable.

## What Changes

- **One shared message-type vocabulary across sources.** Backup type codes and live payload keys map to the same type strings (poll, event, album, view-once image/video, template and button variants, list and list-response, group invite, contacts array, payment invite, status mention, disappearing-timer change, admin-deleted, waiting-for-message). The same real-world message renders identically whether it arrived via backup or live sync.
- **Map the 24 user-identified Android codes** (11, 14, 24, 25, 26, 27, 28, 32, 36, 42, 43, 45, 46, 49, 51, 55, 57, 62, 64, 66, 92, 99, 103, 118) to real types or truthful typed placeholders. Re-importing a backup retroactively fixes historical rows — no archive re-initialization required.
- **Honest degradation for the rest.** The 3 permanently-unidentified codes (82, 88, 116 — one message each, accepted as unfindable) — and any future new code — render as a quiet "Legacy message" placeholder, never a bare "Unsupported message". The mapping is an extensible table, so a late identification would still slot in without rework.
- **Regenerable mapping worksheet.** A CLI command regenerates the private unknown-code worksheet from the archive (counts + example locations, no message bodies committed anywhere), so the user can identify remaining codes iteratively and see the list shrink.
- **Live normalizer completes its map.** Poll creation/updates, events, albums, buttons/list/list-response, payment invites, and other currently-unrecognized payload keys get first-class types instead of `unknown_<key>`.
- **Backup auxiliary tables are parsed.** `message_add_on` (reactions, edit history) from `msgstore.db` converges with the live-sync representation of reactions and edits, so backup-sourced reactions/edits are no longer invisible.
- **Message secrets are retained (user-approved, default on).** Per-message secrets from incoming live message envelopes are persisted so future secret-encrypted edits and poll votes can be decrypted; undecryptable secret-encrypted payloads are retained instead of dropped, and are decrypted retroactively when their secret arrives later (including investigating `msgstore.db` as a secret source during import). Documented as a deliberate privacy decision: the archive already stores the corresponding plaintext locally.
- **Honest "why" for the truly unreadable.** When a message still cannot be interpreted, the UI states the reason (encrypted update without its key / unidentified legacy type) — never a bare "Unsupported message".
- **Interpretation is a server-side contract, not a UI nicety.** Type strings, human labels, unreadability reasons, and extracted structured content (poll options, event times, button labels) are produced server-side in one shared module and exposed through read APIs — so the thread view, second-brain evidence, and future consumers (full-text/semantic search indexing, the MCP chat-reader server, any agent harness querying the archive) all see the same honest meaning without reimplementing it.

## Capabilities

### New Capabilities

- `message-interpretation`: honest typed interpretation of every archived message across sources — shared type vocabulary, Android type-code mapping with retroactive re-import fixes, backup add-on parsing (reactions/edits), message-secret retention with late decryption, regenerable mapping worksheet, and truthful placeholders with stated reasons for the unreadable remainder.

### Modified Capabilities

- `whatsapp-style-thread-view`: the placeholder requirement tightens — placeholder labels must name the real message kind when knowable (poll, event, view-once photo…) and state the reason when not (encrypted update without key, unidentified legacy type); a bare "Unsupported message" is no longer an acceptable rendering.

## Impact

- Affected code: `src/server/import/messageTypes.ts` + `parser.ts` + `importer.ts` (code map, `message_add_on` parsing, secret backfill investigation), `src/server/live/normalize.ts` (payload-key map, secret capture from envelopes), `src/server/db/*` (secret + retained-payload storage, reaction/edit convergence on existing structures, retroactive type update on re-import), a shared server-side interpretation module feeding message DTOs and memory evidence, `src/client/App.tsx` (rendering server-provided labels/reasons), README privacy note for secret retention.
- Downstream compatibility (user directive 2026-07-07): extracted content lands in the fields search and embeddings will index (`body`/`caption`); structured extras use documented, machine-readable metadata keys; the interpretation surface is what the planned full-text/semantic search, MCP chat-reader server, and agent-harness access will consume.
- **Schema**: additive only (secrets and retained payloads); existing message identity keys are untouched, so no `identity_version` bump and no forced re-initialization. A normal re-import of the same backup upgrades historical rows' types.
- The private worksheet (`.wapp-brain/unknown-type-report.md`) stays in the private workspace; artifacts and code carry only code numbers and type names, never chat names, timestamps, or message content.
- Absorbs backlog item `openspec/todos/interpret-unsupported-message-types.md` (deleted on archive of this change).
