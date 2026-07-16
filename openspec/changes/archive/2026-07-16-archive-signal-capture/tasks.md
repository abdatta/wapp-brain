## 1. Canonical Signal Contracts And Storage

- [x] 1.1 Add shared typed records for number changes, membership periods/events, chat metadata history, locations, vCards, deletion/edit events, media interpretations, engagement aggregates, and episode signal anchors.
- [x] 1.2 Extend `ArchiveRepository` with batch upsert and focused read methods for every canonical signal family, keeping engagement reads internal rather than on general DTOs.
- [x] 1.3 Add focused SQLite tables, constraints, natural-key uniqueness, capture-version/provenance columns, and consumer indexes without deleting existing messages, chats, contacts, or media.
- [x] 1.4 Generalize `message_mentions` provenance so structured and text-derived observations deduplicate while authoritative capture remains distinguishable.
- [x] 1.5 Keep held prior content in `message_edit_revisions`, add metadata-only edit events separately, and add deletion provenance without weakening current-state projections.
- [x] 1.6 Implement source-aware monotonic batch upserts in `SqliteArchiveRepository`, filling missing fields while preventing older backup observations from erasing richer live state.
- [x] 1.7 Mirror all new contracts and monotonic semantics in `MemoryArchiveRepository` for test parity.
- [x] 1.8 Rekey and deduplicate every new JID-bearing signal inside `mergeIdentity`, including mention provenance, number-change endpoints, membership, vCard JIDs, revoke actors, and engagement scopes.
- [x] 1.9 Add repository tests for uniqueness, replay idempotency, monotonic enrichment, identity rekeying, cascade behavior, and SQLite/in-memory parity.

## 2. Defensive Backup Signal Readers

- [x] 2.1 Add reusable optional-table readers that select only inspected columns, recognize verified aliases, isolate family failures, and emit content-free scoped warnings.
- [x] 2.2 Import `message_mentions` as authoritative canonical JIDs and keep quoted mentions owned by reply snapshots, with text-token parsing only as fallback.
- [x] 2.3 Import `message_location` rows into structured location records, including live-location state and only the optional numeric/text fields actually present.
- [x] 2.4 Import ordered `message_vcard` rows and `message_vcard_jid` identity hints without speculative person merges.
- [x] 2.5 Import backup URL/title/description/embedded-thumbnail fields through the existing `message_link_previews` contract without network access.
- [x] 2.6 Decode structurally verified `message_system_number_change` rows into canonical old-JID/new-JID records and leave unverified actions generic.
- [x] 2.7 Decode verified add/remove/join/leave system actions and subject/description/photo history with stable message/chat anchors and nullable actor/time/value fields.
- [x] 2.8 Import current and past group participant rows as membership periods with available join/leave bounds and admin rank, streaming high-cardinality inputs.
- [x] 2.9 Capture all available `message_edit_info` events under the original key and `message_revoked` actor/time provenance without fabricating prior content.
- [x] 2.10 Capture non-empty accessibility labels, raw transcriptions, and ordered transcription segments as source-provided media interpretations.
- [x] 2.11 Aggregate receipt/device tables in source SQLite or bounded streams into read-rate and response-latency summaries, discarding raw rows before repository writes.
- [x] 2.12 Wire signal batches into importer ordering after canonical messages/identities exist, preserving restore-point, cancellation, progress, and import-run warning behavior.

## 3. Fixture Coverage And Backup Import Tests

- [x] 3.1 Extend the synthetic modern backup fixture with one verified row for every signal family and safe variants for multi-vCard, multiple mentions, edits, and revokes.
- [x] 3.2 Add legacy Android and iOS-shaped fixtures that omit or rename optional tables/columns and prove ordinary import plus other signal families continue.
- [x] 3.3 Add malformed optional-row fixtures proving only the companion is skipped and warnings contain no body, vCard, transcript, coordinates, receipt data, keys, or raw rows.
- [x] 3.4 Add re-import tests proving natural-key idempotency, structured-mention provenance upgrades, stale-backup/live conflict handling, and no message duplication.
- [x] 3.5 Add large synthetic receipt and participant-history tests proving bounded memory behavior and correct aggregate numerators, denominators, medians, sample counts, bounds, and versions.

