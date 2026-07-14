## Context

The archive currently preserves only `quotedSourceMessageId` on a reply. For modern Android backups that value is derived from `message.quoted_message_row_id`; the importer does not read the self-contained snapshot in `message_quoted` or its companion tables. Live normalization has the same loss: it retains Baileys `contextInfo.stanzaId` but discards `contextInfo.quotedMessage`, `participant`, and cross-chat `remoteJid` on both real-time and history-sync messages. Evidence assembly can therefore resolve a quote only when the original message can be found by a same-chat lookup. That path truncates the original to 80 characters and cannot recover out-of-window, deleted, or cross-chat *Reply Privately* antecedents. `MessageListItem` likewise exposes no quote data, so the thread UI cannot render a quoted-message preview.

This change crosses the defensive backup parser, Baileys live normalizer and maintainer, durable and in-memory repository adapters, brain evidence rendering and episode staleness, the messages API, and the React thread view. All captured content remains in the local archive under the existing privacy rules. Modern Android is the verified backup schema; Baileys v7's installed protocol types and send path confirm the live envelope. Legacy Android/iOS support and live payload variants must remain best-effort and must never make an otherwise valid message fail ingestion.

## Goals / Non-Goals

**Goals:**

- Capture a reply's complete, chat-local quoted snapshot, including text and the available media/location/vCard/mention companions, without truncating stored text.
- Capture the available one-level quoted snapshot from both real-time and history-sync Baileys messages into the same archive shape.
- Preserve current idempotent and defensive import behavior when snapshot tables or columns are absent.
- Render referents in evidence using an in-pack citation alias first, otherwise the full captured snapshot as non-citable context, with the existing pointer/generic paths retained as fallbacks.
- Resolve quoted senders through the same pack-local identity and provenance rules as message senders and reactors.
- Make quote capture late-binding: a later re-import or live observation can enrich an existing reply and select affected current episodes for regeneration.
- Show an offline WhatsApp-style quote preview in the thread UI, with display-only truncation, expansion, and a jump to an archived same-chat original.

**Non-Goals:**

- Indexing quoted snapshot text for lexical or semantic search; `retrieval-hardening` owns that decision.
- Creating `replies_to`, `responds_to`, or commitment-resolution graph edges.
- Treating an out-of-pack snapshot as an independently citable message.
- Fetching quote media or other data from WhatsApp or any remote service.
- Recursively retaining a quoted message's own reply context or enqueueing the quoted media object for live download.
- Cross-chat navigation to a *Reply Privately* original.
- Claiming universal legacy Android or iOS coverage before representative schemas and synthetic fixtures exist.

## Decisions

### 1. Store one durable snapshot record per reply

Add a `message_quoted_snapshots` table keyed one-to-one by the archived reply message. It stores the quoted `key_id`, existing source-row/pointer identity, optional quoted source-chat JID, sender JID, owner/from-me state, nullable timestamp, message type/raw type, full text and caption, media MIME/name/thumbnail, and JSON fields for structured location, vCard, and mentioned-JID payloads. The reply remains the owning record; a snapshot is context embedded in that reply, not a second archive message and not a citation target.

The shared `MessageRecord` model gains a nullable `quotedSnapshot`, and the repository writes the message before upserting its snapshot regardless of whether the source is backup or live. Merge semantics are monotonic: newly populated snapshot fields enrich existing fields, an absent source snapshot does not erase captured data, and exact text is never shortened locally. Rekey/collapse and archive-clear paths move or delete the owned snapshot with the reply. The in-memory repository mirrors the same behavior for tests.

This dedicated table is preferred over widening `messages` because the snapshot family contains optional blobs and structured payloads used only by replies. It is preferred over recreating quoted snapshots as normal messages because snapshots have no chat membership of their own and must never accidentally become searchable, visible, or citable as raw messages.

### 2. Normalize backup and live envelopes into the same snapshot contract

For modern Android, the parser inspects `message_quoted` and each known companion (`message_quoted_media`, `message_quoted_location`, `message_quoted_vcard`, and `message_quoted_mentions`) before selecting only columns that exist. It builds bounded lookup maps keyed by the quoted row id and attaches snapshots while streaming `message` rows, avoiding a query per message. Sender row ids resolve through the existing JID map. Structured fields retain only explicitly mapped values; unknown source columns are not dumped into logs or public API responses.

