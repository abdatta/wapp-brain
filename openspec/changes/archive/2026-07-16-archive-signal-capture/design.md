## Context

The Android importer intentionally reads only tables it understands, but a modern `msgstore` audit found populated source tables whose structured meaning is currently dropped. Some live equivalents already reach the archive through normalized messages, group events, targeted updates, explicit mentions, and link previews, so the result is source-dependent behavior: a historical backup can contain the same fact as live sync without producing the same durable archive state.

The affected signals span message attachments, identity and group history, edit/delete provenance, media interpretation, and relationship-strength inputs. They cross parser inspection, repository contracts, SQLite and in-memory adapters, live normalization, evidence assembly, and extraction-version regeneration. Source schemas vary by WhatsApp version and platform, and every optional table or column must therefore remain a best-effort enrichment rather than an import prerequisite.

The archive is local-first. Raw receipts, decrypted source rows, vCards, coordinates, transcripts, and other captured content must remain inside the private workspace and must not appear in logs, diagnostics, status responses, or exports by accident. Existing archive messages and media are sacred; derived brain state can be regenerated.

## Goals / Non-Goals

**Goals:**

- Capture each proposal signal from modern Android backups without making legacy Android or iOS imports fail.
- Give backup and live observations one canonical, idempotent repository shape keyed by stable message, chat, and identity anchors.
- Preserve structured source fidelity and provenance without burying consumer-critical fields in opaque JSON.
- Let the archive owner inspect and download complete locally retained message details without authorizing remote transfer.
- Keep actor, affected participant, identity endpoints, and chat roles distinct so system-event language never changes who performed an action.
- Store engagement measures as bounded aggregates while never persisting the source receipt population.
- Render evidence-visible signals deterministically, stamp their dependencies, bump `EXTRACTION_VERSION`, and regenerate old episodes.
- Keep identity merges repairable by storing canonical JIDs and rekeying every identity-bearing signal.

**Non-Goals:**

- Build person auto-connect, graph edges, retrieval ranking, or chat ranking; changes #5, #8, and #9 consume the captured data.
- Interpret image, audio, video, or document bytes with a model, or spend tokens to create new transcriptions.
- Fetch link targets, vCard resources, map data, profile photos, or any other remote enrichment.
- Preserve the approximately 480k raw backup receipt rows in the Wapp Brain archive.
- Guarantee identical table names for every WhatsApp version; unsupported layouts remain visible as scoped warnings.
- Add a public export surface for the new private signals.

## Decisions

### 1. Separate source readers from canonical signal writes

`parser.ts` will inspect optional source tables and produce typed signal batches alongside messages rather than attaching every new field to `rawMetadata`. The importer will write messages first, then signal batches through explicit `ArchiveRepository` methods in the same import run. Live normalization will emit the same canonical records for equivalent platform events.

This keeps schema-specific column aliases at the import boundary, lets the in-memory and SQLite adapters share a testable contract, and prevents consumers from learning WhatsApp table layouts. A single generic JSON event table was rejected because it would push parsing into identity, graph, evidence, and ranking consumers.

### 2. Use stable anchors, source provenance, and monotonic enrichment

Message-bound records use `source_message_key`; chat history uses canonical `chat_source_id`; identity-bearing values use canonical JIDs. A canonical fact is separate from its source observations. Each observation carries `source` (`backup` or `live`), source row/event key, available source message anchor, observed time, and capture schema version. Re-import and replay upsert the same canonical fact, append or enrich its idempotent observation, fill missing fields, and never replace a populated value with null.

The preferred cross-source key is the canonical WhatsApp message key plus signal family/index. Unanchored notifications use a conservative semantic fingerprint over verified event kind, chat, role identities/value, and exact normalized source time. The implementation will not use a broad time-window dedupe. If a later backup provides a real message anchor for a fact first observed through a synthetic live anchor, it rebinds the canonical fact and timeline identity while preserving both observations.

Identity merge rekeys mentioned identities, number-change endpoints, membership periods, vCard JIDs, revoke actors, and engagement identity scopes through the existing `mergeIdentity` transaction. Keeping display names only as presentation metadata preserves late resolution.

### 3. Normalize the durable archive shape by signal family

The SQLite adapter will add focused local tables and mirror them in `MemoryArchiveRepository`:

