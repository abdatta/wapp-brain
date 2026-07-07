# Wapp Brain

Local-first WhatsApp archive importer, live-store foundation, and second-brain workspace for Android backup files.

For future-agent/project context, see the wiki in [docs/README.md](docs/README.md).

The app keeps the flow deliberately small:

1. Validate local input files.
2. Decrypt `msgstore.db.crypt15` when a matching key is supplied, or use a plaintext `msgstore.db` fixture/database.
3. Inspect WhatsApp-like SQLite schemas defensively.
4. Import contacts, chats, inferred participants, and messages into a local SQLite archive file.
5. Browse the archive in a local web UI.

No WhatsApp Web scraping, cloud sync, account login, analytics, or external upload is used.

## Privacy Warnings

WhatsApp databases, decrypted databases, media, archive files, generated second-brain wiki files, embeddings/indexes, and backup keys are highly sensitive.

- Do not commit real `msgstore*`, `*.crypt*`, `wa.db`, decrypted `.db` files, archive `.sqlite` files, SQLite sidecars, keys, media, exports, logs, or `.env` files.
- Do not commit generated second-brain/wiki files derived from WhatsApp data.
- The app does not store backup keys in the archive.
- The importer does not log message bodies or key material.
- Decrypted databases are written only to the local work directory and are removed after import unless `--keep-decrypted` is used.
- The local archive file and generated brain files contain private WhatsApp-derived data; protect `.wapp-brain`, OS backups, and any manual exports.

## Requirements

- Node.js 22+
- Your own Android WhatsApp files:
  - `msgstore.db.crypt15`
  - `wa.db` or `wa.db.crypt15` if you want contact names
  - `encrypted_backup.key` or the matching 64-character crypt15 backup key
  - optionally your local `WhatsApp/Media` folder for import context

Create `.env` from `.env.example` if you want to customize ports or the archive path:

```powershell
Copy-Item .env.example .env
```

By default, imports write to:

```text
.wapp-brain/archive.sqlite
```

Use `.wapp-brain/` as the repo-local private workspace for WhatsApp SQL data, decrypted working files, future generated second-brain wiki pages, summaries, embeddings, and retrieval indexes. This directory is gitignored and should stay private.

## Install

```powershell
npm install
```

## Initialize The Local Archive

```powershell
npm run init-db
```

This creates the app-managed SQLite archive file and tables.

Check local readiness:

```powershell
npm run doctor
```

The doctor command reports localhost binding, sensitive-file ignore coverage, whether the app server is listening, and whether the local archive file is initialized. It does not print backup keys, message bodies, raw rows, or private source dumps.

## Import Real Files

The import CLI shows animated step status and progress bars where the importer can estimate work, including crypt15 verification/decryption and message batches. Every import also writes a unique verbose debug log under `.wapp-brain/logs`.

With a 64-character key:

```powershell
npm run import -- --msgstore "C:\path\msgstore.db.crypt15" --wa "C:\path\wa.db.crypt15" --key "<64-character-key>"
```

With a key file:

```powershell
npm run import -- --msgstore "C:\path\msgstore.db.crypt15" --wa "C:\path\wa.db" --key-file "C:\path\encrypted_backup.key"
```

Prefer `--key-file` over `--key` when possible so the raw key is not stored in your terminal command log.

Optional media directory and archive destination:

```powershell
npm run import -- --msgstore "C:\path\msgstore.db.crypt15" --wa "C:\path\wa.db" --media "C:\path\WhatsApp\Media" --archive ".wapp-brain\archive.sqlite" --key-file "C:\path\encrypted_backup.key"
```

For a plaintext synthetic or already-decrypted `msgstore.db`, omit the key.

Preflight a local archive without importing:

```powershell
npm run inspect -- --msgstore "C:\path\msgstore.db.crypt15" --wa "C:\path\wa.db" --key-file "C:\path\encrypted_backup.key"
```

Inspect validates/decrypts if needed, opens SQLite, reports schema compatibility and counts, and prints redacted warnings only. It does not print message bodies or raw rows.

Use `--keep-decrypted` only if you intentionally want the decrypted msgstore left under `.wapp-brain/decrypted`.

Clean app-managed decrypted working files:

```powershell
npm run cleanup
```

The local UI also has **Clean Temp Files** in the status panel. Cleanup only removes the app-managed decrypted working directory and reports counts, not file names.

