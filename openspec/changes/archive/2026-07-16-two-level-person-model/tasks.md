# Two-Level Person Model — Tasks

## 1. Person-layer schema and repository foundation

- [x] 1.1 Add the person-layer tables to `schemaStatements` in `src/server/db/sqliteRepository.ts` per design D3: `persons`, `person_members` (UNIQUE identity_jid, source CHECK `google|number_change|user`), `person_link_suppressions` (normalized pair PK), `person_suggestions` (UNIQUE pair+kind, kind CHECK incl. `llm`), `person_link_events`, `google_contact_groups`, `person_redirects`, plus supporting indexes
- [x] 1.2 Add `connectIdentities(jidA, jidB, source, evidence)` to the `ArchiveRepository` interface and both impls (sqlite + memory): transactional case analysis — create person / add member / no-op / union with `person_redirects` row — user-source clears suppressions, auto sources blocked by them, every path audited in `person_link_events`
- [x] 1.3 Add `disconnectIdentities(jid)` to both impls: delete membership, write `disconnected` suppressions against former co-members, dissolve to redirect when <2 members remain, audit; plus `rejectSuggestion` / `acceptSuggestion` (accept delegates to a `user` connect with the suggestion id as evidence)
- [x] 1.4 Add read-contract methods to both impls (design D9): `resolvePersonForJid`, `listPersons` / `getPerson` (members with source, evidence, linked_at), `personKeyForJids` batch map, `listPersonSuggestions`
- [x] 1.5 Extend `mergeIdentity` (sqlite + memory) to rewrite `person_members`, `person_suggestions`, `person_link_suppressions`, `person_link_events` onto the canonical JID in the same transaction — re-normalize pair order, collapse duplicates, delete self-referential pairs, union persons revealed to share an identity (design D8)
- [x] 1.6 Tests: connect/disconnect round-trip restores pre-connect state with episode/claim/citation tables byte-identical; union with redirect; at-most-one-person invariant; suppression written on disconnect and cleared by user connect; mergeIdentity person-layer reconciliation — run against both repository backends via the `withRepository` pattern

## 2. Google sync captures the same-contact grouping

- [x] 2.1 Extend `GooglePerson`/`buildCandidates` in `src/server/googleContacts.ts` to read `resourceName` and emit groupings `(resourceName, phone_e164, displayName)` for every normalizable number, independent of name-ambiguity skips; name-enrichment candidate behavior unchanged
- [x] 2.2 Persist groupings in `sync()`: full replace-or-upsert into `google_contact_groups` stamped with the sync time (repo method on both impls); extend the sync result counts with grouping totals surfaced in the existing sync UI counts
- [x] 2.3 Tests: multi-number contact persists one grouping; ambiguous-name number still appears in its contact's grouping; re-sync after a number moves between contacts replaces groupings without disconnecting anything; raw payloads still not stored

## 3. Deterministic auto-connect pass

- [x] 3.1 Implement `runPersonAutoConnectPass` (new `src/server/persons/autoConnect.ts` or similar): same-Google-contact source — each `google_contact_groups` resource with ≥2 archived identity matches connects pairwise with source `google` and the resourceName as evidence, matching numbers the same way enrichment does
- [x] 3.2 Number-change source in the same pass: scan `identity_number_changes`, connect `old_jid`↔`new_jid` with source `number_change` and the event key as evidence — full-scan idempotent so the existing 457 backup rows connect on first run and live rows connect continuously
- [x] 3.3 Wire trigger points: end of Google sync, end of backup import, a `LiveMaintainer.recoveryTick` slot after `sweepUnmergedIdentities` and before the brain pass (`src/server/live/maintainer.ts:203`), and a CLI command; bounded, yielding, progress via job machinery when >1s
- [x] 3.4 Tests: google auto-connect with provenance; number-change backfill idempotency (second pass writes nothing); suppressed pair skipped by both sources; grouping disappearance does not disconnect

**Checkpoint (user):** link two of your numbers under one Google contact → they auto-connect with visible provenance; disconnect reverses it; number-change history has connected old→new numbers.

## 4. Suggestion producers and rejection memory

