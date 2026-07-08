## 1. Store & schema foundation

- [x] 1.1 Add a `media` path to config (`.wapp-brain/media/`) beside `archive.sqlite`; confirm `.gitignore` already excludes it.
- [x] 1.2 Create a content-addressed blob store module: write decrypted bytes atomically (temp file + rename) to a sharded path derived from `sha256(plaintext)`; expose put/exists/open-stream/stat.
- [x] 1.3 Add the `media_assets` table via the additive migration seam (`sqliteRepository.ts` migration section): `sha256`, `storage_path`, `mime_type`, `byte_size`, `width`, `height`, `duration_ms`, `thumbnail`, plus per-message linkage (canonical message key), `source` (`live-download`|`media-retry`|`import-folder`), `is_view_once`, timestamps. Dedupe assets by `sha256`.
- [x] 1.4 Add the `media_download_queue` table: message key, stored descriptor, `status` (`pending`|`downloading`|`stored`|`retry`|`expired_unrecoverable`|`failed`), `attempts`, `next_attempt_at`, `last_error`, `priority`; indexes for due/priority selection. Mirror the shape of `retained_encrypted_payloads`/`live_gap_windows`.
- [x] 1.5 Add repository methods: enqueue descriptor, claim a bounded due batch, mark stored/retry/terminal, link asset to message, look up asset(s) by message key.

## 2. Live descriptor capture

- [x] 2.1 In `normalize.ts`, extract the downloadable descriptor from the unwrapped inner media content (mediaKey, directPath/url, fileEncSha256, fileSha256, mediaKeyTimestamp, mimetype, fileName, size, dimensions/duration, embedded `jpegThumbnail`) for image/video/audio/document/sticker/ptv, covering view-once/ephemeral wrappers.
- [x] 2.2 Surface the captured descriptor on the live event so it reaches ingestion without being dropped (do not persist it on the `messages` row — carry it to the queue).
- [x] 2.3 In `baileysClient.ts` `messages.upsert` and `messaging-history.set` handlers, retain the raw media message reference needed for download (or a serialized descriptor) so download can run after normalization.
- [x] 2.4 In `maintainer.ts` ingest flow, enqueue a `media_download_queue` row for every media-bearing message; prioritize view-once and fresh media.

## 3. Download worker

- [x] 3.1 Implement a media downloader using Baileys `downloadContentFromMessage`/`downloadMediaMessage` (passive fetch + decrypt) that returns decrypted bytes and detected metadata.
- [x] 3.2 Add a media-download pass to the recovery tick (`maintainer.ts` loop): claim a bounded batch, download, hash, store the blob, write `media_assets`, mark the queue entry terminal; back off and retry transient failures to a cap.
- [x] 3.3 Persist the embedded `jpegThumbnail` as the asset thumbnail when present; fall back to a type marker (no native transcoder) when absent.
- [x] 3.4 Bound per-tick download concurrency and batch size; ensure media work cannot starve gap recovery / secrets passes.

## 4. Scoped media re-upload recovery

- [x] 4.1 Add an explicit, auditable allowance in `installReadOnlySocketGuards` for the media re-upload path only; keep `readMessages`/`sendReceipt(s)`/presence/sends/deletes/group/profile blocked.
- [x] 4.2 Wire `downloadMediaMessage`'s `reuploadRequest` to the media-retry path (`updateMediaMessage`), used only when a download fails due to an expired link.
- [x] 4.3 Bound re-upload attempts per message with backoff; mark `expired_unrecoverable` after the cap. Rate-limit re-upload requests per tick.
- [x] 4.4 Add a targeted test/guard asserting no read/played receipt is ever sent by the media layer, even during re-upload.

## 5. Retention across revoke/delete

- [x] 5.1 In `applyLiveMessageUpdates` delete/revoke branch, keep the message tombstoning but leave `media_assets` links and stored blobs intact.
- [x] 5.2 Ensure no code path evicts blobs on delete/revoke; add a test that a revoked message keeps its archived media.

## 6. Availability state & interpretation

- [x] 6.1 Compute a per-message media availability state server-side (`stored`|`downloading`|`pending`|`expired_unrecoverable`|`not_captured`|`import_missing`) from asset + queue state.
- [x] 6.2 Update `messageInterpretation` so view-once and other media reflect real availability (drop the fixed "Media is not kept in backups." reason when stored; honest reason otherwise).
- [x] 6.3 Extend the message DTO (`src/shared/types.ts`) with an asset reference (id/mime/size/dimensions/duration/thumbnail flag/is-view-once) and availability; populate it in the list and single read paths (`sqliteRepository.ts`).

## 7. Import media backfill

- [x] 7.1 In `parser.ts`, read the media sidecar tables (`message_media`, `message_view_once_media`, `message_thumbnails`) for file path, mime, size, and hash; stop nulling modern-adapter `media_mime_type`/`media_name`.
- [x] 7.2 In `importer.ts`, replace the validate-and-discard `mediaPath` handling with a direct server-side folder walk of the standard `Media/WhatsApp *` layout (Images, Video, Video Notes, Voice Notes, Audio, Animated Gifs, Documents, Stickers, Profile Photos, incl. `Sent`/date subdirs; skip unrelated dot/cache dirs; never follow symlinks outside the root) that matches each media message to a file (hash first via `message_media.file_hash`, then relative path/name), copies matches into the store, and links `media_assets` with `source=import-folder`.
- [x] 7.3 Emit privacy-safe import warnings and set `import_missing` for missing/unreadable/ambiguous media; never abort message import, and never abort on a bad/absent media-folder path.
- [x] 7.4 Confirm re-import remains idempotent (no duplicate assets; content-hash dedupe holds).
- [x] 7.5 Add a distinct media-ingestion phase to import job progress (files processed/matched/copied, warning counts) surfaced in the wizard and server terminal, matching the existing phase-progress style.
- [x] 7.6 Make the media-folder local-path input first-class in the wizard for large folders (recommended route, validated without aborting), keeping the picker upload for small selections.