Legacy Android or iOS adapters capture the same archive shape only when their inspected schema exposes a known equivalent. Otherwise they continue producing the current pointer-only `MessageRecord`. A malformed companion row produces a scoped import warning and loses only that companion, not the reply or the import.

This adapter-specific mapping is preferred over fixed joins because WhatsApp backup schemas vary and a missing optional table must not invalidate the main message query.

For live ingestion, generalized context discovery reads `contextInfo` from any supported visible content type, not only `extendedTextMessage` and the five current media kinds. When `quotedMessage` is present, the normalizer unwraps its outer future-proof envelope once, applies the existing live text/caption/type/structured-content helpers, captures only the embedded thumbnail bytes, and stores `stanzaId`, `participant`, and optional `remoteJid`. It deliberately does not recurse into the quoted content's own context or create a media-download descriptor. If `quotedMessage` is absent, `stanzaId` continues to populate the pointer-only fallback.

The same code path handles `messages.upsert` and `messaging-history.set`. Quoted sender and source-chat JIDs are canonicalized first by the Baileys adapter resolver and again by the maintainer after identity links learned in that event, matching ordinary message identity behavior. Owner labelling uses the captured owner/from-me state when supplied by backup, otherwise the live quoted participant is compared with the linked-device identity at projection time. Because live `ContextInfo` has no quoted timestamp, that field remains null unless a matching archived original supplies it later.

Reusing the one snapshot contract is preferred over a live-specific table because backup and live observations of the same reply can then enrich one record idempotently and every downstream consumer remains source-agnostic.

### 3. Expose one resolved quote shape to evidence and thread consumers

Add a shared `QuotedMessageSnapshotSummary` containing the original key/pointer, quoted source chat when known, same-chat archived original message id when resolvable, resolved sender/owner label plus provenance, message type/interpretation, full text/caption, nullable timestamp, and compact structured/media metadata. `MemoryEvidenceMessage` and `MessageListItem` each receive a nullable quote summary. SQLite projects it with left joins and contact-label resolution; the memory adapter derives the equivalent result.

The API returns only locally stored metadata. A dedicated local thumbnail endpoint keyed by the reply message id serves a captured quote thumbnail when present, rather than embedding blob data in paginated JSON. No endpoint reaches the network.

One server-side projection is preferred over client-side table knowledge so evidence and UI consumers agree on sender labels, interpretation, and whether an original is actually jumpable.

### 4. Render evidence with an explicit four-tier policy

For every reply, evidence assembly resolves the referent in this order:

1. If the quoted key/pointer identifies another message in the same pack, render that message's alias and the existing compact snippet. The referent is citable through that real message alias.
2. Otherwise, if a captured snapshot exists, render its resolved sender and complete text/caption with no character cap. If the snapshot is non-text, render deterministic context from its media, location, or vCard fields. This annotation receives no alias and is non-citable.
3. Otherwise, retain the bounded same-chat `resolveQuotedReferents` lookup for older pointer-only imports.
4. If none resolves, render the honest generic earlier-message fallback.

Quoted snapshot content stays inside the existing untrusted-message fences. Thumbnail bytes are never sent to a model. The proposal's uncapped-text decision is intentional: quote completeness wins over a separate quote character budget, while message-count/span bounds and output density budgets remain unchanged.

This keeps valid in-pack citations and pointer-only source compatibility while making the self-contained backup-or-live snapshot the authoritative out-of-pack source.

### 5. Treat quoted senders and snapshot presence as late-bound evidence inputs

The pack labeler includes quoted sender JIDs before collision disambiguation. Saved-name, push-name, owner, phone-token, and unresolved-identity rules therefore apply identically to ordinary senders, reactors, and quoted senders. Quoted senders contribute to `unresolved_participants` and `push_name_participants` episode stamps even though their snapshot annotation is not citable.