- `identity_number_changes`: source event/message key, old JID, new JID, actor/chat, occurred time, provenance.
- `group_membership_periods`: group JID, participant JID, join/leave bounds, role/admin rank, source row key, provenance.
- `group_membership_events`: add/remove/join/leave/invite/accept/promote/demote actions decoded only when affected participant and action semantics are structurally verified.
- `chat_metadata_history`: subject, description, photo, invite-link, announcement/restriction, member-add, join-approval, or disappearing-setting events with distinct actor, old/new value when available, and time.
- `message_locations` plus ordered observations where needed: coordinates, place name/address, URL/comment/caption, live flag, accuracy, speed, heading, sequence, time offset, share duration/final time, observation time, and embedded-thumbnail availability.
- `message_vcards`: ordered cards with display name, lossless raw vCard text, parsed properties/parameters, resolved JID hints, and source-versus-constructed download state.
- `message_deletions`: revoke actor/time/source while `messages.is_deleted` remains the fast current-state projection.
- `message_edit_events`: original key, observed edit key and timestamp, independent of held prior-content revisions.
- `message_media_interpretations`: accessibility label or source transcription segments with provenance and ordering.
- `engagement_aggregates`: chat plus optional counterparty identity, sample counts, read rate, median response latency, bounds, and computation version.

The existing `message_mentions` and `message_link_previews` tables remain the canonical stores for those families. `message_mentions` gains source provenance so authoritative structured mentions can coexist with text-token fallback derivation. `message_edit_revisions` remains only for prior body/caption content actually held; metadata-only backup edits go to `message_edit_events` and still participate in a timeline with an explicit unavailable-content entry. A small generic `archive_signal_observations` companion (or equivalent typed observation tables) preserves both source observations without duplicating canonical payloads.

### 4. Discover optional backup schemas defensively and stream large inputs

Each reader requires only its minimal join columns, selects only columns present in `SQLiteInspection`, and recognizes documented aliases. Missing tables or columns return an empty batch. A malformed optional row produces a scoped warning containing table, row identifier, and field names but no message body, vCard text, transcript, coordinates, key material, or raw row dump.

Small sidecars may be indexed in maps by message row id. Receipt, participant-history, and other high-cardinality tables must be streamed or aggregated in SQL and must not be loaded wholesale into JavaScript memory. One failed optional family loses only that family, not message import or another signal family.

### 5. Treat structured mentions as authoritative and regex mentions as fallback

Backup `message_mentions`, quoted mention rows, and live `mentionedJid` metadata are canonicalized before storage. Text-token `@digits` extraction remains as a compatibility fallback. A mention row records whether it was observed structurally, derived from text, or both; re-import can upgrade a fallback mention to authoritative without duplication.

Ordinary and quoted mentions keep their current ownership distinction: ordinary mentions join `message_mentions`, while quoted mentions remain on the reply-owned snapshot. This avoids making quoted context independently searchable or citable.

### 6. Capture structured attachments without remote lookups

Backup locations and vCards become message-owned rows. VCard JIDs are resolved only from source joins or already-known local identity links. VCard parsing is lossless and presentation-oriented: every property, parameter, and unknown extension remains available, but none creates a speculative person merge. A download serves source card content when held; a minimal card may be constructed only from a trusted display name plus phone-form identity and is visibly marked constructed. LIDs are never emitted as phone numbers. Backup link-preview title, description, canonical URL, and embedded thumbnail continue through the existing `message_link_previews` upsert used by live sync.

Location normalization retains the union of verified Android sidecar columns and installed Baileys `LocationMessage`/`LiveLocationMessage` fields. A point attachment and a sequence of live observations are distinct concepts: stable metadata stays on the attachment, while sequence/time-bearing samples remain ordered and deduplicated by source sequence/time. No renderer may automatically fetch a URL, map tile, contact photo, or preview. Embedded thumbnails stay local and are excluded from model evidence. Multiple vCards are ordered rather than collapsed to one record.

### 7. Preserve edit and deletion honesty without fabricating history