## 7b. Deleted and edited message honesty

- [x] 7b.1 Change `interpretMessage` so deleted messages with held content keep that content exposed with the deleted state, producing the "Deleted message" placeholder only when nothing was captured.
- [x] 7b.2 Add an edit-revision store (canonical message key, revision order, content, edited-at) via the additive migration seam; snapshot current content before `applyEdit` overwrites it; expose `isEdited` + revision availability in the DTO and a revisions read API.
- [x] 7b.3 Surface backup `message_edit_info` as the edited flag on imported messages (no fabricated history).

## 7c. Link previews

- [x] 7c.1 Capture embedded link-preview data (title, description, canonical URL, `jpegThumbnail`) from live text messages at descriptor-capture time and store the thumbnail bytes with the message; no remote fetching.
- [x] 7c.2 Expose stored link-preview data on the message DTO.

## 8. Local serving endpoints

- [x] 8.1 Add loopback-bound endpoints beside the message routes in `server.ts`: stream original media by message/asset key with HTTP range support, and a thumbnail endpoint.
- [x] 8.2 Set correct content-type and caching headers; ensure no media path/bytes are logged by default.

## 9. UI rendering

- [x] 9.1 In `App.tsx` `MessageBubble`, render available media: image/sticker thumbnail and video poster that open full size, inline audio player for voice notes, document row; keep the honest placeholder + reason when unavailable.
- [x] 9.2 Lazy-load media (native `loading="lazy"` and/or fetch-on-visible) so media-heavy threads do not fetch everything at once (thread view is not virtualized).
- [x] 9.3 Show a visible view-once badge on archived view-once media.
- [x] 9.4 Update the import wizard media-folder step so selection is first-class and never blocks proceeding.
- [x] 9.5 Collapse 4+ consecutive media items from the same sender (tight time window) into a WhatsApp-style grid with a "+N" overflow tile; items open individually; display-only.
- [x] 9.6 Render deleted messages as held content (text and media) with a clear deleted marker; bare "Deleted message" only when nothing was captured.
- [x] 9.7 Linkify URLs in message text (highlighted, clickable, open externally) and render stored link-preview cards offline.
- [x] 9.8 Show an "edited" indicator on edited messages and an edit-history view listing retained revisions in order; no history affordance when no revisions are held.

## 10. Observability & docs

- [x] 10.1 Surface media download status (counts by state, failures) in live/media status output and add a retry control for stuck items; use counts/types only, no content or private paths.
- [x] 10.2 Update the openspec spec sources (`sync`) and any user-facing docs/README notes for the new media behavior after implementation.

## 11. Verification (real linked device)

- [ ] 11.1 Run `npm run server` (non-watch), archive a live photo/video/voice/document/sticker/GIF and confirm each downloads, stores, and renders/plays from the UI, repeatedly.
- [x] 11.2 Archive a view-once photo/video/voice and confirm on the real phone that it remains unopened and viewable after download. — **Outcome (real-device test, 2026-07-08): not possible on current WhatsApp, and confirmed against the developer community.** WhatsApp delivers view-once content only to the primary phone; the linked device receives an envelope explicitly marked `unavailable type="view_once"` with no ciphertext (verified in Baileys' decode path: zero decryptables, deliberately not treated as a decrypt failure). This is WhatsApp's Sept–Nov 2024 fix for the [Zengo/Tal Be'ery disclosure](https://medium.com/@TalBeerySec/once-and-forever-whatsapps-view-once-functionality-is-broken-302a508390b0) that let Baileys clients download view-once; the current Baileys community confirms the media simply isn't delivered ([issue #2105](https://github.com/WhiskeySockets/Baileys/issues/2105), closed with no workaround) and whatsmeow excludes view-once from its missed-message resend. An opt-in own-phone re-request path (`requestPlaceholderResend`) was prototyped and then **removed** after real-device testing showed the phone does not honor it for view-once — it was dead weight and misleading UI. **Kept:** withheld view-once is archived honestly as "View once media — WhatsApp delivers view-once content only to your phone; linked devices never receive it" (never misclassified as unknown). The live capture pipeline remains ready for both wrapped and `viewOnce`-flagged content forms, so if WhatsApp's [official companion view-once feature](https://www.androidauthority.com/whatsapp-view-once-media-linked-devices-3522527/) (beta since Feb 2025) reaches the account, view-once is archived automatically with no bypass.
- [ ] 11.3 Import the real WhatsApp media folder by local path; confirm every media kind (images, video, video notes, voice notes, audio, GIFs, documents, stickers) links and renders, the media phase shows live progress, and missing files warn without aborting.
- [ ] 11.4 Confirm a revoked message keeps its archived media, a revoked text message keeps its text with a deleted marker, and expired/offline-missed media reports the honest unavailable state.
- [ ] 11.5 Confirm a live edit shows the edited marker and prior revisions in history; media grids group 4+ items; URLs are clickable and stored link previews render.
- [x] 11.6 Run `npm test` and `npm run build`; confirm no regressions in live sync, import, or thread view.
