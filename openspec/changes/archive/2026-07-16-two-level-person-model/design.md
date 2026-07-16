# Two-Level Person Model — Design

## Context

The archive has exactly one identity layer today: `contacts` holds one row per canonical JID, `identity_links` maps LID→PN, and `mergeIdentity` (`src/server/db/sqliteRepository.ts:3160`) collapses LID/PN forms of the *same WhatsApp identity* at the archive layer. There is no person concept: no `persons`, no membership table, no merge machinery above `mergeIdentity`, and no person-keyed surface anywhere (the `rollup`/`overview`/`project_pages` brain-task kinds are declared but have no executor). The original D6 plan — hard-merged person nodes with redirect stubs — was never built, so nothing needs unwinding.

The dependency has landed: `episode-contract-v2` (archived 2026-07-13) anchors `brain_claim_entities` on nullable canonical `jid` (`sqliteRepository.ts:1298`), meaning claims already cite identities, not persons. That is the property this whole design leans on: because nothing durable ever references a person, person edits can be metadata-only forever.

Deterministic signal inputs are also already captured with provenance:
- `identity_number_changes` (457 rows, all JID-resolvable, backup+live via `upsertArchiveSignals`, `sqliteRepository.ts:4480`) — "X changed their phone number" system messages. No consumer exists.
- `group_membership_periods` / `group_membership_events` — the membership timeline the succession detector needs.
- `message_vcards.resolved_jid` — shared-contact cards resolved to JIDs.

The confirmed gap: `buildCandidates` (`src/server/googleContacts.ts:172`) flattens Google people to per-phone `(phone, name)` pairs. `resourceName` is never read, so "these two numbers are one Google contact" — the strongest human-level grouping signal we have — is discarded at the door. Persistence (`enrichContactsFromGoogle`, `sqliteRepository.ts:3939`) stores display names only.

Constraints from the codebase and standing decisions:
- Schema is applied idempotently by `ensureSchema` (`CREATE TABLE IF NOT EXISTS` in `schemaStatements`; additive columns via `migrateAdditiveColumns`). No versioned migrations.
- Every repository method lands in the `ArchiveRepository` interface and both implementations (`SqliteArchiveRepository`, `MemoryArchiveRepository`).
- Meaning lives server-side for MCP/agent/search consumers (downstream-consumer principle); ops ≥1s report progress and never block the event loop.
- No backward-compatibility constraints.

## Goals / Non-Goals

**Goals:**
- Identity nodes: one per canonical JID, immutable at the person layer — never merged, never deleted by any person operation. LID↔PN collapse stays in `mergeIdentity`.
- Persons as an editable grouping: `person_members` with provenance; connect = insert row, disconnect = delete row; **zero episode/claim/citation writes in either direction**.
- Deterministic auto-connect from two certainty-grade sources: numbers sharing one Google contact, and number-change system messages — running continuously, not just at import.
- Google sync extension that captures and persists the same-contact grouping it currently discards.
- Suggestion producers (same name, shared groups, co-citation, succession, shared vCard) that rank and attach evidence but never apply; persisted rejections so a dismissed pair is never re-suggested.
- Pack-local extraction-time resolution stays the law; render-time disambiguation makes colliding person names visually distinct everywhere.
- Repository/API contract that future person-keyed surfaces (rollups, salience, people UI) aggregate through.

**Non-Goals:**
- No person-level rollup/salience/page *generation* — `semantic-rollups` and `knowledge-graph-foundation` build on the contract this change ships.
- No full people-management UI — `people-management-ui` owns that; this change ships the API plus a minimal management surface sufficient for the checkpoint.
- No LLM merge-adjudication executor. The `merge_adjudicate` task kind stays declared-but-reserved (exactly as today); the demoted LLM suggestion producer is future work behind the same suggestion table.
- No archive-chat merging: a person with two numbers still has two DM chats. Person aggregation is a brain/read-layer concept; the archive stays source-shaped.

