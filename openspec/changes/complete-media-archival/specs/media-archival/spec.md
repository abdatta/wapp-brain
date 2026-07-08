## ADDED Requirements

### Requirement: Complete Media Capture From Live Sync

The system SHALL capture the downloadable descriptor of every incoming live media message — photo, video, voice/audio, document, sticker, GIF, and their view-once variants — at the platform event boundary before normalization discards it, and SHALL download and decrypt the media into the local store. Capture MUST read the descriptor from the unwrapped inner media content so wrapped (view-once, ephemeral, document-with-caption) messages are handled. Downloading SHALL use a passive fetch of the encrypted blob followed by local decryption and MUST NOT send any read receipt, played receipt, or presence signal.

#### Scenario: Incoming media is downloaded and stored

- **WHEN** a live media message arrives while the maintainer is running
- **THEN** the system stores the decrypted media in the local store, linked to the message, without sending any read or played receipt

#### Scenario: Descriptor is captured before it is discarded

- **WHEN** a media message is ingested and normalization keeps only display scalars
- **THEN** the media key, direct path, encryption hashes, and size needed to fetch the blob have already been persisted for download

#### Scenario: Media type coverage

- **WHEN** the incoming media is a photo, video, voice note, audio, document, sticker, or GIF
- **THEN** each type is captured and downloaded, not only images

### Requirement: View-Once Media Is Captured Without Losing Phone Access

The system SHALL capture view-once photos, videos, and voice notes into the permanent store whenever the platform delivers their content to the linked device, while preserving the user's ability to view them once on their own phone. Because view-once "opened" state is driven by a played/read receipt, the system MUST NOT send any read or played receipt for view-once messages, and MUST download them passively. View-once media SHALL be prioritized for immediate download because its content is time-limited and is absent from backups. When WhatsApp withholds view-once content from linked devices (an envelope explicitly marked unavailable, carrying no ciphertext — the current platform behavior), the system SHALL archive the message as an honestly labeled view-once record stating that linked devices never receive the content, and MUST NOT misclassify it as an unknown message type.

#### Scenario: View-once is archived without marking it opened

- **WHEN** a view-once message arrives with content and is downloaded into the store
- **THEN** the phone still shows the view-once message as unopened and viewable, because no played or read receipt was sent

#### Scenario: View-once is fetched eagerly

- **WHEN** a view-once message is captured
- **THEN** it is queued at the highest priority so it is downloaded before its content expires

#### Scenario: View-once missed while offline is reported honestly

- **WHEN** a view-once message arrived while the server was not running and its content is no longer retrievable
- **THEN** the message reports a not-captured availability state rather than claiming the media is stored

#### Scenario: View-once withheld from linked devices is reported honestly

- **WHEN** a view-once message arrives as a platform-marked unavailable envelope with no content, because WhatsApp delivers view-once only to the phone
- **THEN** the message is archived as view-once media with the honest reason that linked devices never receive the content, not as an unrecognized message type

### Requirement: Scoped Media Re-Upload Recovery

For media whose content-delivery link has expired, the system MAY send a WhatsApp media re-upload request to recover it. This request is the ONLY outbound message type the media layer may send; it MUST NOT be a read receipt, played receipt, presence, typing, or any chat-visible traffic, and it carries no message content. Re-upload attempts SHALL be bounded per message with backoff, after which the media is marked unrecoverable rather than retried indefinitely.

#### Scenario: Expired media triggers a re-upload request

- **WHEN** a download fails because the media link has expired and re-upload attempts remain within the configured limit
- **THEN** the system sends a media re-upload request and retries the download when the media is re-provided

#### Scenario: Re-upload never sends receipts

- **WHEN** the system sends a media re-upload request
- **THEN** no read receipt, played receipt, or presence update is sent as part of that recovery

#### Scenario: Exhausted recovery is marked unrecoverable

- **WHEN** re-upload attempts for a message reach the configured limit without recovering the media
- **THEN** the message is marked as expired/unrecoverable and is not retried again automatically

