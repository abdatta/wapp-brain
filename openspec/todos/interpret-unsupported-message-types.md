# Interpret Unsupported Message Types

## Type

Feature / investigation

## Status

Needs specification (user-assisted mapping in progress)

## User Goal

No message should render as "Unsupported message" when its meaning is knowable. Every archived message should either display real content, a truthful typed placeholder (poll, event, payment, call…), or an honest statement of why it cannot be shown.

## User Observation

Two distinct populations render as "Unsupported":

1. **Backup-imported rows with unmapped Android type codes** (~1,400 rows across 27 distinct `unknown_<code>` values, 2017–2026). The data is fully decrypted in the backup — these are purely unmapped codes plus unparsed auxiliary tables (e.g., reactions/edits in `message_add_on`). A mapping worksheet with per-code examples was generated at `.wapp-brain/unknown-type-report.md` (private); the user offered to identify codes by checking the example messages on their phone.
2. **Live `secretEncryptedMessage` payloads** (edit/event-edit updates). These use WhatsApp's "message secrets" layer: encrypted with a per-message key distributed inside the original message's envelope. The archive retains neither the secret nor the encrypted payload, and the client library does not decrypt this type. Now labeled honestly ("Encrypted edit of an earlier message") instead of "Unsupported".

## Expected Behavior

- Android type codes confirmed via the worksheet map to real message types (or typed placeholders) on the next import, retroactively fixing historical rows.
- Backup auxiliary tables that carry reactions and edit history are parsed so backup-sourced edits/reactions match the live-sync representation.
- A deliberate decision is made on message-secret retention: if adopted, secrets from incoming live messages (and possibly from `msgstore.db` backups — see questions) are stored so future secret-encrypted edits and poll votes can be decrypted; encrypted payloads are retained until decryptable.

## Behavior Questions

- Does `msgstore.db` carry message secrets (the phone must persist them to decrypt late poll votes) — and if so, can a backup import backfill secrets for messages we already hold?
- Is storing per-message key material in the archive acceptable under the privacy posture, given the archive already stores the plaintext messages themselves? Should it be opt-in?
- Should undecryptable payloads be retained (enables later decryption after a fresh backup) or dropped (current behavior, smaller archive)?
- For type codes the user cannot identify (very old messages), is a generic "Legacy message" placeholder acceptable?

## Privacy Notes

The mapping worksheet contains chat names and timestamps only — it lives in the private workspace and must never be committed. Message secrets are cryptographic key material; retention must be a documented, deliberate choice even though the archive already holds the corresponding plaintext.

## Acceptance Sketch

- **WHEN** a backup is imported after the type-code mapping lands
- **THEN** previously "Unsupported" rows with mapped codes display as their real types.

- **WHEN** a secret-encrypted edit arrives for a message whose secret the archive retains (if retention is adopted)
- **THEN** the edit is decrypted and applied to the original message like any other edit.

- **WHEN** a message genuinely cannot be interpreted
- **THEN** the UI states why (encrypted update without key / unmapped legacy type), never a bare "Unsupported message".