## 4. Live And Backup Parity

- [x] 4.1 Normalize live number-change, group participant, and chat metadata events into the same canonical event records used by backup import.
- [x] 4.2 Route live structured mentions, locations, vCards, and link previews through the same repository shapes and provenance rules as backup capture.
- [x] 4.3 Converge live edit/revoke updates with backup edit events and deletion provenance using observed-time newest-state-wins semantics.
- [x] 4.4 Capture any source-provided live accessibility or transcription text without initiating model work or remote media interpretation.
- [x] 4.5 Add real-time and history-sync tests for canonical parity, replay idempotency, null-field enrichment, and protection of newer live state.

## 5. Local Read Surfaces And Privacy Boundaries

- [x] 5.1 Extend message/evidence repository reads with structured mentions, locations, vCards, previews, edit/delete metadata, and source media interpretations using allowlisted fields.
- [x] 5.2 Expose local message detail fields needed by the thread and evidence consumers while keeping exact private payloads out of status, diagnostics, and unrelated list responses.
- [x] 5.3 Add focused internal queries for number changes, membership history, chat metadata history, and engagement aggregates for changes #5, #8, and #9 to consume.
- [x] 5.4 Add a consumer-contract test proving a captured number-change pair is queryable as a certainty-grade input without implementing person auto-connect in this change.
- [x] 5.5 Add privacy canaries proving receipt rows/device ids, vCard bodies, transcripts, coordinates, and source-row contents never leak through logs, warnings, status, diagnostics, exports, or general DTOs.
- [x] 5.6 Render verified, message-anchored number-change, membership, and chat-metadata history as display-safe thread system events; materialize unanchored live group updates as stable local system timeline entries while preserving the generic fallback and privacy boundary.

## 6. Evidence Rendering, Stamps, And Regeneration

- [x] 6.1 Add bounded deterministic evidence renderers for authoritative mentions, locations, vCards, link-preview text, edit metadata, deletion metadata, and source-labelled media interpretation.
- [x] 6.2 Keep each annotation on its owning message alias, exclude binary thumbnails/raw vCard boilerplate, preserve held content on deletion, and keep system/history rows outside evidence packs.
- [x] 6.3 Include structured mentioned JIDs in pack-local identity labels and claim-entity anchoring without global name lookup or independent citations.
- [x] 6.4 Add durable `archive_signal_anchors` storage, commit-path calculation, query indexes, and in-memory parity without copying sensitive payload text into stamps.
- [x] 6.5 Mark episodes stale through signal anchors when re-import materially enriches an assimilated message, and enqueue deduplicated regeneration tasks without advancing watermarks.
- [x] 6.6 Bump `EXTRACTION_VERSION` and verify `brain regenerate` transactionally supersedes older episodes while recomputing signal anchors, media gaps, and other late-binding stamps.
- [x] 6.7 Add evidence tests for mention resolution, location/vCard/preview rendering, edit-versus-held-revision honesty, content-preserving deletion, transcript provenance, token bounds, and non-citability.
- [x] 6.8 Add regeneration tests proving old-version episodes are selected, signal enrichment marks only dependent episodes stale, retries deduplicate, and watermarks remain unchanged.

## 7. Documentation And Verification

