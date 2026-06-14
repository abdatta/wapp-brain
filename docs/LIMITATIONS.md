# Limitations

WhatsApp Android database formats are unofficial and change over time. This app is a local archive tool, not a forensic suite.

## Decryption

- Only user-supplied files and keys are supported.
- No password recovery, key extraction, protection bypass, WhatsApp Web scraping, or cloud restore is attempted.
- `crypt15` support is best-effort for known local-backup envelopes.
- Wrong keys, unsupported headers, authentication mismatch, truncated files, or non-SQLite output fail closed.
- Decrypted files are temporary by default. If `--keep-decrypted` is used, cleanup is the user's responsibility.

## Schema Coverage

Known partial areas:
- LID/JID migration mappings may be incomplete.
- Reactions, edits, receipts, calls, disappearing message state, labels, payments, polls, and Business-specific fields are not fully parsed.
- Group membership is inferred from message senders unless source participant tables are added later.
- `wa.db` can be stale, missing, or inaccessible without root.
- Unknown message types are imported as placeholders with raw type codes.

## Media

Media files are not imported into a gallery.

The importer preserves media-like message type, MIME/name fields where present, and a placeholder in the UI. It does not copy media folders, generate thumbnails, or expose media through public static routes.

## Scale

The importer batches message writes and the UI paginates chats/messages. Very large archives still depend on local disk speed, SQLite write throughput, and the shape of the source schema.

## Idempotency

Exact re-runs of the same archive should not duplicate data. Cross-backup dedupe can still be imperfect if WhatsApp changes row identity and key IDs are unavailable.

## Future Services

The app uses SQLite to avoid a required database service. A later Postgres/Supabase backend should implement the same archive repository interface. Do not use a remote service by default unless the user explicitly opts into uploading private archive data.
