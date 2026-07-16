# People Management UI — Tasks

## 1. Dismissal undo, audit visibility, live refresh

- [x] 1.1 Widen the `person_link_events.action` CHECK to include `unreject` via the established copy-rename rebuild idiom (`migrateLiveMessageUpdateTypes` pattern in `src/server/db/sqliteRepository.ts`); memory repo needs only the type union
- [x] 1.2 Add `unrejectPersonSuggestions(jidLow, jidHigh)` to the `ArchiveRepository` interface and both impls: flip every `rejected` row for the normalized pair back to `pending` (score/evidence kept), audit an `unreject` event, return the restored count; detectors' upsert continues to never resurrect `rejected` rows itself
- [x] 1.3 Routes: `POST /api/persons/suggestions/undo {jidLow, jidHigh}` (404 when nothing to restore) and `GET /api/persons/events?limit=` over `listPersonLinkEvents`
- [x] 1.4 Dismissed tab: per-pair Undo button with busy state; restored pair stays visible in-session with a "re-pruned: no unifiable history" note if the next refresh drops it (design D1 race); toast reports restored signal count
- [x] 1.5 History section on the People page: collapsible audit list rendering one-liners (action, pair/member labels with complete numbers, source, relative time) with evidence behind the standing collapsed-raw pattern — no message bodies
- [x] 1.6 Subscribe the People page to `useArchiveEvents` with a 1–2s debounce refresh so background auto-connects, detector runs, and syncs appear without reload
- [x] 1.7 Tests (both repo backends + route level): undo round-trip restores all of a pair's rejected rows and audits `unreject`; detectors still never resurrect an un-undone rejection; undo → zero-value pair gets re-pruned by the next pass (the honest race); events route returns sourced actions without payload leakage

## 2. Unified hygiene queue and name-this-contact

- [x] 2.1 Route `GET /api/persons/debt` — thin read over `getBrainResolutionDebt({limit: 100})` returning ranked `{jid, label, messageCount, episodeCount}` items
- [x] 2.2 Route `POST /api/persons/rename {jid, name}`: refuse empty, masked-number (`isMaskedNumberLabel`), and digit-restatement (`isIdentityDerivedName`) names; persist via `upsertContacts` with `displayNameSource: 'user'` (the proven `set-contact-name` transition path, so `repairIdentityResolution` runs); return before/after debt so the UI can report episodes repaired
- [x] 2.3 Precedence guard: `user`-sourced display names survive wa.db imports and Google enrichment (extend the `upsertContacts` conflict precedence + the enrichment weak-label check); replaceable only by another `user` write
- [x] 2.4 "To-do" tab (new default) merging debt items and pending pair groups on one payoff scale — pairs keep `recommendedScore`, debt items score `0.85 × min(1, log10(1 + messageCount)/3.5)` (design D2) — with visually distinct card kinds; debt card shows label, complete number, episode/message counts, and an inline name input
- [x] 2.5 Rename UX: submit from the card, success toast with "repaired N episode(s)", debounced refresh removes the item as debt clears; renaming an already-named identity works from the Connected tab too (user names are user-replaceable)
- [x] 2.6 Tests: debt route shape; rename validation refusals; rename→repair round-trip (episodes' prose substituted, zero model calls) on both backends; `user` name survives a subsequent wa.db-style upsert and a Google enrichment pass; queue interleaving order for a heavy debt item vs a light pair

## 3. Evidence explorer completion (media, timeline, faces)

- [x] 3.1 Repo read `listRecentMediaBySender(jid, limit 8)` on both impls: stored media assets by sender, newest first, `{messageId, assetId, mimeType, hasThumbnail, timestampMs, chatLabel}` — no bytes in the DTO
- [x] 3.2 Route `GET /api/persons/compare-context?jidA&jidB`: per-side media strips (3.1) plus the shared-group membership timeline — both sides' `listGroupMembershipPeriods` intersected on common groups, chat labels resolved server-side (design D4)
- [x] 3.3 Compare dialog: media strip per column using the existing `/api/media/assets/:id/thumbnail`, and a "Shared groups" timeline section ("Family: A joined Jan 2024 · left Mar 2026 / B joined Mar 2026"); both degrade to nothing when empty, never a loading gate
- [x] 3.4 Optional live capability `fetchProfilePictureUrl?(jid)` on `LiveWhatsAppClient` (Baileys `profilePictureUrl`, low timeout), exposed through the maintainer to the server
- [x] 3.5 Avatar cache + route: `.wapp-brain/avatars/` content + meta (fetchedAt, TTL 7d, negative-cache 1d), `GET /api/persons/avatar?jid=` serving cache-first, fetching only on miss with a connected session, immediate 404 otherwise, `Cache-Control: private` (design D5)
- [x] 3.6 Dialog renders avatars as progressive enhancement (initial-letter placeholder first); no fetch outside explicit dialog opens
- [x] 3.7 Tests: media read excludes non-stored assets and respects order/limit; compare-context intersects groups and resolves labels; avatar cache TTL + negative cache honored, disconnected session 404s without fetch attempts; dialog payloads carry ids and labels, never media bytes

## 4. Verification and closeout

- [x] 4.1 Full suite (`vitest run`) + typecheck + build; fix fallout
- [x] 4.2 Real-archive verification on a copy: undo a real dismissed pair; rename a top debt identity and confirm episode prose/search repair with zero model calls; open a compare dialog with media + timeline; avatar fetch behavior with live disconnected (404 path) — browser-driven where possible
- [x] 4.3 Checkpoint (user): dismiss → undo → pair returns ranked; name a bare-number identity from the To-do queue and see "repaired N episodes"; decide a suggestion from media/faces/timeline without leaving the dialog; leave the page open during a scan and watch it update
- [x] 4.4 `npm run roadmap:sync`; confirm the `knowledge-graph-foundation` and `mcp-agent-surface` seeds still describe the person read contract accurately after this change

## 5. Checkpoint feedback: blocked-pairs review and manual connect (2026-07-16)

- [x] 5.1 `releasePersonLinkSuppression(jidA, jidB)` on both repos: delete the pair's suppression only (nothing connects), audited as `release` (events CHECK widened again via the same rebuild idiom); suppressions listing enriched with labels + complete numbers
- [x] 5.2 Routes: `POST /api/persons/suppressions/release` (404 when no block) ; Dismissed tab becomes "Dismissed & blocked" with a Blocked pairs section — reason chip ("you disconnected them" / "you dismissed a suggestion") with explainer tooltip and a Release button
- [x] 5.3 Manual connect UI on the Connected tab: "Connect two numbers manually" form accepting human-typed numbers or ids (normalized client-side), driving the existing user-source connect (clears blocks, unions) with outcome-specific toasts
- [x] 5.4 Tests: release round-trip (block listed with context → release audited → next auto-connect pass reconnects; releasing nothing reports false/404); suppressions enrichment; full suite + build green
- [x] 5.5 Checkpoint feedback: split the merged To-do queue into separate "Suggestions" and "Needs names" tabs (user preference — no combined view); spec's hygiene-queue requirement reworded to two focused ranked views; the payoff-interleave scoring retired with it
- [x] 5.6 Checkpoint feedback: "Suggestions" tab renamed to "Suggested connections" with a one-line explainer atop the list (plain "Suggestions" read as vague without context)
