# Importing And Data Model

## Supported Inputs Today

Historical import accepts:
- `msgstore.db` for plaintext fixtures or already-decrypted databases.
- `msgstore.db.crypt15` with a matching 64-character key or `encrypted_backup.key`.
- Optional `wa.db` for contact/name enrichment.
- Optional media directory path for context only.

## What The Importer Preserves

Where available, the importer stores:
- contacts from `wa.db`
- chats and inferred chat type
- inferred group participants from message senders
- source message identity
- timestamps as WhatsApp Unix milliseconds and UTC datetimes
- direction/from-me
- message body or caption
- message type and raw type code
- media-like metadata such as MIME type/name
- quoted row references
- deleted/forwarded/starred flags
- raw/source metadata useful for future parser improvements

## Schema Strategy

WhatsApp Android schemas are unofficial and change over time. The parser should:
- inspect tables/columns before reading them
- support known legacy and modern-ish shapes
- skip malformed rows with privacy-safe warnings
- preserve source metadata instead of throwing unknown details away
- fail clearly when no supported message schema is present

Currently supported schema families:
- legacy `messages` with `key_remote_jid`, `key_from_me`, `key_id`, `data`, `timestamp`, and media columns
- modern-ish `message`, `chat`, `jid`, and `message_text` mappings

## Idempotency

Exact re-runs should not duplicate data.

Messages are upserted by stable source-derived keys. Cross-backup dedupe can still be imperfect if WhatsApp changes row identity and key IDs are unavailable.

## Media Status

Media is not imported as files yet.

The app preserves message/media type metadata and displays placeholders. Future media work should copy or index media locally without exposing a public static directory by accident.