## Decisions

### D1. The identity node is the canonical JID — no new identity table

`contacts` is already one row per canonical `source_jid`, `brain_claim_entities` already anchors on `jid`, and every signal table keys on JIDs that `mergeIdentity` rewrites in one place. Introducing a `brain_identities` table would duplicate that keyspace and create a synchronization obligation with zero consumers. Person-layer tables therefore reference identities by canonical JID text (`identity_jid`), and `mergeIdentity` is extended to rewrite them like every other JID-bearing table (D8).

*Alternative considered:* a surrogate `brain_identities(id)` table — rejected: contract v2 deliberately anchored claims on JIDs; a second key for the same concept invites drift and buys nothing until some property of an identity exists that `contacts` can't hold.

### D2. Persons materialize only when a judgment exists (≥2 members)

A person row is created by the first connect and dissolved when membership falls below two. A lone identity *is* its own person implicitly: read surfaces resolve `personKey(jid) = person_id if member else jid`. This keeps the persons table exactly as large as the number of human-level judgments made, avoids materializing thousands of singleton rows, and makes "disconnect fully reverses connect" literally true — the state after disconnect is byte-identical to the state before connect (plus audit and suppression rows, which are the point).

Dissolved or union-merged person ids that may be externally held (MCP, API consumers) get a row in `person_redirects(person_id → replacement_person_id | surviving_jid)` — the only surviving trace of the D6 redirect-stub idea, and only for externally-held person ids as the proposal requires.

*Alternative considered:* person-per-contact materialization — rejected: ~every contact gains a row carrying no information, dissolution semantics get murkier (what does deleting the last member of an implicit person mean?), and bulk creation would race with imports.

### D3. Schema

All new tables are `CREATE TABLE IF NOT EXISTS` additions to `schemaStatements`; no existing table changes shape.

```sql
persons(
  id TEXT PRIMARY KEY,              -- ulid-style, generated server-side
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)                                   -- deliberately no name column: nothing groups by name (D7)

person_members(
  person_id   TEXT NOT NULL REFERENCES persons(id),
  identity_jid TEXT NOT NULL UNIQUE, -- an identity belongs to at most one person
  source      TEXT NOT NULL CHECK (source IN ('google','number_change','user')),
  evidence_json TEXT,               -- e.g. {resourceName}, {eventKey}, {suggestionId}
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (person_id, identity_jid)
)

person_link_suppressions(
  jid_low  TEXT NOT NULL,           -- pair normalized by lexicographic order
  jid_high TEXT NOT NULL,
  reason   TEXT NOT NULL CHECK (reason IN ('suggestion_rejected','disconnected')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (jid_low, jid_high)
)

person_suggestions(
  id TEXT PRIMARY KEY,
  jid_low TEXT NOT NULL, jid_high TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('same_name','shared_group','co_citation','succession','shared_vcard','llm')),
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL,      -- human-inspectable: names, group ids, counts, windows
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (jid_low, jid_high, kind)
)

person_link_events(                 -- append-only audit trail
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (action IN
    ('connect','disconnect','union','dissolve','suggest','accept','reject')),
  person_id TEXT, identity_jid TEXT, source TEXT, evidence_json TEXT,
  created_at INTEGER NOT NULL
)

google_contact_groups(              -- persisted same-contact grouping from sync (D5)
  resource_name TEXT NOT NULL,
  phone_e164   TEXT NOT NULL,
  display_name TEXT,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (resource_name, phone_e164)
)

person_redirects(
  person_id TEXT PRIMARY KEY,
  replaced_by_person_id TEXT,       -- set on union
  surviving_jid TEXT,               -- set on dissolve to a singleton
  created_at INTEGER NOT NULL
)
```

