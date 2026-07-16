## Purpose

Define the opt-in, local-first Google Contacts integration: read-only OAuth, private credential handling, conservative phone matching, visible synchronization, and contact freshness before brain assimilation.

## Requirements

### Requirement: Explicit read-only Google authorization
The system SHALL connect a Google account only after an explicit user action through an OAuth authorization-code flow, MUST protect the callback with single-use state, and MUST request only the read-only contacts scope needed for this capability.

#### Scenario: User connects Google Contacts
- **WHEN** a configured user chooses to connect Google Contacts
- **THEN** the system sends the browser to Google's top-level consent experience with a CSRF state value and only read-only contacts access requested

#### Scenario: Callback state is invalid
- **WHEN** the OAuth callback contains missing, expired, or mismatched state
- **THEN** the system rejects the callback without exchanging or storing credentials

### Requirement: Private local credential lifecycle
The system SHALL keep Google OAuth credentials only in the ignored local private workspace, MUST NOT expose them to browser storage, archive records, diagnostics, or logs, and SHALL allow the user to disconnect the account.

#### Scenario: Authorization succeeds
- **WHEN** Google returns usable OAuth credentials
- **THEN** the server stores them atomically under `.wapp-brain/` and returns only non-sensitive connection status to the UI

#### Scenario: User disconnects
- **WHEN** the user confirms Google Contacts disconnection
- **THEN** the system attempts provider revocation, always removes the local credentials, and retains already-applied local contact names with their provenance

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

### Requirement: Conservative phone normalization
The system SHALL prefer Google's canonical E.164 phone form and SHALL match only numbers whose international identity can be determined without guessing a country. Conflicting names for the same normalized number MUST be treated as ambiguous and skipped.

#### Scenario: Canonical international number matches
- **WHEN** a Google contact supplies a canonical E.164 number corresponding to an archived phone identity
- **THEN** the number is eligible for name enrichment

#### Scenario: National number is ambiguous
- **WHEN** a phone number has no canonical form and no explicit international prefix
- **THEN** it is counted as skipped and does not resolve an archive identity

#### Scenario: Number has conflicting Google names
- **WHEN** multiple Google contacts assign different names to the same normalized phone number
- **THEN** that number is counted as ambiguous and no archive name is changed from it

### Requirement: Visible connection and import controls
The local UI SHALL show whether Google Contacts is configured and connected, the connected account label when available, last-sync status and aggregate results, and controls to connect, sync, and disconnect.

#### Scenario: Integration is not configured
- **WHEN** OAuth client configuration is absent
- **THEN** the UI explains what configuration is required and does not offer a broken connect action

#### Scenario: Sync improves contacts
- **WHEN** a sync completes
- **THEN** the UI reports fetched people, usable numbers, matched identities, improved names, ambiguous numbers, and skipped numbers

### Requirement: Contact freshness before brain assimilation
When Google Contacts is connected, the system MUST complete a fresh Google Contacts sync before any brain build or update creates an assimilation run or reads its message backlog. The sync SHALL match against the archive's current phone identities, including identities newly discovered by live WhatsApp sync. If the required contact sync fails, brain assimilation MUST NOT begin and the failure SHALL be visible to the user. When Google Contacts is not connected, brain behavior SHALL remain unchanged.

#### Scenario: Connected account refreshes before assimilation
- **WHEN** the user starts a brain build or update while Google Contacts is connected
- **THEN** the system completes contact synchronization before creating the brain run or reading its backlog

#### Scenario: Live sync found a new phone identity
- **WHEN** live WhatsApp ingestion adds a phone identity after the previous Google Contacts sync
- **THEN** the next brain build or update re-runs Google matching against that identity before its messages are assimilated

#### Scenario: Required contact refresh fails
- **WHEN** Google Contacts is connected but the pre-assimilation sync cannot complete
- **THEN** no brain backlog is assimilated and the brain run reports an actionable failure

#### Scenario: Google Contacts is disconnected
- **WHEN** a brain build or update starts without a connected Google account
- **THEN** the brain run proceeds without contacting Google