### Requirement: Durable Background Media Download Queue

The system SHALL drive media downloads through a durable, resumable work queue processed in bounded batches on the maintainer's recurring recovery cadence, mirroring the existing retained-payload and gap-recovery patterns. Queue entries SHALL record status, attempt count, next-attempt time, last error, and priority. A restart MUST NOT lose queued work, and successfully stored media MUST reach a terminal state so it is not re-downloaded.

#### Scenario: Downloads survive a restart

- **WHEN** the server restarts with media still queued for download
- **THEN** the queued downloads resume after restart without re-fetching already-stored media

#### Scenario: Bounded work per cadence

- **WHEN** many media items are pending
- **THEN** each recovery cycle processes a bounded batch so downloading does not starve other maintainer work

#### Scenario: Failures back off and retry

- **WHEN** a download fails transiently
- **THEN** the entry is retried later with backoff up to a cap, then marked failed rather than looping

### Requirement: Content-Addressed Deduplicated Media Store

The system SHALL store media as content-addressed blobs (addressed by a hash of the decrypted content) under the private workspace, so identical forwarded or re-sent media is stored once. A media-asset relation SHALL link messages to stored assets and record provenance (live download, media re-upload, or import folder), mime type, byte size, and — where available — dimensions, duration, and a thumbnail. Blobs SHALL be written atomically so an interrupted write never registers as a complete asset.

#### Scenario: Identical media is stored once

- **WHEN** the same media is received in two messages (for example a forward)
- **THEN** one blob is stored and both messages link to it

#### Scenario: Provenance is recorded

- **WHEN** an asset is stored
- **THEN** its record states whether it came from live download, media re-upload, or the import folder

#### Scenario: Interrupted write does not register

- **WHEN** a download is interrupted mid-write
- **THEN** no partial blob is treated as a stored asset, and the item remains queued for retry

### Requirement: Media Retention Across Deletion And Revoke

The system SHALL retain already-downloaded media as a permanent local backup even after the message is deleted or revoked by the sender. A revoke or delete SHALL still tombstone the message, but MUST NOT remove the stored media bytes or unlink the asset.

#### Scenario: Revoked message keeps its archived media

- **WHEN** a sender revokes a message whose media was already downloaded
- **THEN** the message is marked deleted but the archived media remains available in the store

#### Scenario: Deletion does not evict blobs

- **WHEN** any message referencing a stored asset is deleted
- **THEN** the asset bytes remain in the store

### Requirement: Honest Media Availability State

Every media message SHALL resolve to an accurate availability state computed server-side — stored, downloading/pending, expired-unrecoverable, not-captured (arrived while offline), or import-missing — and the system MUST NOT assert media is available when it is not, nor assert media is unkept when it is stored.

#### Scenario: Stored media reports available

- **WHEN** a media message's bytes are present in the store
- **THEN** its availability state is stored and no "media not kept" reason is presented

#### Scenario: Unavailable media explains why

- **WHEN** a media message's bytes are not in the store
- **THEN** the message reports the specific reason (still downloading, expired/unrecoverable, not captured while offline, or missing from the import folder)

### Requirement: Import Media Backfill From Backup Folder

On backup import, the system SHALL read the backup's media sidecar mappings (media, view-once media, and thumbnail tables), match each media message to a file in the user-provided WhatsApp media folder, copy matched files into the content-addressed store, and link them to messages with import provenance. Media ingestion SHALL cover every media kind present in the standard WhatsApp media folder layout — images, video, video notes, voice notes, audio, animated GIFs, documents, and stickers, including their sent/date subdirectories. Matching SHALL prefer content-hash equivalence and fall back to the recorded file path or name. Missing, unreadable, or ambiguous media SHALL produce a privacy-safe warning and an import-missing state; it MUST NOT abort message import, and a bad or absent media-folder path MUST NOT abort the import.

#### Scenario: Backup media file is linked