An edit has distinct facts: original send time, an edit event time, current content, and prior content that may or may not be held. Backup `message_edit_info` records the event using the canonical original key and available timestamps; it records a revision only when source content for that revision exists. Live updates continue snapshotting held content before overwriting it. Both feed one server-built timeline. Metadata-only backup events create a display entry labelled “Original text unavailable,” not a fake revision row. Revoke metadata records who, when, and admin/kind when the source provides them, while the message row remains the content-preserving tombstone projection.

Newest-state-wins compares observed timestamps when available and otherwise uses monotonic enrichment. An older backup cannot erase a newer live edit, held content, revoke actor, or revoke time.

### 8. Aggregate engagement at the import boundary and discard raw receipts

Receipt readers compute aggregates directly from the source database. The durable row contains eligible outgoing count, delivered/read counts, read-rate numerator and denominator, response-latency sample count and median, time bounds, and algorithm version. Read rate is calculated per chat and, where a recipient JID exists, per chat/counterparty. Response latency uses the next visible incoming exchange from that identity after an outgoing exchange in the same chat, bounded to seven days; sample counts are retained so consumers can discount weak estimates.

Raw receipt/device identifiers, individual timestamps, and receipt payloads never enter `MessageRecord`, repository batches, warnings, import totals, DTOs, logs, exports, or diagnostics. Re-import replaces an aggregate only when its source coverage/version is newer or more complete. Persisting raw receipts for future flexibility was rejected because current consumers need relationship-strength signals, not surveillance-grade history.

### 9. Store source-provided media interpretation as labelled provenance

`accessibility_label`, `raw_transcription_text`, and ordered `transcription_segment` rows are stored as source-provided interpretations. They are never presented as Wapp Brain model output. Empty or duplicate segments are dropped; full text is retained locally without logging. Evidence renders explicit provenance such as `[WhatsApp accessibility label: ...]` or `[WhatsApp transcript: ...]` and does not send thumbnail bytes.

These labels reduce the uninterpreted-media debt for the affected message but do not erase existing D13 media-gap rows until episode regeneration commits under the new extraction version.

### 10. Render signal annotations on their owning citable message

The evidence query will return ordinary mentions, location, vCards, link preview, edit/deletion metadata, and source media interpretations with each visible message. `episodes.ts` renders bounded, deterministic annotations inside the untrusted-message fence. The owning message keeps its one citation alias; attachments and state annotations never receive independent aliases.

System events and group-history rows remain excluded from evidence packs under the visible-exchange rule. Their durable rows are for identity and graph consumers, not token budget. Deleted messages preserve any held text/caption/media and add a deletion annotation; a contentless tombstone renders the existing honest deleted placeholder. Link-preview thumbnails and other binary content never enter prompts.

### 11. Stamp evidence-visible dependencies and regenerate by extraction version

Episode commits gain `archive_signal_anchors`: for each evidence message with captured signals, the source message key, signal kinds, and capture version. This is a reverse-link surface for later enrichment. Archive rows themselves retain provenance and capture version, so number-change and chat-name history have stable anchors even though they do not enter evidence packs.

The evidence change bumps `EXTRACTION_VERSION`. `brain regenerate` selects older episodes through the existing durable regeneration path, replaces them transactionally, leaves watermarks unchanged, and recomputes media-gap and late-binding stamps. Re-import that enriches a signal on a cited message marks dependent episodes stale; import of a previously absent family does not trigger model work until the user runs or schedules regeneration.

### 12. Keep private fields off general read surfaces

Keep paginated message reads compact, but do not use redaction as a boundary against the archive owner. A focused loopback-only message-detail endpoint exposes complete retained locations, vCards, mention identities, edit/delete provenance, source interpretation text, and system fields for one message. Dedicated local binary/text endpoints serve vCard downloads and retained thumbnails. Engagement aggregates remain repository-internal until a ranking consumer is implemented.

Full source content remains excluded from status, doctor, warnings, logs, import progress, and unrelated responses. Remote-model evidence keeps its separate bounded allowlist and gains no implicit authorization from the local detail endpoint. Tests place canaries in receipts and each full-detail family to prove that local detail returns the value while diagnostic and remote paths do not.

### 13. Build compact summaries and complete details from the same server model

`MessageListItem` remains the bounded pagination shape and adds only detail-availability flags/counts needed to render controls. `MessageDetail` is assembled server-side from the same canonical repository records and returns complete owner-visible fields. The client never queries raw SQLite or reinterprets WhatsApp table/stub codes. This avoids loading large transcripts/vCards into every thread page while ensuring the compact and expanded views cannot disagree about kind, identity, or availability.

