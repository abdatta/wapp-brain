# google-contacts-integration Specification (delta)

## MODIFIED Requirements

### Requirement: Minimal Google contact synchronization
The system SHALL retrieve all pages of the authenticated user's contact-source connections while requesting only names, phone numbers, and deletion metadata, and MUST NOT durably store raw provider responses or unrelated profile fields. In addition to name enrichment, the sync SHALL capture the person-level grouping the provider already returns — which normalized numbers belong to one Google contact — and persist it as grouping records containing only the contact's stable resource identifier, each normalizable number in canonical form, the contact's display name, and the sync timestamp. Grouping capture SHALL be independent of name-ambiguity handling: a number whose name enrichment is skipped as ambiguous SHALL still be recorded in its contact's grouping, while numbers that cannot be normalized without guessing a country SHALL be excluded. A re-sync SHALL replace the persisted groupings with the provider's current state. Persisted groupings exist to drive same-contact person auto-connect; removing a number from a Google contact MUST NOT by itself disconnect identities previously connected from that grouping.

#### Scenario: Full synchronization succeeds
- **WHEN** a connected user starts a sync
- **THEN** every available page is processed and the UI receives aggregate counts without raw contact data

#### Scenario: Access token expires
- **WHEN** a sync begins with an expired access token and a usable refresh token
- **THEN** the server refreshes access locally and continues without another consent prompt

#### Scenario: Provider authorization is invalid
- **WHEN** Google rejects refresh or contact access because authorization was revoked or expired
- **THEN** the system reports that reconnection is required without leaking the provider response or stored token

#### Scenario: Multi-number contact grouping is persisted
- **WHEN** a synced Google contact carries two normalizable numbers
- **THEN** the sync persists one grouping with both numbers under the contact's resource identifier, storing no raw provider payload

#### Scenario: Ambiguous name does not lose the grouping
- **WHEN** a number's name enrichment is skipped because multiple Google contacts assign it different names
- **THEN** that number still appears in the grouping records of each contact that carries it

#### Scenario: Re-sync reflects the provider's current grouping
- **WHEN** a number was moved between Google contacts since the previous sync
- **THEN** after the next sync the persisted groupings match the provider's current state, and previously connected identities remain connected