On `person_members.source`: the proposal sketched `{google, user, model_suggested}`. Two refinements, recorded here deliberately: `number_change` is its own value (it is a distinct certainty-grade source with distinct evidence, and provenance must be precise), and `model_suggested` is not a membership source — suggestions never apply themselves, so the membership a human creates from an accepted suggestion lands as `user` with the suggestion id in `evidence_json`. The suggestion's own provenance lives in `person_suggestions.kind`.

### D4. Connect/disconnect semantics live in two repository methods

`connectIdentities(jidA, jidB, source, evidence)` — one transaction, case analysis:
- Neither in a person → create person, insert both memberships.
- One in a person → insert the other membership.
- Both in the same person → no-op (idempotent).
- Both in *different* persons → **union**: move the smaller person's memberships to the survivor, write a `person_redirects` row for the dissolved id, audit `union`. Certainty-grade and user sources both union — if two judgments turn out to share an identity, they were always one person.
- A `user`-source connect deletes any suppression row for the pair (an explicit human action outranks past dismissals); auto sources are *blocked* by suppression rows instead (D6).

`disconnectIdentities(jid)` — one transaction: delete the membership row; write `disconnected` suppression rows for (removed × each remaining member) so no auto source silently reconnects what a human just severed; if one member remains, dissolve the person (delete both rows, `person_redirects` → `surviving_jid`), audit `disconnect`/`dissolve`.

Both methods touch only the tables above and then invalidate/re-derive person-keyed read caches (today: the brain-status cache; the contract is "re-derive cheap aggregations, never episodes"). Every path writes `person_link_events`.

### D5. Google sync captures the grouping it currently discards

