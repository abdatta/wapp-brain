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

## Secret Handling

Backup keys and decrypted databases are extremely sensitive.

The app should:
- accept keys only from explicit user input
- avoid storing keys
- prefer `--key-file` over raw `--key` in shell history
- remove decrypted databases by default
- warn when `--keep-decrypted` is used

## Logging

Default logs must not include:
- backup keys
- message bodies
- raw database rows
- contact dumps
- full private file paths when avoidable

The CLI writes debug logs under `.wapp-store/logs`. Keep those logs metadata-oriented and assume they may still be sensitive.

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
- media folders
- exports
- `.wapp-store/`
- `fixtures/generated/`

## Local Network Exposure

The server binds to `127.0.0.1` by default. Treat any change to bind on `0.0.0.0` or a LAN address as a privacy-sensitive product decision.
