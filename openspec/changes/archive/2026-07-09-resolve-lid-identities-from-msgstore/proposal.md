# Proposal: Resolve LID Identities From msgstore.db

## Why

577 DM chats and 189 group senders in the real archive display as "Unresolved contact": they are keyed by unmapped `@lid` JIDs with no name, no push name, and no derivable phone number. Live sync can never heal them — the phone only publishes app-state contact records for currently-registered WhatsApp users, and these people left WhatsApp (a full re-pair on 2026-07-07 delivered only 312 links). The backup, however, already contains everything needed: `msgstore.db`'s `jid_map` table (3,966 LID↔phone pairs) and `lid_display_name` table (2,646 text display names — the phone's own label cache, the exact names the user sees on their phone). Measured against the real archive, these two tables cover **100%** of the unresolved chats (441 gain phone numbers, 370 gain names, 234 both) and all 189 unresolved LID group senders. The importer reads neither table today, and the only existing backup-side link source (`wa.db` LID columns) yields nothing because the backup's `wa.db` is empty (0 `wa_contacts` rows).

## What Changes

- The backup parser reads `msgstore.db`'s `jid_map` table and emits LID→phone identity links from it (alongside the existing `wa.db` source, which remains but is empty on real backups).
- The backup parser reads `msgstore.db`'s `lid_display_name` table and emits contact display names for LID identities, with lower precedence than `wa.db` address-book names.
- Identity links recorded by the importer carry their true per-link source (`msgstore.jid_map`, `wa.db`) instead of the current hardcoded `"wa.db"` label.
- The importer merges still-split LID identities for links it just learned (with progress reporting), instead of leaving the entire heal to the live maintainer's 3-per-tick background sweep — a re-import completes the heal in one pass.
- The import summary's contact-enrichment report includes the new sources: links learned from `jid_map` and names read from `lid_display_name`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `identity-and-naming-integrity`:
  - **Identity Mapping Persistence** — the message-store database's LID↔phone mapping table (`jid_map`) becomes a required link source; mappings from it are persisted at import time.
  - **Late Identity Merge** — merges for links learned during an import are executed by the import itself (visible in progress), not deferred to the background sweep; the sweep remains as backstop.
  - **Visible Contact Enrichment** — enrichment extends beyond `wa.db` to message-store identity tables (`lid_display_name` names, `jid_map` links), and the import summary reports per-source counts so the user can tell where names came from (including when `wa.db` is empty).

## Impact

- **Code**: `src/server/import/parser.ts` (two new readers, contact-map ordering for name precedence), `src/server/import/importer.ts` (per-link source labels, post-link merge pass, enrichment summary), no schema changes (`identity_links`, `contacts`, merge machinery from the 2026-07-07 identity-integrity change are reused as-is).
- **Data**: a re-import of the existing backup heals the archive in place — canonicalization at ingest plus the importer merge pass collapse LID-keyed chats/contacts onto their phone identities; no re-init or re-pair required.
- **Tests**: importer/parser tests gain synthetic `msgstore.db` fixtures with `jid_map` and `lid_display_name` tables.
- **Non-goals**: the `lid_display_name.username` column (contacts have no username field), decrypt/import flow changes, live-sync changes.