Routes are scoped to one local message id and validate that the message exists. VCard download routes are card-indexed, use `text/vcard; charset=utf-8`, sanitize `Content-Disposition` filenames, and distinguish source from constructed bytes. No new public binding, authentication bypass, export bundle, or remote service is introduced.

### 14. Treat system events as role-bearing facts, not sender-shaped messages

The system decoder produces a role-bearing intermediate form: `eventKind`, `actorJid`, `affectedParticipantJids`, `oldJid`, `newJid`, `chatJid`, old/new values, event time, raw stub/action type, raw parameters, and confidence/verification source. Rendering is then mechanical. Add/remove/promote/demote use the actor as grammatical subject and affected participant as object; join/leave use the affected participant as subject; number-change wording uses the affected identity, not an arbitrary actor fallback.

Backup readers require a verified participant join or structurally documented action mapping. `message_system_group.is_me_joined` alone does not identify the affected participant and can no longer emit a `participantJid: "me"` fact. Message sender is accepted as actor only for a source table/stub whose semantics define it that way.

For live sync, use the installed Baileys `WAMessageStubType` numeric enum plus names, not a test-only string. Parse structured participant JSON, retain `author`/`authorPn`/`authorUsername`, distinguish `GROUP_PARTICIPANT_CHANGE_NUMBER` and `INDIVIDUAL_CHANGE_NUMBER`, and consume direct `group-participants.update`/`groups.update` author and value fields. Unknown stubs retain a generic chip and full local raw detail.

### 15. Present structured attachments as message-native UI

Locations and vCards render as cards inside their owning message bubble, preserving the message timestamp, sender, reply context, deletion/edit state, and citation identity. The location summary shows its kind plus most useful place/time facts; expansion reveals the full field set. VCards show a concise contact header and property list with individual download actions. Inline mention highlighting remains in body/caption, so the separate count footer is removed.

Source interpretations use a shared disclosure/dialog pattern with keyboard focus, escape/backdrop close, accessible labels, and lazy detail fetch. Dialogs portal to the document surface rather than remaining descendants of message bubbles; their opaque background and overlay therefore cannot inherit deleted-message opacity or a bubble stacking context. The shared shell does not imply shared content: each control passes an explicit location, vCard, deletion, interpretation, or system focus so unrelated signal families—and especially edit history—cannot appear in the opened view. Edit and deletion dialogs use a seconds-and-year time formatter and explicit unknown states. Edit history is chronological, identifies the source edit record, and never substitutes send time when edit time is unavailable. The Deleted chip owns deletion-detail disclosure just as the Edited chip owns edit history. Existing link-preview cards remain untouched except for regression coverage.

For system-event identity, presentation uses a strict human-readable chain: owner role → “You”; otherwise saved/push name → complete phone number derived only from a phone-addressed JID or stored phone field → “Unknown.” LIDs, group JIDs, broadcast IDs, and synthetic tokens are retained in technical details but never rendered as people. Structured vCard cards replace WhatsApp-generated count bodies such as “2 contacts” when no caption exists, and structured location cards replace generated “Location” or “Live location” labels. Both avoid duplicate message content while leaving real authored text and captions untouched.

### 16. Preserve cross-source evidence and choose field winners deterministically

Canonical payload and source observation are separate. Field resolution follows documented rules:

- identical non-null values coalesce and keep both observations;
- null never erases non-null;
- source-native exact payloads (raw vCard, transcript segment, raw stub parameters) stay attached to their observation instead of being overwritten;
- event/state timestamps use the platform event timestamp when present, then source message time, and never import/current time as a semantic fallback;
- current scalar projections choose the newest verified event, while history retains all distinct events;
- location samples deduplicate by message plus sequence/time/fingerprint, not a loose time window;
- later real message anchors supersede synthetic anchors for presentation while preserving stable canonical ids and observations.

Tests run every merge pair in backup-first and live-first order and compare canonical records and rendered DTOs. Persisting a single `source` column as the winner was rejected because it loses how complementary facts were obtained and makes later repair hard to audit.

## Risks / Trade-offs

