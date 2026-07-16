# People Management UI — Design

## Context

`two-level-person-model` (#5, archived 2026-07-16) shipped far more surface than this seed anticipated: the People page exists with pair-grouped suggestion cards (noisy-OR fused confidence), per-merge value propositions (messages/mentions/groups per side), kind filters and value-aware sorting, a compare dialog with side-by-side DM threads plus cross-chat group activity, provenance-filterable connected views with unified-history sorts, a dismissed list, scan freshness, and the full `/api/persons/*` route family. What did NOT ship, verified against the code:

- **No undo**: `rejectPersonSuggestion` flips rows to `rejected`, which upsert treats as sacred — correct against detectors, but no human path back. The Dismissed tab is display-only.
- **Debt is elsewhere and action-less**: `getBrainResolutionDebt` ranks bare-number identities by repair payoff (`BrainResolutionDebtIdentity {jid, label, messageCount, episodeCount}`) but renders read-only in the Brain panel; the proven fix path exists only as the `set-contact-name` CLI (`cli.ts:317` — `upsertContacts` detects the name transition and routes through `repairIdentityResolution`, zero model calls).
- **Explorer gaps**: the compare dialog has no media, no profile photos, no membership timeline; `group_membership_periods` and `media_assets` (+ `/api/media/assets/:id/thumbnail`) hold everything needed.
- **No audit view**: `person_link_events` accumulates connect/disconnect/union/dissolve/suggest/accept/reject with evidence; `listPersonLinkEvents` exists on the repository with no route or UI.
- **No live refresh**: the page refreshes only after its own actions; background auto-connects and detector runs are invisible until reload. `useArchiveEvents` is the established SSE hook (ChatsPage, ThreadView, StatusContext).
- **Live client**: `LiveWhatsAppClient` has optional capabilities (`downloadMedia?`); Baileys exposes `profilePictureUrl(jid)`. No avatar machinery exists.

Constraints: repository methods land in the interface + both impls; UI conventions from the #5 feedback rounds are standing (no raw JSON primary, freshness lines, explainer tooltips, complete numbers); better-sqlite3 single writer; never block the event loop; the archive layer is sacred, everything above rebuildable.

## Goals / Non-Goals

**Goals:**
- Dismissal undo (human-only) that composes correctly with rejection memory and detector re-runs.
- One ranked identity-hygiene queue interleaving "name this contact" (debt) and "confirm this pair" (suggestions) by payoff.
- In-app rename that routes through the shipped repair entry point, with user-set names strongest in precedence.
- Compare dialog completed: shared-group membership timeline, recent stored-media thumbnails per side, live-fetched profile photos (cached, TTL, never blocking).
- Audit trail visible; page refreshes from the archive-events SSE stream.

**Non-Goals:**
- No new detectors, scoring changes, or person-model semantics — #5's contract stands.
- No LLM anything (the person-inference producer remains a future seed).
- No media *download* changes — the strip shows already-stored assets only.
- No avatar fetching without a connected live session; no remote calls from the client (server-mediated only).

## Decisions

### D1. Undo is a human-only un-reject, per pair

New repository method `unrejectPersonSuggestions(jidLow, jidHigh)` flips every `rejected` row for the pair back to `pending` (evidence and score kept; the next detector pass updates or prunes them naturally through the existing upsert/hygiene machinery). The detector-side guarantee is untouched: upsert still never resurrects `rejected` rows — only this explicit route does, audited as an `unreject` action in `person_link_events` (CHECK constraint gains the value; person-layer tables are above the archive layer, so the standing sanction covers the rebuild-free `ALTER`... SQLite cannot alter CHECKs — instead the event `action` column's CHECK is widened by table rebuild OR the event is recorded as `suggest` with evidence `{undo:true}`. **Decision: widen the CHECK via the established migrated-table-rename idiom** (`migrateLiveMessageUpdateTypes` pattern) — honest audit beats shoehorning.) Exposed as `POST /api/persons/suggestions/undo {jidLow, jidHigh}`; the Dismissed tab gets a per-pair "Undo" button.

*Alternative — delete the rejected rows:* loses the audit trail and the score/evidence; rejected-history has proven useful in every feedback round.

### D2. The hygiene queue is a client-side merge over two existing feeds

No new schema, no new ranking tables. A "To-do" tab (new default) merges:
- **Pair items**: the existing pending suggestion groups with their shipped `recommendedScore`.
- **Debt items**: `GET /api/persons/debt` — a thin route over `getBrainResolutionDebt({limit: 100})`, items scored on the same scale: `0.85 × min(1, log10(1 + messageCount)/3.5)` (a name-save is certainty-grade action, pure payoff; the 0.85 ceiling keeps a heavyweight confirmable pair able to outrank a mid-weight rename).
Items interleave by score descending; each renders its native card (pair card unchanged; debt card = label, complete number, episode/message counts, inline name input). Existing Suggestions/Connected/Dismissed tabs stay as focused views.

*Alternative — server-side unified queue endpoint:* premature; both feeds exist, the merge is presentation, and downstream consumers (MCP) already get both primitives server-side.

### D3. Rename = the CLI path, promoted to a route, with `user` provenance

`POST /api/persons/rename {jid, name}` validates (non-empty; rejects masked-number shapes and digit-restatements via the existing `isMaskedNumberLabel`/`isIdentityDerivedName` guards), then calls `upsertContacts` with `displayName` + `displayNameSource: 'user'` — the same transition-detecting path the CLI proved, so `repairIdentityResolution` runs (prose substitution + FTS recompute, no model call). Response carries before/after debt counts like the CLI prints, surfaced as the success toast ("Repaired N episodes"). Precedence: `display_name_source = 'user'` joins the top of the name hierarchy — enrichment's weak-label check already preserves non-weak names; the delta additionally requires wa.db/import paths not to overwrite a `user`-sourced name (guard in `upsertContacts`' conflict clause).

### D4. Explorer context arrives in one route

`GET /api/persons/compare-context?jidA&jidB` returns, per side: recent stored media (new repo read `listRecentMediaBySender(jid, limit 8)` — messages⋈media_assets, stored only, newest first, thumbnail-capable flagged) and the shared-group membership timeline (both sides' `listGroupMembershipPeriods` filtered to common groups, chat labels resolved server-side, rendered as "Family: A joined Jan 2024 · left Mar 2026 / B joined Mar 2026"). Thumbnails render through the existing `/api/media/assets/:id/thumbnail`. One request keeps the dialog's fetch fan-out fixed (threads ×2 + activity ×2 + context ×1).

### D5. Avatars: optional live capability, server-mediated, cached with TTL

`LiveWhatsAppClient` gains optional `fetchProfilePictureUrl?(jid): Promise<string | null>` (Baileys `profilePictureUrl(jid, 'image')`, low-timeout). `GET /api/persons/avatar?jid=` serves from `.wapp-brain/avatars/` (content file + meta json: fetchedAt, TTL 7 days, negative-cache 404s for 1 day); on miss with a connected maintainer it fetches the URL server-side, stores, serves; on miss without live it 404s immediately. The dialog renders avatars as progressive enhancement — never a loading gate. Privacy: fetched bytes stay local under `.wapp-brain/`, never in the DB, never logged; the route sends `Cache-Control: private`.

*Alternative — fetch during sync ticks for all contacts:* unbounded fetching against WhatsApp for faces nobody is looking at; on-demand + cache matches the "only when a human opens the dialog" need and the rate-limit posture.

### D6. Audit and live refresh reuse what exists

`GET /api/persons/events?limit=100` over `listPersonLinkEvents`, rendered as a collapsible "History" section (actor-free one-liners: "connected +91… ↔ +1… via google · 2h ago", evidence behind the standing collapsed-raw pattern). The page subscribes to `useArchiveEvents` and debounce-refreshes (1–2s) on archive-updated events — background scans, syncs, and CLI actions become visible without reload; the scan-freshness line already communicates *why*.

### D7. Sequencing for the implementing session (Sonnet)

Three independent slices, each shippable: (1) undo + audit + SSE refresh; (2) hygiene queue + rename; (3) explorer completion (context route, then avatars last — the only slice touching the live client). Nothing here blocks or is blocked by `knowledge-graph-foundation` (#9) or `brain-eval-harness` (#7).

## Risks / Trade-offs

- **[Undo vs detector hygiene race]** An undone pair that is genuinely zero-value gets re-pruned by the next pass → looks like the undo "didn't work". → The undo response returns the restored rows; the UI keeps them visible in-session with a note if a later refresh drops them ("re-pruned: no unifiable history"); the audit trail records both.
- **[CHECK-constraint rebuild on `person_link_events`]** Table-rebuild migration on an append-only audit table. → Uses the established `migrateLiveMessageUpdateTypes` copy-rename idiom; the table is small and above the archive layer.
- **[Avatar fetch rate/blocks]** WhatsApp may throttle or the socket may be busy. → One fetch per jid per TTL window, low timeout, negative cache, never in a tick loop — only on explicit dialog opens; failures render as the initial-letter placeholder.
- **[Rename typos poison labels]** A bad user-set name outranks everything. → Rename is re-editable from the same surface (a `user` name can be replaced by the user), the repair path is idempotent, and the audit records each rename.
- **[Debt item double-listing]** An identity can appear both as a debt item and inside a pending pair. → Acceptable and honest (naming and connecting are different actions); the To-do card kinds are visually distinct.

## Migration Plan

Additive except the `person_link_events` CHECK widening (copy-rename rebuild, data preserved). No wipes, no extraction-version bump, no brain derived-table changes. `.wapp-brain/avatars/` is created lazily and is disposable cache. Rollback: drop the routes/UI; the only durable writes (renames, undos) are ordinary contact names and suggestion status flips, both already first-class states.

## Open Questions

None blocking. Two defaults chosen: avatar TTL 7d/negative 1d (config-tunable), debt-item score ceiling 0.85.
