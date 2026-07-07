# Design: Contact And Group Identity Integrity

## Context

Identity is currently forked along three axes, all observed on the real archive:

1. **Source axis**: backup rows are keyed `stableMessageKey(["modern", chatJid, senderJid, fromMe, keyId])` with `sourceMessageId = "modern:<chat>:<keyId>"` ([parser.ts:551-554](../../../src/server/import/parser.ts)), while live rows use `wa-web|chat|participant|fromMe|id` with raw `keyId`. The same WhatsApp message never matches across sources; the maintainer spec's backup-overlap idempotency scenario is aspirational, not real. A fresh backup import today would duplicate the entire live-synced window.
2. **Sender-form axis**: LID vs phone participant forms fork the live composite key — the confirmed duplicate rows in the user's group threads.
3. **Naming axis**: read paths surface raw JIDs (`sender_display_name = COALESCE(c.display_name, m.sender_source_jid)`), groups without a synced subject display their group id forever, and nothing ever actively fetches missing group metadata.

Constraints: local-first and read-only live posture stay. **Backwards compatibility is explicitly waived by the user** — fresh `init-db` + backup re-import + re-pair is the accepted upgrade path; no schema or data migrations are needed.

## Goals / Non-Goals

**Goals:**
- One archive row per real message, chat, contact — regardless of source or sender form, including late-learned mappings.
- Every displayed identity is a name, a push name, or a phone number; unresolved identities and unnamed groups are explicit, counted, alerted states.
- Enrichment from `wa.db` is retroactive and visible.

**Non-Goals:**
- Decrypting message-secret payloads or mapping Android type codes (separate backlog item).
- Media, receipts UI, thread-level noise filtering.
- Any migration of existing archive files.

## Decisions

### D1: Message identity = `wa|<canonical chat JID>|<key_id>`

`source_message_key` becomes `wa|<chat>|<id>` (delimiter-escaped, no participant/fromMe segments); `source_message_id` is the raw WhatsApp `key_id` in **both** importer and live normalizer. Sender identity lives only in columns, so sender-form variance structurally cannot fork message identity, and backup/live copies of one message collide onto one row by construction. Backup rows lacking `key_id` (legacy edge) get the surrogate id `row:<adapter>:<rowid>`, idempotent per backup but not cross-source (acceptable: those rows predate live sync entirely).

*Collision note:* WhatsApp treats `(chat, id)` as sufficient identity in practice (revoke lookups); cross-sender id collision within one chat is cryptographically negligible and accepted.

*Alternative considered:* keeping composite keys + merge heuristics — rejected; with compat waived, removing the fork at the root is strictly simpler and provably complete.

### D2: Persisted `identity_links` + canonicalization at ingest

New table `identity_links (lid TEXT PRIMARY KEY, pn TEXT NOT NULL, source TEXT, learned_at TEXT)`. Fed from: history-sync `lidPnMappings`, `lid-mapping.update`, contact records carrying both forms, and `wa.db` during import if it exposes LID data (investigated at implementation; optional source). JID canonicalization order everywhere: Baileys runtime resolver → persisted `identity_links` → raw form. The repository owns a `resolveIdentity(jid)` used by both importer and live paths so the two sources cannot diverge.

### D3: Late merge pass, idempotent and repository-owned

`mergeIdentity(lid, pn)` runs in one transaction when a link is first learned, plus a sweep on each recovery tick for any archived `@lid` chats/senders that now have links (covers links learned while the archive was closed):
- Chats: move messages to the canonical chat (`chat_id` update), re-keying `source_message_key` to the canonical chat; on `(chat, id)` conflict keep the richer row (non-null body/caption/media preferred, else newest) and delete the other; merge chat fields by COALESCE; delete the LID husk.
- Contacts: COALESCE-merge fields into the canonical contact, delete the husk; message `sender_source_jid` values rewritten.
- Participants, checkpoints, gap windows: re-key to canonical, preferring the canonical row's audit state and absorbing missing fields.
- Memory: merged/deleted message ids flow through `markStaleMemoryForMissingMessages` — citations degrade to stale, never dangle.