Add an episode `quoted_reply_anchors_json` stamp computed mechanically from the pack. Each entry records the reply's source message key, quoted source chat/key when known, and whether a captured snapshot was present. When a re-import or live event changes a stamped reply from missing to present (or enriches its snapshot), the repository marks matching current episodes stale and enqueues exact-window regeneration. This reverse link is necessary because an evidence-pack message need not have been cited by the resulting episode.

`EXTRACTION_VERSION` is bumped when the renderer lands. The existing regeneration path upgrades all pre-change current episodes; the anchor stamp handles later snapshot enrichment without relying on another global version bump.

### 6. Keep UI truncation and navigation display-only

`MessageBubble` renders the quote preview above the reply's own media/text. It shows the resolved quoted sender and either the text/caption or a deterministic kind label with available thumbnail/context. CSS line-clamps long text and shows an ellipsis; an explicit show-more/show-less control toggles the full locally held preview without changing storage or evidence.

When the server resolves an archived original in the same chat, the preview itself is an accessible, keyboard-operable jump target using the existing `/chats/:id?at=<messageId>` route. It gains a subtle hover/focus treatment and pointer cursor without a visible jump button. The independent show-more/show-less control remains separate so text expansion does not navigate. That route already loads an anchor-centered window, so jumps work even when the original is outside the currently loaded page. Cross-chat and deleted/unarchived originals remain readable but non-interactive, with no fabricated target, hover treatment, or pointer cursor.

## Risks / Trade-offs

- **[Uncapped quoted text can enlarge a model prompt]** → Preserve the explicit product decision, keep normal pack message/span bounds, record token usage, and cover very long quotes in prompt tests so the impact is visible.
- **[WhatsApp source schemas vary]** → Gate every table/column through schema inspection, use synthetic versioned fixtures, warn per unsupported companion, and fall back without aborting import.
- **[Baileys context placement varies by message type]** → Discover `contextInfo` across supported visible content records, share wrapper handling with ordinary normalization, and cover text/media/contact/location plus real-time/history fixtures.
- **[Live quoted identities can arrive as LIDs or the linked user's device JID]** → Canonicalize quoted sender/source-chat identities at both resolver stages and derive owner labelling from the linked-device identity without persisting a guessed contact name.
- **[Thumbnail blobs increase archive size]** → Store only WhatsApp's embedded quote thumbnail, never fetch full media, and omit blob bytes from normal list/evidence queries.
- **[A later snapshot can change already-derived knowledge]** → Stamp reply anchors on episodes, stale and enqueue exact-window regeneration on enrichment, and bump the extraction version for the initial rollout.
- **[Quoted text could be mistaken for a citable source]** → Never allocate an alias to a snapshot; prompt wording and tests state that only real pack messages are citable.
- **[Identity repair can miss a quoted-only participant]** → Feed quoted sender JIDs through the same labeler and commit-stamp sets before generation, then reuse deterministic identity repair.
- **[Duplicate keys can point across chats]** → Resolve UI jump targets only within the reply's chat; use quoted `key_id` plus the existing pointer as candidates and never guess with timestamp/text similarity.

## Migration Plan

1. Add the quoted snapshot table, episode anchor-stamp column, indexes, archive-clear ordering, and tolerant startup migration. No archive wipe is required.
2. Extend shared records plus both repository adapters, then add defensive backup capture and idempotent upsert/rekey behavior.
3. Add one-level live capture for real-time/history messages, generalized context discovery, and nested identity canonicalization.
4. Extend evidence and thread projections, bump `EXTRACTION_VERSION`, and add snapshot-first rendering and staleness propagation.
5. Add the quote preview UI and local thumbnail route.
6. Re-import a supplied backup to populate historical snapshots, observe new live replies directly, then run `brain regenerate` to replace stale-version episodes. All paths remain resumable/idempotent.

Rollback leaves the additive snapshot data in place so a later rollout can reuse it. Older application code ignores the extra table/column; already regenerated episodes remain valid local derived data, while no watermark rollback is needed.

## Open Questions

None block implementation. Additional legacy Android/iOS table mappings and unobserved Baileys payload variants should be added only alongside representative synthetic or explicitly opted-in local traces; absence of those mappings follows the specified pointer/generic fallback.