## Run The Local UI

Development mode:

```powershell
npm run dev
```

Open [http://127.0.0.1:5900](http://127.0.0.1:5900).

Production-style local server:

```powershell
npm run build
npm run server
```

Open [http://127.0.0.1:3600](http://127.0.0.1:3600).

The server binds to `127.0.0.1` by default.

For large chats, the viewer loads the newest message window first and displays that loaded window in chronological order. Use **Load older messages** to page back through the conversation without sending the whole chat to the browser at once.

## Live Sync

After a backup import, link WhatsApp as a companion device from the app UI (Live Sync panel). From then on the archive keeps itself current:

- When the server starts and linked-device credentials exist, live sync resumes automatically (`LIVE_AUTO_RESUME=false` disables this).
- Startup and reconnects audit downtime against platform-reported chat activity; only chats with real evidence of missing messages get recovery gaps, and bounded backfill runs on its own schedule until gaps close or are honestly marked uncertain.
- Long downtime never blocks resume. Only first-time linking requires a recent backup baseline.
- Live edits, deletes, and reactions are applied to the original archived messages; deletes show as WhatsApp-style tombstones.
- If WhatsApp unlinks the device, the app stops reconnecting and shows a Re-pair WhatsApp action instead.

## Second-Brain Memory

Memory generation is local-first. The default REM command writes Obsidian-compatible Markdown pages and citation sidecars under `.wapp-brain/memory/`:

```powershell
npm run memory:rem -- --dry-run
npm run memory:rem
npm run memory:query -- --query "topic"
npm run memory:validate
```

Codex-backed generation is explicit opt-in:

```powershell
tsx src/server/cli.ts memory-provider enable-codex
tsx src/server/cli.ts memory-provider login
```

Do not sync or commit `.wapp-brain/memory/` unless you intentionally want to export private WhatsApp-derived memory.

## Synthetic Test Data

Real WhatsApp files are not committed. Generate local synthetic fixtures:

```powershell
npm run generate-fixtures -- --dir fixtures/generated/basic
npm run import -- --msgstore "fixtures/generated/basic/msgstore.db" --wa "fixtures/generated/basic/wa.db"
```

Generate larger local fixtures when testing pagination and import behavior:

```powershell
npm run generate-fixtures -- --dir fixtures/generated/large --large
npm run generate-fixtures -- --dir fixtures/generated/many-chats --many-chats 1005
```

Run tests:

```powershell
npm test
```

The tests cover synthetic legacy-style messages, modern-ish schemas, group sender attribution, unknown message types, large message paging, 1000+ chat pagination, file-backed SQLite persistence, re-run idempotency, privacy-safe import summaries, malformed row skips, and fake crypt15 decryption.

Malformed message rows that cannot be tied to a supported chat are skipped with redacted warnings and counted in the import summary. The warning records include safe source table/row context, not message bodies.

## What Imports Today

Where available, the importer preserves:

- chats and inferred chat type
- contacts from `wa.db`
- inferred group participants from message senders
- message source identity
- timestamps as WhatsApp millisecond Unix values plus UTC datetimes
- direction/from-me
- message body/caption
- message type and media placeholders
- quoted row references where present
- redacted source metadata such as adapter, source table, source row id, status, and source columns

## Storage And Future Postgres

The app uses SQLite because it is local, file-backed, and does not require installing or running a database service.

The importer and UI talk to a small archive repository interface. The SQLite adapter is `SqliteArchiveRepository`; a future Postgres/Supabase backend should implement that same interface and reuse the normalized archive tables rather than changing the parser or UI API.

Do not point the app at a remote Postgres/Supabase database unless you intentionally want to upload private WhatsApp messages.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the adapter boundary and Postgres migration notes.

## Decryption Notes

Encrypted backup support is intentionally crypt15-only. `crypt15` support for `msgstore.db.crypt15` and `wa.db.crypt15` requires a user-supplied 64-character key or `encrypted_backup.key`. A WhatsApp backup password alone is not enough for local decryption.

The local decryptor follows the commonly documented crypt15 envelope used by open-source tools such as [wa-crypt-tools](https://github.com/ElDavoo/wa-crypt-tools): protobuf header, AES-256-GCM, authentication tag, checksum, and zlib decompression. Unsupported or changed envelopes fail before import.

See [docs/LIMITATIONS.md](./docs/LIMITATIONS.md) for the honest edges.
