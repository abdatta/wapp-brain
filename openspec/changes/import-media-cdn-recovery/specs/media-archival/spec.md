## MODIFIED Requirements

### Requirement: Durable Background Media Download Queue

The system SHALL drive media downloads through a durable, resumable work queue processed in bounded batches on the maintainer's recurring recovery cadence, mirroring the existing retained-payload and gap-recovery patterns. Queue entries SHALL record status, attempt count, next-attempt time, last error, and priority. Queue entries MAY originate from live sync or from backup import; import-originated entries SHALL carry the download descriptor (media key and, where present, direct path and content hashes) extracted from the backup, and both origins SHALL flow through the same status lifecycle. A restart MUST NOT lose queued work, and successfully stored media MUST reach a terminal state so it is not re-downloaded.

#### Scenario: Downloads survive a restart

- **WHEN** the server restarts with media still queued for download
- **THEN** the queued downloads resume after restart without re-fetching already-stored media

#### Scenario: Bounded work per cadence

- **WHEN** many media items are pending
- **THEN** each recovery cycle processes a bounded batch so downloading does not starve other maintainer work

#### Scenario: Failures back off and retry

- **WHEN** a download fails transiently
- **THEN** the entry is retried later with backoff up to a cap, then marked failed rather than looping

#### Scenario: Import-originated media is queued and recovered

- **WHEN** a backup import finds media with no local file but a usable download descriptor
- **THEN** an import-originated queue entry is created and later drained by the same worker into the store or a terminal unrecoverable state

### Requirement: Honest Media Availability State

Every media message SHALL resolve to an accurate availability state computed server-side — stored, downloading/pending, expired-unrecoverable, not-captured (arrived while offline), or import-missing (no recoverable copy) — and the system MUST NOT assert media is available when it is not, nor assert media is unkept when it is stored. Media whose bytes are absent but which is queued for recovery from the backup's descriptor SHALL report downloading/pending, not a missing state. Media that reaches the import-missing state MUST NOT assert that the media folder the user selected was incomplete when the file was never saved on the device.

#### Scenario: Stored media reports available

- **WHEN** a media message's bytes are present in the store
- **THEN** its availability state is stored and no "media not kept" reason is presented

#### Scenario: Recoverable media reports queued, not missing

- **WHEN** a media message has no stored bytes but has been queued for recovery from its backup descriptor
- **THEN** its availability state is pending or downloading, not a missing state

#### Scenario: No-copy media is reported honestly

- **WHEN** a media message has no stored bytes, no local file in the backup, and no recovery keys
- **THEN** it reports an import-missing state whose reason says the media was never saved on the phone, not that it was absent from the selected folder

### Requirement: Import Media Backfill From Backup Folder

On backup import, the system SHALL read the backup's media sidecar mappings (media, view-once media, and thumbnail tables), match each media message to a file in the user-provided WhatsApp media folder, copy matched files into the content-addressed store, and link them to messages with import provenance. Media ingestion SHALL cover every media kind present in the standard WhatsApp media folder layout — images, video, video notes, voice notes, audio, animated GIFs, documents, and stickers, including their sent/date subdirectories. Matching SHALL prefer content-hash equivalence and fall back to the recorded file path or name. For a media message with no matching local file, the system SHALL extract the backup's download descriptor and, when it is usable for recovery, enqueue the message for background download rather than leaving it permanently missing; media with no local file and no usable descriptor SHALL be reported as having no recoverable copy. Missing, unreadable, or ambiguous media SHALL produce a privacy-safe warning; it MUST NOT abort message import, and a bad or absent media-folder path MUST NOT abort the import.

#### Scenario: Backup media file is linked

- **WHEN** an imported media message has a matching file in the provided media folder
- **THEN** the file is copied into the store and linked to the message with import provenance

#### Scenario: Every media kind in the folder is ingested

- **WHEN** the media folder contains matched images, videos, video notes, voice notes, audio, GIFs, documents, and stickers
- **THEN** each kind is ingested and linked, not only images

#### Scenario: File-less media with a descriptor is queued for recovery

- **WHEN** an imported media message has no matching local file but the backup carries a usable download descriptor (media key, and a direct path or content hash)
- **THEN** the message is enqueued for background CDN recovery with import provenance instead of being left permanently missing

#### Scenario: File-less media without a descriptor is honestly unrecoverable

- **WHEN** an imported media message has no matching local file and no usable recovery descriptor
- **THEN** the message reports no recoverable copy and the import continues

#### Scenario: Bad media path does not abort import

- **WHEN** the media-folder path is wrong, empty, or unreadable
- **THEN** the import proceeds without media and records a warning instead of failing

#### Scenario: Modern-format media metadata is preserved

- **WHEN** a modern-format backup message carries a mime type and file name
- **THEN** those values are kept on the message rather than dropped