- **WHEN** an imported media message has a matching file in the provided media folder
- **THEN** the file is copied into the store and linked to the message with import provenance

#### Scenario: Every media kind in the folder is ingested

- **WHEN** the media folder contains matched images, videos, video notes, voice notes, audio, GIFs, documents, and stickers
- **THEN** each kind is ingested and linked, not only images

#### Scenario: Missing media does not abort import

- **WHEN** an imported media message has no matching or readable file in the media folder
- **THEN** the message imports with an import-missing state and a warning, and the overall import continues

#### Scenario: Bad media path does not abort import

- **WHEN** the media-folder path is wrong, empty, or unreadable
- **THEN** the import proceeds without media and records a warning instead of failing

#### Scenario: Modern-format media metadata is preserved

- **WHEN** a modern-format backup message carries a mime type and file name
- **THEN** those values are kept on the message rather than dropped

### Requirement: Direct-Path Media Ingestion With Progress

The system SHALL ingest the media folder directly from a local filesystem path — walking it server-side, hashing, deduplicating, and copying into the store — without requiring the folder's contents to be uploaded through the browser. Media ingestion SHALL report progress (files processed, matched, copied, warnings) through the import job's progress reporting so long-running ingestion of very large folders is visible in the UI and server terminal. The walk MUST NOT follow symlinks outside the selected root and MUST skip unrelated cache/status dot-directories unless a message mapping points into them.

#### Scenario: Multi-gigabyte folder is ingested without upload

- **WHEN** the user provides the local path to a many-gigabyte WhatsApp media folder
- **THEN** the server ingests it by reading the folder directly, with no browser upload of the folder contents

#### Scenario: Ingestion shows live progress

- **WHEN** media ingestion is running over a large folder
- **THEN** the import progress surfaces processed/matched/copied counts while the job runs, in privacy-safe form

#### Scenario: Unrelated directories are skipped

- **WHEN** the media folder contains cache or hidden directories with no message mappings
- **THEN** the walk skips them rather than hashing unrelated content

### Requirement: Link Preview Media Capture

When a message carries an embedded link preview (title, description, canonical URL, and thumbnail bytes), the system SHALL capture and store the embedded preview thumbnail alongside the message so link previews can render offline. The system MUST NOT fetch link targets or generate previews by contacting remote sites; only sender-embedded preview data is stored.

#### Scenario: Embedded preview thumbnail is stored

- **WHEN** a live text message arrives with an embedded link preview thumbnail
- **THEN** the thumbnail bytes are stored and linked to the message for offline rendering

#### Scenario: No remote preview fetching

- **WHEN** a message contains a URL without embedded preview data
- **THEN** the system does not contact the link target to build a preview

### Requirement: Local-Only Media Serving

The system SHALL serve stored media and thumbnails only from local, loopback-bound endpoints, with range support suitable for streaming audio and video. Media bytes MUST NOT leave the machine by default; the only network egress the media layer performs is fetching a user's own already-received media from WhatsApp's content-delivery servers.

#### Scenario: Media is streamed locally

- **WHEN** the client requests a stored media item
- **THEN** the server streams it from local storage over a loopback-bound endpoint, supporting range requests for seeking

#### Scenario: No media egress by default

- **WHEN** media is stored and served
- **THEN** no media bytes are uploaded or sent to any remote service other than the WhatsApp fetch needed to originally download the user's own media

### Requirement: Media Privacy And Diagnostics

The system SHALL keep the entire media store within the private, version-control-excluded workspace, and SHALL NOT write raw media bytes or original media file names to logs or diagnostics by default. Media diagnostics SHALL use counts, types, and availability states rather than content or private file paths.

#### Scenario: Store stays private

- **WHEN** media is stored
- **THEN** it lives under the private workspace and is excluded from version control

#### Scenario: Diagnostics avoid content and paths

- **WHEN** the system records media download diagnostics
- **THEN** the output uses counts, types, and availability states without media bytes or original file names