`buildCandidates` gains grouping output: for each Google person, read `resourceName` and emit `(resourceName, phone_e164, displayName)` for every *normalizable* number — **independent of name-ambiguity handling**. Name enrichment keeps its existing conservative rules untouched (ambiguous names still skip); grouping capture doesn't assign names, so a number whose name is contested still truthfully belongs to its contact's grouping. Unnormalizable numbers stay out (we can't match them to archive identities anyway).

`sync()` persists groupings by full replace-or-upsert into `google_contact_groups` (a re-sync reflects Google's current state; `last_seen_at` stamps the sync). Sync **never disconnects**: a number vanishing from a Google contact stops *asserting* the grouping but does not undo a connection made from it — people restructure Google contacts for reasons that aren't identity judgments, and disconnect is a human action (or a one-click away).

After persistence, the sync triggers the auto-connect pass (D6). Raw provider responses are still never stored; `google_contact_groups` holds exactly resource name, normalized number, display name — no new fields are requested from the API (`resourceName` is already on every person payload).

### D6. Auto-connect is a deterministic, continuously-running pass

One idempotent pass, `runPersonAutoConnectPass`, over two certainty-grade sources:

1. **Same Google contact**: every `resource_name` in `google_contact_groups` whose numbers match ≥2 distinct archived canonical JIDs (matching by `phone_e164` against `contacts.phone_number` / phone-form JID, same matching as enrichment) → `connectIdentities(source='google', evidence={resourceName})` pairwise against the group's anchor member.
2. **Number-change events**: every `identity_number_changes` row → `connectIdentities(old_jid, new_jid, source='number_change', evidence={eventKey})`. These are person-level connects, *not* `mergeIdentity` — old and new numbers are different WhatsApp identities belonging to one human. The existing 457 rows are consumed by the first pass ever run (the pass is a full scan over a small indexed table, so "backfill" and "steady state" are the same code path).

Suppression check: an auto source never connects a pair with a `person_link_suppressions` row. Idempotency: `connectIdentities` no-ops on same-person pairs, so re-running the pass after nothing changed writes nothing.

Trigger points: end of Google sync (D5), end of backup import, live `identity_number_changes` writes (via the recovery tick), and a slot in `LiveMaintainer.recoveryTick` alongside `sweepUnmergedIdentities` (`live/maintainer.ts:203`) — cheap, bounded, before the brain pass. Also exposed via CLI for manual runs.

*Alternative considered:* routing auto-connect through `brain_tasks` — rejected: no model spend, no retry semantics needed, fully recomputable from state; the queue adds ceremony (and the scheduler correctly fails loudly on unknown kinds today). The recovery-tick pass pattern is the established home for deterministic maintenance.

### D7. Nothing groups by name — suggestions produce, humans apply

Suggestion detectors are deterministic bounded passes (same scheduling home as D6, lower cadence) writing ranked rows with inspectable evidence into `person_suggestions`:

- `same_name`: identities whose resolved display labels are equal (`GROUP BY` over resolved labels; cheap). Score by label specificity (a full saved name beats a push name).
- `co_citation`: identities co-occurring in `brain_claim_entities` across many episodes.
- `succession`: number A's activity ends where number B's begins in the same chats — sharpened by `group_membership_periods` (A leaves / B joins within a window) and per-chat last-message/first-message timestamps. Highest-value, most expensive; bounded per pass with a persisted cursor.
- `shared_vcard`: `message_vcards.resolved_jid` shared across chats — a weak corroborator, low base score.

*Amended at the user checkpoint (2026-07-16):* `shared_group` was originally a standalone low-score producer; the real-archive round showed its standalone pairs are mostly false positives — two identities simultaneously active in one group are usually *different* people. Group co-presence is demoted to corroborating evidence inside the succession detector (shared chats + membership handoff), never a standalone suggestion; the `shared_group` kind stays in the schema for history, and lingering pending rows are superseded by the detector pass.

Rules that hold everywhere: detectors skip pairs that are already co-members, suppressed, or have a `rejected` suggestion row of the same kind (rejection memory — the `UNIQUE(jid_low, jid_high, kind)` row just stays `rejected`; the detector's upsert never resurrects it). No detector — and nothing else in the system — ever *groups* by name: `same_name` produces a suggestion like everything else. The `merge_adjudicate` brain-task kind remains declared and unexecuted, reserved for a future LLM suggestion producer that would write into this same table with `kind='llm'`.

### D8. `mergeIdentity` reconciles the person layer

The LID→PN collapse extends its rewrite list to the person tables, in the same transaction: `person_members.identity_jid`, `person_suggestions.jid_low/high` (re-normalize pair order; collapse duplicates), `person_link_suppressions` (same), `person_link_events.identity_jid`. If the rewrite reveals the LID and PN sat in *different* persons, that is proof the persons share an identity → union per D4, audited. If it collapses a pair to self-referential (LID and PN of one identity were suggested/suppressed against each other), the row is deleted.

### D9. Read-time aggregation contract

The repository exposes the contract every future person-keyed surface uses — meaning stays server-side:

- `resolvePersonForJid(jid)` → `{personId, members[]} | null`
- `listPersons()` / `getPerson(personId)` → members with source, evidence, linked_at (visible provenance)
- `personKeyForJids(jids[])` → batch map for DTO assembly

Aggregation is by membership at read time: a person's claims are `brain_claim_entities WHERE jid IN (members)`; a person's engagement is the sum of members' `engagement_aggregates` rows; a person's display label derives from members (D10). Nothing is precomputed per person in this change, so connect/disconnect re-derivation is literally free today; the contract requires future cached person surfaces to key their invalidation on membership changes (the audit table gives them the hook).

### D10. Person display label and render-time disambiguation

A person's label is its **primary member's** resolved label (`resolveDisplayLabel`, `src/server/import/jid.ts:126`), primary chosen deterministically: the member with a saved contact name and the highest message count, else highest message count. No stored person name — storing one would create a second name authority and drift.

Disambiguation is a read-path concern at DTO assembly: a shared helper `disambiguateLabels(entries: {label, personKey, jid}[])` runs wherever label *lists* are assembled (chat list, thread sender labels, search results, signal surfaces, person lists). When two entries share a label but differ in `personKey`, each colliding label gains a deterministic suffix — the complete `+E.164` of the entry's (primary) number, per the naming-integrity rule that numbers are never masked or partial; for number-less identities, a short shared-chat context. Two identities of the *same* person never disambiguate against each other. Evidence packs keep their already-shipped pack-local collision suffixes unchanged — extraction and display disambiguation are separate mechanisms by design (extraction must be reproducible from the pack alone).

### D11. Unconfirmed hints are display annotations, never inputs

A pending suggestion with score ≥ 0.8 (config-tunable) may surface on person/identity DTOs as `unconfirmedHint: "possibly the same as <label> — unconfirmed"`. Hints are assembled at read time from `person_suggestions`, appear only in owner-facing surfaces, and are structurally incapable of reaching claims or prompts: evidence-pack rendering and extraction never read the suggestions table.

### D12. API and minimal surface

Server routes: list persons/suggestions, connect, disconnect, reject suggestion, accept suggestion (which just calls connect with `source='user'`), trigger scan. A minimal management panel (person list with member provenance, pending suggestions with evidence, connect/disconnect/reject buttons) ships so the checkpoint is exercisable end-to-end; the full people experience is `people-management-ui`'s. Passes report progress via the existing job/SSE machinery when they exceed ~1s.

## Risks / Trade-offs

- **[Bad Google data over-connects]** A junk-drawer Google contact ("Plumber — old & new number" holding two different humans) auto-connects wrongly. → This is the accepted trade of certainty-grade sources; mitigation is the design's whole shape: disconnect is one click, writes suppression so the sync never reconnects, and zero episodes were touched so the mistake never poisoned prose. Provenance on the membership row makes the *why* visible.
- **[Cross-person union surprises the user]** Certainty-grade union of two user-curated persons could merge something a user wanted separate. → Union is audited and surfaced in the management panel; disconnect of the offending identity restores separation. The alternative (blocking on conflict) would silently drop certainty-grade evidence.
- **[Detector cost at real-archive scale]** Succession and shared-group scans over a full real archive could be slow. → All detectors are bounded per pass (row budgets + persisted cursors), run at recovery-tick cadence where other passes already run, and are pure reads + suggestion upserts — safe to interrupt anywhere.
- **[Label-collision detection cost]** Global collision checks could imply scanning all labels per render. → Disambiguation runs only over the label set already being assembled for a response (per-DTO-batch, in-memory); no global index is needed.
- **[Suppression too sticky]** A rejected suggestion pair is never re-suggested even if evidence strengthens later. → Accepted: re-suggesting dismissed pairs is exactly the annoyance the proposal forbids. A `user` connect always overrides; the management panel can list suppressions for manual clearing (small surface, part of D12).
- **[JID-keyed person tables vs. future identity attributes]** If identities later need attributes `contacts` can't hold, D1's "no identity table" call gets revisited. → The person tables reference JIDs, which any future `brain_identities` table would also key on; nothing here forecloses that.

## Migration Plan

Additive-only. New tables enter `schemaStatements` (idempotent `CREATE TABLE IF NOT EXISTS`); no existing table changes; no wipe-and-rebuild needed because no brain derived table changes shape. On first run after upgrade:
1. Schema creates empty person tables.
2. The first auto-connect pass consumes all existing `identity_number_changes` rows (the 457) — connects land with `number_change` provenance.
3. Google groupings populate on the next sync (grouping capture requires a sync by nature); the sync-completion hook then connects same-contact identities with `google` provenance.
4. Detectors begin producing suggestions at their normal cadence.

Rollback: stop the passes and drop the person tables — by construction nothing outside them (episodes, claims, citations, contacts, chats) was written by any person operation.

## Open Questions

None blocking. Two defaults chosen here rather than left open, both config-tunable: the hint threshold (0.8) and detector pass budgets (bounded rows per tick, succession behind a persisted cursor).
