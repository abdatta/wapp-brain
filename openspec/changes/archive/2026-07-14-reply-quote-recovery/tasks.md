## 1. Snapshot Model And Archive Schema

- [x] 1.1 Add shared import/live, evidence, thread-summary, and episode-anchor types for a nullable quoted snapshot, including full text, quoted sender/source-chat identity, owner state, nullable timestamp, structured companions, and same-chat original id.
- [x] 1.2 Add the one-to-one `message_quoted_snapshots` table, quoted-reply episode stamp column/indexes, tolerant startup migration, archive table accounting, and delete ordering without requiring an archive wipe.
- [x] 1.3 Extend SQLite message upsert/rekey/collapse paths to insert or monotonically enrich owned snapshots from backup or live observations, preserve complete existing fields when a source omits them, and delete snapshots with their reply.
- [x] 1.4 Mirror snapshot ownership, cross-source monotonic merge, rekey behavior, and episode anchor state in the in-memory repository.

## 2. Defensive Backup Capture

- [x] 2.1 Add synthetic modern Android fixtures for long text quotes and the `message_quoted_media`, `message_quoted_location`, `message_quoted_vcard`, and `message_quoted_mentions` families, including malformed and absent-table variants.
- [x] 2.2 Inspect the modern quoted tables/columns defensively, prebuild quoted-row sidecar maps, resolve quoted sender/source-chat and owner metadata, and attach the complete snapshot while streaming replies without per-message queries.
- [x] 2.3 Map quoted media captions/MIME/embedded thumbnails plus structured location, vCard, and mention values without logging raw content or unknown source columns.
- [x] 2.4 Preserve pointer-only import for unsupported legacy Android/iOS schemas and emit scoped warnings for malformed optional companions without dropping the reply or failing the import.
- [x] 2.5 Add parser/import integration tests proving untruncated capture, complete companion mapping, idempotent enrichment, and absent-snapshot fallback.

## 3. Live Sync Capture

- [x] 3.1 Generalize live `contextInfo` discovery across supported visible content types so reply metadata is not limited to extended text and the current media subset.
- [x] 3.2 Normalize one-level Baileys `stanzaId`, `participant`, optional `remoteJid`, and `quotedMessage` into the shared snapshot on both `messages.upsert` and `messaging-history.set`, leaving unavailable quoted timestamps null.
- [x] 3.3 Canonicalize quoted sender/source-chat JIDs in the Baileys resolver and maintainer event-canonicalization pass, and resolve the linked account to archive-owner identity without storing a guessed contact label.
- [x] 3.4 Reuse live text/caption/type/structured-content extraction for quoted content, capture embedded thumbnail bytes, strip nested quote context, and never create a quoted-media download descriptor.
- [x] 3.5 Add live normalization/maintainer tests for real-time text replies, history-sync media/location/contact replies, wrapper envelopes, *Reply Privately* `remoteJid`, owner quotes, LID mappings, duplicate observations, and pointer-only fallback.

## 4. Repository Read Models And Local API

- [x] 4.1 Extend SQLite thread and evidence queries to project the resolved quoted sender/owner provenance, quoted source chat, nullable timestamp, snapshot content, and a same-chat archived original id without cross-chat guessing.
- [x] 4.2 Mirror resolved quote projection in the memory repository and retain the bounded same-chat `resolveQuotedReferents` method for pointer-only fallback.
- [x] 4.3 Add a local quote-thumbnail endpoint keyed by reply message id, returning only the captured embedded thumbnail with the same safe content-type/cache behavior as other local media routes.
- [x] 4.4 Add repository and API tests for backup/live snapshot convergence, contact-label/push-name/owner provenance, same-chat original resolution, cross-chat non-resolution, local thumbnail delivery, and honest missing-context responses.

## 5. Brain Evidence, Identity, And Regeneration

- [x] 5.1 Include captured quoted sender JIDs in pack-local labelling, collision disambiguation, claim-entity lookup, unresolved-participant stamps, and push-name-participant stamps for both model and extractive episodes.
- [x] 5.2 Implement the evidence referent order: citable in-pack alias, full untruncated non-citable snapshot/structured description, bounded pointer-only same-chat lookup, then the generic earlier-message fallback.
- [x] 5.3 Record `quoted_reply_anchors` mechanically for every pack reply, including quoted source-chat/key identity and uncited replies, and persist/read them in both repository adapters.
- [x] 5.4 Detect snapshot insertion/enrichment during backup import or live ingestion, mark matching current episodes stale through their reply-anchor stamps, and enqueue deduplicated exact-window regeneration without advancing watermarks.
- [x] 5.5 Bump `EXTRACTION_VERSION` and add episode tests covering long out-of-window quotes, deleted originals, cross-chat *Reply Privately*, structured media/location/vCard context, non-citability, identity provenance, and pointer/generic fallbacks from both capture sources.
- [x] 5.6 Add regeneration tests proving older-version episodes and later-enriched backup/live snapshots are replaced transactionally while completed work remains resumable and watermarks remain unchanged.

## 6. WhatsApp-Style Thread Preview

- [x] 6.1 Add an accessible quoted-preview component above reply content with resolved sender/owner, text/caption or deterministic structured-kind context, and an embedded local thumbnail when held.
- [x] 6.2 Add WhatsApp-style tint/border styling, default line clamping and ellipsis, and explicit show-more/show-less controls that never mutate the stored or API-provided text.
- [x] 6.3 Make the preview itself an accessible, subtle-hover jump-to-original target using `/chats/:id?at=<messageId>` only when the server resolves a same-chat original; keep cross-chat/deleted snapshots readable without a fabricated target, hover effect, or pointer cursor.
- [x] 6.4 Add client tests proving backup-imported and live-synced snapshots render identically, including display-only expansion, local thumbnail URLs, same-chat jumps, pointer-only compatibility, and missing-context behavior.

## 7. Documentation And Verification

- [x] 7.1 Update importer/data-model, live-sync, architecture, privacy, limitations, and testing docs for unified local quoted-snapshot storage, defensive source coverage, non-citability, regeneration, and UI behavior.
- [x] 7.2 Run focused parser, live normalizer/maintainer, repository, brain, API, and client test suites, then run `npm test` and `npm run doctor`.
- [x] 7.3 Run `npm run build`, start the local app, and inspect backup/live text previews, long-text expansion, structured quote previews, same-chat jumping, and absent-snapshot fallback in the thread UI.
- [x] 7.4 With a user-supplied local backup when available, verify the *Reply Privately*, quoted-image, deleted-original, and `brain regenerate` checkpoints without logging or committing message content, keys, media, archive files, or generated brain data.
- [x] 7.5 With explicit user opt-in to a private local diagnostic trace, verify one real-time text reply and one history-synced or structured reply populate the unified snapshot; keep the trace under `.wapp-brain/` and never upload or commit it.
