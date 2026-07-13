## MODIFIED Requirements

### Requirement: Human-Readable Display Identity

Every chat and sender presented by the system SHALL display, in order of preference: a saved contact name, a push name, or a formatted phone number. A raw internal identifier (LID, group id, device-suffixed JID) MUST NOT be the primary label. A masked-number placeholder — a phone-shaped string whose digits are obfuscated by mask characters, as WhatsApp stores for unsaved contacts (for example `+91∙∙∙∙∙∙∙∙86`) — SHALL NOT be treated as a saved contact name or push name; it MUST NOT shadow a real name or a fully-known number, and the system SHALL NOT generate one. A masked-number placeholder already stored as a display name SHALL rank as no-name for name-improvement precedence, so a real name later learned for that identity (from enrichment or any name source) replaces the mask rather than being rejected as though the mask were a saved name. The formatted phone number SHALL be the complete number in `+E.164` form, derived from the identity's phone record or its phone-form JID, never a masked or partial form. When none of the preferred forms exist — including when the only available label is a masked-number placeholder for an identity whose number is unknown — the system SHALL present an explicit unresolved state rather than the identifier or the mask.

#### Scenario: Group sender with only a push name

- **WHEN** a group message's sender has no saved contact name but a push name is known
- **THEN** the message displays the push name

#### Scenario: Sender with only a phone identity

- **WHEN** no name is known for a phone-form sender
- **THEN** the message displays the formatted phone number

#### Scenario: Unresolved LID sender

- **WHEN** a sender is known only by an unmapped LID
- **THEN** the display states the identity is unresolved and the chat/sender is counted in identity health, and the raw LID is not shown as the name

#### Scenario: Masked-number placeholder never shadows the full number

- **WHEN** a phone-form identity's stored display name is a masked-number placeholder and its full number is known from its phone record or JID
- **THEN** the identity displays the complete `+E.164` number, never the masked placeholder

#### Scenario: Masked-number placeholder is not a saved name

- **WHEN** a contact or chat is ingested (by import, live sync, or enrichment) whose incoming display name is a masked-number placeholder
- **THEN** it is stored as having no display name, so resolution falls through to a real name if one is later learned, or to the formatted number

#### Scenario: Masked-only identity reads as unresolved

- **WHEN** the only label available for an identity is a masked-number placeholder and no number can be derived from a phone record or JID
- **THEN** the identity is presented in the explicit unresolved state and counted in identity health, not labeled with the mask

#### Scenario: Existing masked labels are cleaned without re-import

- **WHEN** the archive already contains contacts and chats whose display name is a masked-number placeholder
- **THEN** a one-time backfill clears those display names so resolution yields the formatted number or an unresolved state, while phone numbers, JIDs, and messages are left unchanged

#### Scenario: A learned name replaces a stored masked placeholder

- **WHEN** a contact's stored display name is a masked-number placeholder and a real name is later learned for that identity (from Google Contacts enrichment or any name source)
- **THEN** the learned name replaces the masked placeholder — and the identity's DM title and sender label read the real name — rather than the mask being kept as if it were a saved name

#### Scenario: A genuine saved name is not overwritten by enrichment

- **WHEN** a contact already has a real saved display name (not masked and not an identity-derived restatement of the number) and enrichment supplies a different name for the same number
- **THEN** the existing saved name is preserved and not overwritten