- [x] 4.1 Implement detector pass scaffolding (`src/server/persons/suggestions.ts`): bounded per-tick budgets, persisted cursor where needed, skip pairs already co-members / suppressed / same-kind-rejected, ranked upsert into `person_suggestions` that never resurrects a rejected row
- [x] 4.2 `same_name` detector: group identities by resolved display label (via `resolveDisplayLabel` inputs), score by label strength (saved name > push name); `shared_vcard` detector over `message_vcards.resolved_jid` as a low-score corroborator
- [x] 4.3 `shared_group` detector (co-presence weighted toward small groups) and `co_citation` detector over `brain_claim_entities` identity anchors
- [x] 4.4 `succession` detector: per-chat last/first activity of identity pairs plus `group_membership_periods` leave/join windows; evidence names the shared chats and windows; cursor-bounded
- [x] 4.5 Wire detectors into the recovery tick at a lower cadence than auto-connect, and into the CLI scan command
- [x] 4.6 Tests: same-name produces suggestion and never membership; rejection memory survives re-runs with strengthened evidence; succession detector on a synthetic fixture (A goes silent, B appears in same chats); detectors skip co-members and suppressed pairs

## 5. Read surfaces: aggregation, disambiguation, hints

- [x] 5.1 Person display-label derivation (design D10): primary member = saved-name member with highest message count, else highest message count; expose person label through the read contract
- [x] 5.2 Shared `disambiguateLabels(entries)` helper applied at DTO assembly points that emit label lists (chat list, thread senders, search results, signal surfaces): same label + different personKey → append complete `+E.164` (or shared-chat context for number-less identities); same-person identities never disambiguate against each other; evidence-pack pack-local suffixes untouched
- [x] 5.3 Unconfirmed hints (design D11): pending suggestion with score ≥ configurable threshold (default 0.8) surfaces as `unconfirmedHint` on owner-facing person/identity DTOs; structurally absent from evidence packs, prompts, and search ranking
- [x] 5.4 Tests: two same-name persons render distinctly in a label list while one person's two identities do not; disambiguator is complete `+E.164`, never masked; hint present on DTO but assimilation output identical with and without it; pack-local extraction resolution unaffected by membership (pack-local-only resolution regression test)

## 6. API and minimal management surface

- [x] 6.1 Server routes: list persons (members + provenance), list suggestions (evidence + rank), connect, disconnect, accept, reject, trigger person scan; wire into existing server routing and SSE/job progress
- [x] 6.2 Minimal management panel in the client: person list with per-member source/evidence and one-click disconnect, pending suggestions with evidence and accept/reject, scan trigger with progress; failures visible in UI and server console per the async-progress convention
- [x] 6.3 Tests: route-level coverage for connect/disconnect/accept/reject including suppression behavior and redirect resolution of a dissolved person id

**Checkpoint (user):** two same-name contacts remain separate persons with separate views; connect/disconnect from the panel works with visible provenance and zero episode changes; a dismissed suggestion never reappears.

## 7. Verification and closeout

- [x] 7.1 Run the full test suite (`vitest run`) plus typecheck; fix fallout
- [x] 7.2 End-to-end verify against a real archive copy: auto-connect pass over real `identity_number_changes`, Google sync grouping capture, detector pass timings bounded at real-archive scale (per live-sync operational context: never block the event loop)
- [x] 7.3 Update `openspec/changes/ROADMAP.md` status via `npm run roadmap:sync` and confirm downstream seeds (`knowledge-graph-foundation`, `semantic-rollups`, `people-management-ui`) reference the shipped read contract accurately

## 8. Checkpoint feedback round (user review 2026-07-16)