- [x] 7.1 Document the canonical signal tables, optional-source behavior, engagement formulas/sample fields, retention boundary, and re-import/regeneration workflow.
- [x] 7.2 Run `npm test`, `npm run doctor`, and `npm run build`; resolve failures without committing generated private or build artifacts.
- [x] 7.3 Start the local app after database work, inspect affected message/API surfaces, and confirm no second `better-sqlite3` writer or real maintainer under `tsx watch` is running.
- [x] 7.4 Re-import the complete synthetic matrix twice and verify counts, provenance, idempotency, privacy canaries, and graceful legacy/iOS skips.
- [x] 7.7 Record the #5/#8/#9 consumer handoff: stable query contracts, capture versions, known schema fallbacks, and any real-archive fields that remained unavailable rather than guessed.

## 8. Canonical Full-Detail And Cross-Source Model

- [x] 8.1 Extend shared/repository types with compact detail-availability flags, complete `MessageDetail` fields, richer static/live location telemetry, lossless vCard properties/download metadata, explicit system-event roles/raw type data, and source observations.
- [x] 8.2 Add additive SQLite migrations and in-memory parity for source observations, ordered live-location samples, expanded system actions/metadata fields, and any detail indexes; backfill one observation from existing canonical signal rows.
- [x] 8.3 Implement deterministic cross-source keys and merge precedence for every signal family, including backup-first/live-first equivalence, exact distinct-event preservation, and real-anchor replacement of equivalent synthetic live anchors.
- [x] 8.4 Expand defensive backup readers to retain all verified location/vCard/edit/delete/system fields while prohibiting `message_system_group.is_me_joined` alone from creating a `participantJid = "me"` membership fact.
- [x] 8.5 Expand live normalization to use installed Baileys named/numeric stubs, structured participant JSON, `author`/affected-participant roles, number-change variants, promotion/demotion and group setting/description events, and complete supported location fields.
- [x] 8.6 Add focused loopback-only message-detail repository/API reads that expose complete retained owner data while keeping paginated thread, status, doctor, warning, log, and remote-evidence DTOs separately allowlisted.
- [x] 8.7 Add per-card local vCard download routes that serve source content when held, safely construct only trustworthy minimal cards, use sanitized filenames/headers, and reject insufficient or LID-only construction.
- [x] 8.8 Add a transactional repair/re-import path that removes or downgrades existing false self-attributed membership facts derived only from ambiguous flags, preserves verified facts, and rebinds eligible synthetic system anchors without duplicate timeline rows.

## 9. Owner-Facing Thread Details

- [x] 9.1 Replace location footer text with compact static/live location cards and a lazy full-detail view showing every available coordinate, quality, movement, sequence, duration/final, caption/comment/URL, thumbnail, time, and provenance field.
- [x] 9.2 Render every ordered vCard as a structured contact card with all captured properties, resolution/source status, and an individual source-or-constructed `.vcf` download action.
- [x] 9.3 Remove the redundant structured-mention count footer while preserving original text, resolved blue inline formatting, unresolved tokens, search, evidence, and identity behavior; add link-preview regression coverage with no visual/data change.
- [x] 9.4 Generalize the edit-history dialog to backup and live events, showing original send time plus every available edit time, held versions when present, and an explicit “Original text unavailable” entry for metadata-only history.
- [x] 9.5 Add a deletion-detail dialog showing send/delete times, elapsed duration when both exist, verified actor/admin/kind, source observations, and retained-versus-never-captured content state without inferred values.
- [x] 9.6 Replace source-interpretation capture footers with accessible expandable controls for full accessibility labels, complete transcripts, provenance, and ordered segment timing.
- [x] 9.7 Rework system-event summaries/details around explicit actor and affected roles; use “You” only for the exact owner role, show “Unknown/Unresolved contact” for missing roles, and expose complete retained local detail for verified and generic events.
- [x] 9.8 Share accessible dialog/disclosure behavior across edit, delete, transcript, vCard/location, and system details; lazy-load full payloads, preserve keyboard/focus behavior, and keep long-thread pagination bounded.
- [x] 9.9 Scope each detail dialog to the signal family the user opened, make generic chips explicitly unclassified, show send/edit/delete facts with second precision, and present metadata-only edit history chronologically without fabricated timestamps or text.

