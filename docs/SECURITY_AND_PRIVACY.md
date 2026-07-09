# Security And Privacy

## Core Rule

All WhatsApp data stays local by default.

Do not upload:
- message content
- contacts
- metadata
- media
- database files
- backup/decryption keys
- logs containing private data
- generated second-brain wiki files, summaries, embeddings, or indexes
- live WhatsApp linked-device auth/session state
- live sync checkpoints, gap windows, event receipts, or raw protocol payloads

## Secret Handling

Backup keys and decrypted databases are extremely sensitive.

The app should:
- accept keys only from explicit user input
- avoid storing keys
- prefer `--key-file` over raw `--key` in shell history
- remove decrypted databases by default
- warn when `--keep-decrypted` is used

The UI import wizard verifies keys locally before import. The key is provided as text only (no key file in the UI) and is used for the local verification/import request without being persisted in the archive. Backup files are read in place from the folder you select — nothing is uploaded or copied into the app. Only the importer's decrypted intermediates and temporary import rollback snapshots are written under the local work dir, and should be treated as sensitive local data until the job or cleanup removes them.

## Logging

Default logs must not include:
- backup keys
- message bodies
- raw database rows
- contact dumps
- full private file paths when avoidable
- live auth state, QR/pairing secrets, or raw WhatsApp Web payloads

The CLI writes debug logs under `.wapp-brain/logs`. Keep those logs metadata-oriented and assume they may still be sensitive.

## Second-Brain Memory

Generated memory is derived WhatsApp data and is private by default.

The memory store writes under `.wapp-brain/memory/` unless explicitly configured otherwise. Markdown pages are Obsidian-compatible plain files, but opening them in Obsidian or syncing that folder is a user-controlled privacy decision.

Remote model use is disabled by default. Codex-backed memory generation requires explicit opt-in through the memory provider controls. When enabled, only selected evidence packs are sent to the provider, and default logs still must not include prompts, message bodies, raw model output, or OAuth tokens.

Dry-run evidence previews can contain message bodies. They are written only under the private memory directory and should be treated like the archive itself.

## Live Maintainer

Live sync is explicit opt-in. Backup import does not pair with WhatsApp, connect to WhatsApp Web, or create live credentials.

The live maintainer:
- refuses pairing/start until an imported archive baseline exists and is recent enough for bounded recovery
- stores auth/session files under `.wapp-brain/live`
- uses a code-level WhatsApp Web client rather than browser automation
- keeps per-chat checkpoints and gap reports in the local archive
- refuses known-vulnerable live client versions during doctor/start checks
- reports uncertain gaps when WhatsApp Web cannot prove history continuity
- runs with app-level read-only guards that block known send, read-receipt, presence, delete, edit, reaction, group, chat-modify, and profile-update methods

Pairing codes and linked-device credentials are account access material. Do not paste them into logs, issues, or commits.

## Git Hygiene

Never commit real or derived WhatsApp data.

Ignored sensitive paths include:
- `.env`
- `msgstore*`
- `*.crypt*`
- `wa.db`
- `encrypted_backup.key`
- `key`
- `*.key`
- local SQLite archives and sidecars
- generated second-brain wiki files, summaries, embeddings, and indexes
- media folders
- exports
- `.wapp-brain/`
- `.wapp-brain/memory/`
- `.second-brain/`
- `fixtures/generated/`

Repo-local private data should live under `.wapp-brain/` by default. That includes WhatsApp SQL data, decrypted working files, generated second-brain wiki pages, summaries, embeddings, retrieval indexes, provider sessions, evidence previews, and debug logs.

`npm run cleanup` removes app-managed decrypted working files and import staging files. `npm run doctor` warns when import staging files are still present after a cancelled or interrupted UI import. Do not run cleanup while an import is active, because active staging files and rollback snapshots are part of the local job.

## Local Network Exposure

The server binds to `127.0.0.1` by default. Treat any change to bind on `0.0.0.0` or a LAN address as a privacy-sensitive product decision.