- [x] 8.1 Remove `shared_group` as a standalone suggestion producer (real-data noise): default detector list drops it, co-presence stays as succession corroboration, `supersedePersonSuggestionsByKind` retires lingering pending rows; design D7 + person-identity-model spec amended
- [x] 8.2 Scan-freshness surface: passes stamp an in-process `PersonScanStatus`, `GET /api/persons` returns it, page explains the automatic cadence and shows "last scan Xm ago"; button relabeled Rescan
- [x] 8.3 Human-decidable suggestions: complete numbers beside names, per-identity open-chat links (DM chat ids resolved at read time), evidence-referenced group ids resolved to display labels, friendly per-kind evidence lines with raw JSON behind a collapsed section, succession evidence records ender/starter
- [x] 8.4 Kind and provenance chips get explainer tooltips (incl. number change vs succession distinction); page restructured into Suggestions / Connected people / Dismissed tabs with per-kind filter chips
- [x] 8.5 Tests updated for the retired detector + enrichment fields; full suite, build, and browser verification re-run
- [x] 8.6 Record follow-ups where they belong: evidence-explorer popup (chat/media/profile-photo preview) noted in the `people-management-ui` seed; future LLM person-inference producer (reserved `llm` kind / `merge_adjudicate`) noted as a future roadmap seed

## 9. Second feedback round (user review 2026-07-16, afternoon)

- [x] 9.1 Value-aware suggestion ordering: per-side message counts on the suggestion DTO (both repos, cached per response); client sort dropdown — Recommended (0.65·confidence + 0.35·log-scaled merge value, where value = the smaller side's history), Confidence, Potential value
- [x] 9.2 In-place compare dialog: clicking a card (or Compare chats) opens both identities' recent DM threads side by side with evidence and Same person / Different people inside the dialog; full-chat links open in a new tab so the queue is never lost — the richer media/DP/analysis explorer remains `people-management-ui` scope
- [x] 9.3 Header compressed to one line with an expandable "How does this work?" intro; Rescan styled as a primary button with icon + "last scan" beside it
- [x] 9.4 Confirmed the lingering shared-group suggestions were the pre-phase-8 server process, not a code error — first scan on current code supersedes them (re-verified on a fresh archive copy: queue 120 → 71)
- [x] 9.5 Zero-value rule: pairs where neither side ever sent a message are not produced (same_name, shared_vcard), pending ones are pruned each pass (`supersedePersonSuggestionsByIds`), and superseded rows resurrect to pending when a detector produces them afresh — so the pair self-surfaces once either number speaks; one-sided-zero pairs stay (new-number forward value) and sink via Recommended sort; spec amended
- [x] 9.6 One card per pair: signals for the same pair group at the presentation layer with noisy-OR fused confidence (85% + 50% → 93%, capped below certainty), all signal chips + merged evidence on one card, acceptance connects the pair (connect supersedes sibling signals), and "Different people" rejects every signal's row so none re-suggests — verified on real data (69 rows → 67 pair cards; pair dismissal rejected both rows and survived a rescan)
- [x] 9.7 Queue hygiene sweep: the detector pass supersedes pending suggestions whose pair is already co-membered (covers transitive connects from multi-number Google cards, e.g. A↔B and A↔C leaving a stale B↔C row) or suppressed — diagnosed live after the user's real Google sync connected 45 pairs but left 3 transitive stale cards
- [x] 9.8 Connected-people filters and sorts: provenance filter chips (google / number_change / user, counted per person) and sorts — History unified (default: total minus largest member, i.e. what connecting consolidated), Total messages, Recently connected, Number count — plus a per-person stats line (N numbers · M msgs · K unified); client-only, verified live against the real session

## 10. Third feedback round (user review 2026-07-16, evening)

- [x] 10.1 Merge value proposition on every suggestion: mention counts (`message_mentions`) and group-membership counts (`chat_participants`) join message counts on the suggestion DTO (both repos, cached per response); every card and the compare dialog render a uniform "Unifies X + Y messages · P + Q mentions · in M + N groups" line with an explainer tooltip
- [x] 10.2 Compare dialog shows cross-chat activity: new `listRecentMessagesBySender` repo read (both repos, visible-exchange filtered, chat labels resolved) + `GET /api/persons/identity-messages`; each column renders "Direct chat" (when one exists) plus "Around the groups" with per-message group links opening in new tabs — a group-only identity is never a dead end, and the no-DM state says so honestly
- [x] 10.3 Verified on a real-archive copy: succession pair rendered value line on card + dialog, both columns showed linked group activity; full suite (391) + build green
