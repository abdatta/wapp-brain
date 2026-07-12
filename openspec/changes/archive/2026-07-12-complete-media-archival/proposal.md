## Why

Wapp Brain keeps a trustworthy record of *what* was said but throws away the media itself. Both the backup import and live sync persist only `has_media`, a mime type, and a filename — no bytes, no locator, no way to ever see a photo, hear a voice note, or open a document from the archive. The media-folder import that was supposed to fix this is unimplemented (it validates the folder path, then never reads it). This misses the whole point of a second brain and a personal backup: the user wants every media item they ever received kept locally, viewable from the UI, and durable enough to consult even after the media is deleted from the phone. It also blocks a specific, time-sensitive goal — capturing view-once photos/videos/voice notes, which exist only in the live moment and are absent from backups entirely.

## What Changes

- **Live media capture**: intercept incoming media descriptors (image, video, audio/voice, document, sticker, GIF, and the unwrapped view-once variants) at the Baileys event boundary *before* normalization discards them, enqueue them durably, and download + decrypt them in the background. View-once media is captured without the phone losing its own ability to view it, because the app sends no read/played receipts.
- **Scoped media re-upload recovery** (**BREAKING** to the strict read-only posture): for media whose CDN link has expired, the app MAY send WhatsApp a media re-upload request (media-retry). This is the single sanctioned outbound message type. The app still NEVER sends read receipts, played receipts, presence, typing, or any chat-visible traffic; the read-only socket guards keep blocking all of those and gain one narrow, explicit exception for media retry only.
- **Import media backfill**: read the backup's media sidecar tables (`message_media`, `message_view_once_media`, `message_thumbnails`), match files in the user-provided WhatsApp media folder, copy them into the store, and link them to messages. Missing/unreadable media warns and is skipped — it never aborts message import. The media-folder input becomes a real, resilient ingestion step instead of a validated-and-discarded path (and a bad path no longer aborts the whole import).
- **Content-addressed media store**: a local, gitignored store under the private workspace that deduplicates identical media (forwards/re-sends) by content hash, plus a `media_assets` relation linking messages to stored assets with provenance (live download / media retry / import folder), mime, size, dimensions, duration, and a thumbnail. Unbounded growth is accepted by design.
- **Local media serving**: new localhost-only endpoints to stream original media and thumbnails, alongside the existing message routes. No media ever leaves the machine by default.
- **Media in the UI**: message bubbles render real media — image/video thumbnails that open full-size, an inline audio player for voice notes, and document rows — with lazy loading suitable for long unvirtualized threads, and a visible view-once badge on archived view-once items.
- **Honest availability state**: every media message reports an accurate availability status (stored / downloading / expired-unrecoverable / not-captured-while-offline) instead of the current fixed "media is not kept in backups" claim, which becomes false once media is kept.
- **Retention on revoke**: when a sender revokes or deletes a message, the archive keeps the already-downloaded media (the message is still tombstoned) — the backup-store behavior the user asked for, made an explicit requirement.
- **Direct-path media import at scale**: the media folder is ingested by pointing the local server at the folder on disk (it walks the standard `Media/WhatsApp *` subfolders directly — images, video, voice notes, video notes, audio, GIFs, documents, stickers), with phase progress in the wizard. Multi-GB folders are never pushed through a browser upload; the existing picker upload remains for small selections.
- **Deleted messages keep their content, everywhere**: revoke/delete tombstones the message but everything already captured — text, caption, and media alike — stays stored and visible, rendered with a clear "deleted" indicator in the UI instead of being blanked to a bare "Deleted message" label. The label remains only for deletions whose content was never captured.
- **Media grouping in the thread**: runs of consecutive media from the same sender collapse into a WhatsApp-style grid (4+ items) instead of tens of full-width bubbles.
- **Clickable links and link previews**: URLs in message text are highlighted and clickable, and link-preview cards render using the preview title/thumbnail already embedded in the message when present.
- **Edited messages are visible as edited**: an "edited" marker in the UI, and — for live messages going forward — prior revisions are retained when an edit arrives so the user can view the message's edit history.

## Capabilities

### New Capabilities
- `media-archival`: downloading, decrypting, deduplicating, storing, and retaining every media item from live sync and import; the content-addressed store and `media_assets` model; provenance; view-once capture; scoped media re-upload recovery; retention across revoke; and the availability-state contract that downstream consumers (thread view, search, second brain, MCP) read.

### Modified Capabilities
- `live-whatsapp-maintainer`: the read-only client posture gains a narrowly-scoped media re-upload exception (still no receipts/presence); live ingestion additionally captures media descriptors and drives background media download with bounded, self-healing retry.
- `premium-onboarding-workflow`: the file-picker import wizard gains a working media-folder step (resilient to large folders and bad paths; media problems warn instead of aborting import).
- `whatsapp-style-thread-view`: media messages render as viewable media (thumbnails, full view, inline audio, document rows) with lazy loading, rather than text placeholders.
- `message-interpretation`: media placeholders reflect real per-message availability state instead of asserting media is never kept; the shared interpretation output exposes media availability to every consumer.

## Impact

- **Schema**: new `media_assets` table and a `media_download_queue` (durable pending-work + retry state), mirroring the existing `retained_encrypted_payloads`/`live_gap_windows` patterns, plus a message edit-revision store for live edit history; additive columns via the existing migration seam. No changes to existing `messages` columns beyond linkage.
- **Live path**: `src/server/live/baileysClient.ts` (capture hook + guarded media-retry exception), `normalize.ts` (surface descriptors), `maintainer.ts` + a new download worker on the recovery tick.
- **Import path**: `src/server/import/importer.ts` and `parser.ts` (read media sidecars; stop nulling modern mime/name; folder matching + copy; warn-not-abort).
- **Store/serving**: new media store module + config path `.wapp-brain/media/` (already gitignored); new endpoints in `src/server/server.ts`.
- **DTO/UI**: `src/shared/types.ts` message DTO gains media asset references + availability; `src/client/App.tsx` message rendering and the import wizard.
- **Dependency**: uses Baileys' existing `downloadContentFromMessage` / media-retry (`@whiskeysockets/baileys` 7.0.0-rc13); no new dependency.
- **Privacy**: all media local-only and gitignored; no media bytes or filenames in logs/traces by default; media-retry transmits only a re-upload request for a message the user already received, never content.
- **Ops**: large real archive (~325k messages / ~3.7k chats); verified against a real linked device; run with `npm run server` (non-watch) for live sessions to avoid Baileys creds churn.
