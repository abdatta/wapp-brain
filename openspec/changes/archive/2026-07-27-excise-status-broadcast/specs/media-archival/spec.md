## MODIFIED Requirements

### Requirement: Complete Media Capture From Live Sync

The system SHALL capture the downloadable descriptor of every incoming live media message — photo, video, voice/audio, document, sticker, GIF, and their view-once variants — at the platform event boundary before normalization discards it, and SHALL download and decrypt the media into the local store, with one exception: media belonging to `status@broadcast` SHALL never be captured, enqueued, or downloaded, because WhatsApp Status is not a chat and its events are dropped before normalization. Capture MUST read the descriptor from the unwrapped inner media content so wrapped (view-once, ephemeral, document-with-caption) messages are handled. Downloading SHALL use a passive fetch of the encrypted blob followed by local decryption and MUST NOT send any read receipt, played receipt, or presence signal.

#### Scenario: Incoming media is downloaded and stored

- **WHEN** a live media message arrives while the maintainer is running
- **THEN** the system stores the decrypted media in the local store, linked to the message, without sending any read or played receipt

#### Scenario: Descriptor is captured before it is discarded

- **WHEN** a media message is ingested and normalization keeps only display scalars
- **THEN** the media key, direct path, encryption hashes, and size needed to fetch the blob have already been persisted for download

#### Scenario: Media type coverage

- **WHEN** the incoming media is a photo, video, voice note, audio, document, sticker, or GIF
- **THEN** each type is captured and downloaded, not only images

#### Scenario: Status media is never fetched

- **WHEN** a status post carrying downloadable media arrives via live sync
- **THEN** no descriptor is persisted, nothing enters the download queue, and no blob is fetched or stored