## 10. Convergence, Regression, And Safety Verification

- [x] 10.1 Add SQLite/in-memory merge matrices for every structured family in backup-first and live-first order, asserting identical canonical facts, retained per-source observations, no null clobbering, and no false time-window deduplication.
- [x] 10.2 Add real-shape Baileys tests for numeric/named stubs, structured participant objects, authors, number changes, add/remove/join/leave/promote/demote, subject/description/settings, and unresolved identities.
- [x] 10.3 Add backup system fixtures proving actor/participant role correctness and specifically proving ambiguous `is_me_joined` rows never become owner actions.
- [x] 10.4 Add vCard tests for multi-card order, complete property display, source downloads, safe constructed downloads, line folding/escaping, filenames/headers, unknown extensions, and LID/insufficient-data refusal.
- [x] 10.5 Add static/live location tests for every supported backup/Baileys field, ordered observations, merge behavior, compact-card distinction, and no automatic map/link fetch.
- [x] 10.6 Add edit/delete tests covering separate send/edit/delete timestamps, multiple live revisions, metadata-only backup placeholders, missing timestamps/actors, held content, and dialog timelines.
- [x] 10.7 Add transcript/accessibility, mention-footer removal, unchanged link-preview, lazy detail, responsive layout, keyboard, focus, and long-thread visual tests.
- [x] 10.8 Add privacy canaries proving complete values are returned by their focused local detail/download routes but never appear in status, doctor, logs, warnings, unrelated list responses, exports, or remote-model evidence.
- [x] 10.9 Run `npm test`, `npm run doctor`, and `npm run build`; inspect the local UI with synthetic known/self/unresolved system roles and clean up only isolated test artifacts.
- [x] 10.10 Add focused-rendering regressions proving system/location/vCard/deletion/transcript views cannot leak unrelated edit history, and verify representative private archive records repeatedly in Chrome.

## 11. Documentation And Private Phase Gates

- [x] 11.1 Update architecture, import/data-model, security/privacy, testing, and limitations docs with compact-versus-detail contracts, source observations, vCard downloads, rich locations, edit/delete/transcript dialogs, and role-correct system decoding.
- [x] 11.2 PHASE GATE (user): with the server stopped and a restore point available, re-import the private real backup and spot-check number changes, known/unresolved group actors, static/live locations, multi-vCards/downloads, mentions, previews, edits, deletions, transcripts, and aggregate rows locally.
- [x] 11.3 PHASE GATE (user): run or observe safe live events where practical and verify participant author/subject roles, number-change variants, group metadata, live-location fields, edit/delete timing, and backup/live convergence without duplicate timeline entries.
- [x] 11.4 PHASE GATE (user): regenerate a small real-chat sample and verify bounded mention/location/link/edit/delete/source-interpretation evidence, unchanged citations, and no raw receipt or newly owner-visible detail leakage into remote-model input.

## 12. Owner-Facing Polish Follow-Up

- [x] 12.1 Portal edit/detail dialogs to an opaque top-level surface and remove inherited deleted-bubble opacity so background thread content cannot show through popup content.
- [x] 12.2 Suppress WhatsApp-generated “N contacts” body text when structured vCard cards are present and no real caption exists.
- [x] 12.3 Render every system-event identity as `name → complete phone number → Unknown`, never treating LIDs or other internal identifiers as user-readable identities.
- [x] 12.4 Reuse the existing Deleted state chip as the deletion-detail trigger and remove the additional “Deletion details” control; keep deleted media out of grouped grids so the chip remains individually actionable.
- [x] 12.5 Add focused regressions, run full verification, and visually inspect the real vCard, system-event, and deletion samples in Chrome on port 5900.
- [x] 12.6 Suppress generated static/live location labels when the structured location card replaces them, preserve genuine text/captions, and verify the real live-location sample.