Idempotence: every step is a keyed upsert/delete; re-running with the same link is a no-op.

### D4: Display fallbacks in the read paths, unresolved as a state

Read SQL joins contacts **by JID** (`LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid`) instead of the stale `sender_contact_id` FK, making enrichment retroactive with no backfill pass. Display resolution: `display_name → push_name → phone digits (server-provided) → NULL`. List/message DTOs gain `displayIsResolved`-style flags; the client renders NULL as "Unresolved contact" / "Unnamed group" — the raw JID appears only in tooltips/metadata, never as the label. Phone formatting (`+91 …`) happens client-side from digits.

### D5: Bounded group-naming pass

`LiveWhatsAppClient` gains `fetchGroupMetadata?(jid)` (Baileys `groupMetadata` — a read query, not in the read-only blocklist). The recovery tick runs a naming pass while connected: up to N (default 3) unnamed group chats per tick, per-chat retry backoff, storing subject + participant list (`membership_source: "source"`). Groups that still fail stay in the unnamed-group health count.

### D6: Identity health in live status

`getLiveStatus()` gains `identityHealth: { unnamedGroups, unresolvedLids, samples[] }` computed by query (no new state): unnamed groups = group chats with empty/JID-equal display names; unresolved LIDs = distinct `@lid` chat/sender JIDs without an identity link. UI: attention state in the Live panel and guided setup when non-zero, listing sample chats — per the user's rule, an unnamed group is an alert.

### D7: Legacy archive detection instead of migration

A `schema_meta` table records `identity_version`. Archives without the current version are refused at open with the exact remedy ("re-run init-db, re-import your backup, re-pair live sync"). `init-db` recreates from scratch. No migration code is written or maintained.

### D8: Importer emits canonical records

The parser canonicalizes chat/sender JIDs through the same `resolveIdentity`, emits D1 keys, extracts LID links from `wa.db` when available, and the import summary adds `contactsRead / contactsMatched / namesImproved` so enrichment is observable (Visible Contact Enrichment requirement).

### D9: Group sender attribution from all participant carriers (added during real-device verification)

Real-device history sync surfaced a mislabeling class: real-time deliveries carry the group sender in `key.participant`, but history-synced messages often carry it only in `WebMessageInfo.participant` (top level). The normalizer read only the key and fell back to the chat JID for group messages, attributing 18 days of history-synced group messages to the group itself — which then displayed the group's contact name as the sender. Decisions: (1) sender resolution reads `key.participant ?? message.participant`, and for group chats never falls back to the chat JID (no participant ⇒ sender unknown/unresolved); (2) message-derived contact records are never created for a sender equal to the chat itself; (3) the read paths treat a group message whose stored sender equals the chat JID as unresolved, which also covers rows written before this fix without a data migration (per the no-compat stance, a future fresh import fully heals them since backups carry correct senders).

## Risks / Trade-offs

- [`(chat, id)` surrogate for legacy rows breaks cross-source dedup for pre-key_id backups] → those rows predate live sync; re-importing the same backup stays idempotent, which is the property that matters.
- [Late merges rewrite many rows in one transaction on big chats] → SQLite transaction handles it; merges are per-identity (bounded), and the sweep processes a few identities per tick.
- [groupMetadata fetches could rate-limit] → bounded per tick with backoff, same discipline as history backfill.
- [Citations referencing merged rows] → routed through the existing stale-citation machinery; memory validation already surfaces stale counts.
- [User must re-import + re-pair once] → explicitly accepted; startup message makes the path unambiguous.

## Open Questions

- Does `wa.db` in current Android builds expose LID↔phone data usable as a link source? (Checked during implementation; optional source either way.)
- Should unresolved-LID DMs be hidden from the default chat list until resolved, or shown with the "Unresolved contact" label? (Proposed: shown with label; hiding risks "missing chats" confusion.)