- [Source schema drift] A WhatsApp update can rename a table or change a join. → Gate each family independently, preserve safe provenance, warn without content, and add fixture variants.
- [Incorrect system decoding] Numeric actions can be misclassified. → Require structural joins or verified fixtures; keep unknown actions as generic system events.
- [False owner attribution] Ambiguous backup flags or dropped live authors can render another participant's action as “You.” → Keep roles distinct, prohibit owner fallback, and test known/owner/unresolved permutations from both sources.
- [Cross-source over-deduplication] Similar events close in time could be collapsed. → Prefer shared message ids/exact semantic keys, preserve source observations, and never dedupe solely by a broad time window.
- [VCard content or filename injection] Source properties can contain folding, control characters, or unsafe names. → Preserve source content separately, escape only constructed cards, sanitize download filenames/headers, and render properties as text rather than HTML.
- [Large detail payloads] Long transcripts, many cards, or location samples could slow thread pagination. → Keep the list DTO compact and lazy-load one message's full detail with explicit UI expansion.
- [Archive growth] Transcripts, vCards, and histories add local storage. → Keep only source-provided content, deduplicate natural keys, and never duplicate raw receipts.
- [Aggregate ambiguity] Read rate and response latency can imply more certainty than samples support. → Store numerator, denominator, sample count, bounds, and algorithm version with every value.
- [Cross-source conflicts] Backup replay may be older than live state. → Use canonical keys, observed timestamps, source-aware monotonic upserts, and preserve richer existing values.
- [Identity rekey gaps] A new JID-bearing table could retain a stale LID after merge. → Centralize signal rekeying in `mergeIdentity` and test every identity column.
- [Prompt expansion] Rich annotations increase evidence tokens. → Bound per-field rendering, omit binary/raw vCard boilerplate, and preserve existing pack message/span limits.
- [Sensitive output] Coordinates, vCards, transcripts, raw system parameters, or receipt canaries could leak outside the intended local detail surface. → Use separate compact/detail/diagnostic allowlists and prove local detail returns the value while logs, status, exports, and remote evidence do not.
- [Regeneration cost] A version bump makes current episodes eligible for model work. → Use the existing explicit/budgeted regeneration path; archive capture itself performs no model calls.

## Migration Plan

1. Add repository types, focused tables/indexes, and in-memory parity without changing existing reads.
2. Add defensive backup readers and canonical signal batch writes; keep each family independently skippable.
3. Route equivalent live events through the same repository records and add identity-merge rekeying.
4. Extend local message/evidence reads and deterministic rendering, then bump `EXTRACTION_VERSION`.
5. Re-import synthetic modern and legacy fixtures; verify idempotency, stale-live protection, bounded memory, and privacy canaries.
6. With the server stopped and a restore point available, re-import the user-supplied real backup and perform the proposal checkpoint locally.
7. Run budgeted `brain regenerate` for selected chats first, inspect evidence, then regenerate broader derived state as desired.
8. Add source-observation storage and backfill one observation from each existing canonical signal row without changing current fact ids.
9. Expand backup/live readers and repair system roles; re-import/replay enriches existing facts and rebinds eligible synthetic anchors.
10. Add focused detail/vCard routes and compact availability fields, then implement structured cards and dialogs.
11. Run backup-first/live-first convergence matrices plus a one-time repair that removes only demonstrably false `participantJid = "me"` membership facts derived solely from ambiguous `is_me_joined` rows; uncertain rows revert to generic system events.
12. Re-run the private real-chat spot checks before broader brain regeneration.

Rollback removes the new readers and consumer paths while leaving additive archive rows harmless. The role-repair migration SHALL be transactional and create a restore point before changing existing event facts or synthetic anchors. If a new derived table shape is wrong, drop and rebuild only that derived signal/observation table from the user-supplied backup. Existing messages, contacts, chats, media, and source files are never deleted. Older episodes remain valid but lack the new annotations until regeneration.

## Open Questions

- Confirm each Android action-code mapping against a safe synthetic fixture and aggregate-only inspection of the user's audited schema before enabling it; unconfirmed codes remain generic.
- Confirm whether modern backups expose more than one edit event or live-location observation per message; the canonical model supports multiples but never fabricates them.
- Choose the final compact-card breakpoints and default collapsed transcript height through visual testing; these do not change the complete detail contract.
