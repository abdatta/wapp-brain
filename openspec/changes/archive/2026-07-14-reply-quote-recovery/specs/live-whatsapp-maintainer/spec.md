## ADDED Requirements

### Requirement: Live Reply Snapshot Capture
The live maintainer SHALL capture a reply's one-level quoted-message snapshot from Baileys `ContextInfo` on both real-time `messages.upsert` and `messaging-history.set` paths. It SHALL retain `stanzaId`, quoted `participant`, optional cross-chat `remoteJid`, and the available `quotedMessage` content; normalize the embedded message into the same durable quoted-snapshot contract used by backup import; canonicalize quoted sender/source-chat identities; preserve all available text without local truncation; and capture only embedded structured metadata and thumbnail bytes. It MUST NOT recursively retain a quoted message's own context or enqueue/download quoted media separately. When `quotedMessage` is absent or unsupported, live ingestion SHALL retain the pointer and continue without fabricating snapshot content.

#### Scenario: Real-time text reply captures its snapshot
- **WHEN** a `messages.upsert` message carries `contextInfo.stanzaId`, `participant`, and a text `quotedMessage`
- **THEN** the archived reply owns a quoted snapshot with the original key, canonical quoted sender, and complete available text without requiring a backup re-import

#### Scenario: History-sync structured reply captures its snapshot
- **WHEN** `messaging-history.set` delivers a reply whose `quotedMessage` is an image, location, contact, or other supported structured type
- **THEN** the snapshot stores its deterministic type context, caption or structured fields, and embedded thumbnail when present through the same normalizer used by real-time delivery

#### Scenario: Reply Privately retains its source chat
- **WHEN** a one-to-one live reply quotes a group message and `ContextInfo.remoteJid` names that group
- **THEN** the snapshot records the canonical group source-chat JID and quoted key without querying or moving the original into the one-to-one chat

#### Scenario: Context is found on non-text reply content
- **WHEN** WhatsApp attaches reply `contextInfo` to a supported visible content type other than extended text or the current media subset
- **THEN** generalized context discovery still captures the pointer and quoted snapshot instead of silently dropping them

#### Scenario: Quoted identities follow late canonicalization
- **WHEN** the quoted participant or source chat arrives in LID/device form and the same event teaches a canonical identity mapping
- **THEN** maintainer canonicalization applies the mapping to the snapshot just as it does to the outer message and no duplicate quoted identity is created

#### Scenario: Quoted owner is labelled as the archive owner
- **WHEN** a live snapshot's quoted participant is the linked WhatsApp account
- **THEN** downstream projection resolves that participant to the archive owner's label rather than an unresolved number or raw device JID

#### Scenario: Pointer-only live reply remains ingestible
- **WHEN** live `ContextInfo` contains `stanzaId` but no usable `quotedMessage`
- **THEN** the reply ingests with its pointer, no snapshot content is invented, and the bounded same-chat/generic fallback remains available

#### Scenario: Quoted media is not downloaded independently
- **WHEN** a live `quotedMessage` contains media metadata or an embedded thumbnail
- **THEN** the thumbnail and safe metadata may be stored locally but no media descriptor or remote download is created for the snapshot itself

#### Scenario: Repeated live and backup observations enrich one snapshot
- **WHEN** real-time, history-sync, or backup ingestion observes the same canonical reply more than once
- **THEN** the archive keeps one message and monotonically enriches its one owned snapshot without erasing previously captured fields
