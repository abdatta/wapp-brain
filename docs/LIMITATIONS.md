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

Media is archived (import backfill + live download) into a local content-addressed store and rendered in the thread view, with honest per-message availability when bytes are absent. Remaining limits:

- No transcoding or thumbnail generation: the app stores originals and reuses WhatsApp's embedded thumbnails; media without one falls back to a labeled row/kind marker.
- Live media archived before descriptor capture existed cannot be re-fetched by key; it is recoverable only through the import folder and reports `not_captured`/`import_missing` honestly.
- **View-once media is not delivered to linked devices by current WhatsApp, and there is no companion-side way to fetch it** (verified 2026-07-08 against a real delivery, and confirmed against the developer community). Until late 2024 a Baileys-linked client *could* download view-once, or flip the `viewOnce` flag to save it as normal media — the well-known [Zengo / Tal Be'ery disclosure](https://medium.com/@TalBeerySec/once-and-forever-whatsapps-view-once-functionality-is-broken-302a508390b0) (reported to Meta Aug 2024). WhatsApp closed it in Sept–Nov 2024 by **no longer sending view-once content to companion/linked devices** — the primary phone receives it, linked devices get an envelope explicitly marked unavailable with no ciphertext. The current Baileys community confirms this ([issue #2105](https://github.com/WhiskeySockets/Baileys/issues/2105): view-once arrives as a stub with no media, closed with no workaround), and whatsmeow deliberately excludes view-once from its missed-message resend. So there is nothing local to decrypt and no accepted re-request path. The archive records such messages honestly as "View once media" with the withheld reason. The legitimate path forward is WhatsApp's own official feature to open view-once on linked devices, [in beta since Feb 2025](https://www.androidauthority.com/whatsapp-view-once-media-linked-devices-3522527/); if/when it reaches your account, the live capture pipeline archives view-once automatically with no bypass. Until then, capture is only possible on the phone itself (screenshot / screen-record).
- View-once media missed while the server was offline is permanently gone and reported as such.
- Media re-upload recovery is bounded per message; exhausted items are marked expired/unrecoverable rather than retried forever.
- Retention is unbounded by design: there is no storage cap or eviction policy.
- Media serving stays on loopback-only endpoints; nothing is exposed through public static routes.

## Scale

The importer batches message writes and the UI paginates chats/messages. Very large archives still depend on local disk speed, SQLite write throughput, and the shape of the source schema.

## Idempotency

Exact re-runs of the same archive should not duplicate data. Cross-backup dedupe can still be imperfect if WhatsApp changes row identity and key IDs are unavailable.

## Rich Message Details

- Complete detail reflects only fields present in the backup or linked-device event; it never geocodes locations, fetches map/link data, or invents an edit/delete time, group actor, original text, vCard phone number, or transcript.
- A metadata-only edit is shown as such with an explicit original-text-unknown entry. A deletion can preserve previously captured content but cannot recover content that was never archived.
- Unknown or unverified system action shapes remain generic. `You` appears only when the exact relevant role is the owner; missing actor/participant identity is shown as unresolved rather than guessed.
- A vCard download is unavailable when neither source bytes nor a display name plus phone-form JID are retained. LID-only cards intentionally cannot be converted to phone cards.

## Future Services

The app uses SQLite to avoid a required database service. A later Postgres/Supabase backend should implement the same archive repository interface. Do not use a remote service by default unless the user explicitly opts into uploading private archive data.
## Reply Quote Coverage

Quoted snapshots are best-effort outside modern Android and supported Baileys envelopes. Legacy/iOS schemas or replies without a snapshot retain pointer-only same-chat lookup and then an honest generic fallback. Cross-chat Reply Privately snapshots remain readable locally but intentionally do not offer cross-chat navigation.
