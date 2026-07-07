# Contact And Group Identity Integrity

## Why

The archive currently splits one real-world identity into several records, and the damage is user-visible on the real device: the same message appears twice in group threads (once under an unmapped `@lid` identity, once under the resolved one), senders and chats display raw internal identifiers (`244…@lid`, `1203…@g.us`), and — discovered during scoping — backup-imported and live-synced copies of the *same WhatsApp message* carry entirely different identity keys, so cross-source dedup has never worked at the row level: the next backup import would duplicate every message live sync already archived. Duplicated and misattributed rows also poison everything downstream (chat counts, recency, and especially second-brain evidence). The user has explicitly waived backwards compatibility (local-only deployment; fresh backup re-import and re-pair are acceptable), which permits fixing identity structurally rather than by merge heuristics alone.

## What Changes

- **BREAKING** (accepted): one canonical message identity across all sources — `(canonical chat JID, WhatsApp key_id)` — replacing the source-specific hashed keys (backup) and participant/fromMe-composited keys (live). The same message from backup, history sync, or live notify converges on one row; participant identity variance can no longer fork message identity. Existing archives must be re-initialized and re-imported.
- Persist LID↔phone identity mappings (`identity_links`) from every source that reveals them (history-sync `lidPnMappings`, `lid-mapping.update` events, contacts carrying both forms, and `wa.db` where present), and canonicalize every JID at ingest against them.
- When a mapping arrives late, run an **identity merge pass**: re-key and merge chats, contacts, messages, participants, checkpoints, and gap windows recorded under the LID form onto the canonical identity; memory citations referencing merged rows are marked stale through the existing staleness machinery.
- Enforce the display rule "name, else phone number, never a raw identifier": message senders fall back through saved name → push name → formatted phone; DMs likewise; groups display their subject or an explicit "Unnamed group" state — never a bare JID.
- Actively fetch missing group metadata: while connected, a bounded naming pass requests `groupMetadata` for group chats without a subject (and refreshes stale subjects), storing subject and real participant lists.
- Expose **identity health**: counts of unnamed groups and unresolved LID identities in live status, surfaced as an attention state in the UI (per the user's rule: an unnamed group is an alert, not a silent fallback).
- Make `wa.db` contact enrichment visible and retroactive: enrichment updates existing chats/messages, and the import summary reports contacts read, matched, and names improved (absorbs the folded `wa-db-contact-enrichment-not-reflected` concern).

## Capabilities

### New Capabilities

- `identity-and-naming-integrity`: canonical identity model (one person/chat/message = one record), LID↔phone mapping persistence and late-merge, human-readable display rules with phone fallback, group naming with active metadata fetch, and identity-health reporting.

### Modified Capabilities

- `live-whatsapp-maintainer`:
  - Idempotent Live Event Ingestion — message identity becomes `(canonical chat, key_id)` across sources; the backup-overlap scenario becomes structurally guaranteed instead of aspirational.
  - Gap Detection / Per-Chat Checkpoints — checkpoints and gaps follow identity merges instead of orphaning under stale JIDs.

## Impact

- Affected code: `src/server/import/parser.ts` + `importer.ts` (key unification, wa.db LID extraction, enrichment counts), `src/server/live/normalize.ts` + `baileysClient.ts` (canonical keys, mapping capture, groupMetadata fetch), `src/server/live/maintainer.ts` (naming pass, merge trigger), `src/server/db/*` (identity_links table, merge pass, display fallbacks in read paths, identity-health queries), `src/shared/types.ts`, `src/client/App.tsx` (display rules, identity-health alert), memory layer only via existing staleness hooks.
- **Migration**: none (user-approved). Old archives are incompatible; the path is re-init → fresh backup import → re-pair live sync. Startup detects an old-format archive and says exactly that.
- Absorbs backlog item `openspec/todos/contact-and-group-identity-integrity.md` (deleted on archive of this change).
