## MODIFIED Requirements

### Requirement: Visible Contact Enrichment
Identity enrichment SHALL apply retroactively to already-archived chats and senders. Enrichment sources are the contact database (`wa.db`) where present, explicitly connected Google Contacts, and the message-store database's LID display-name table (`lid_display_name`) where present. A saved WhatsApp contact-database name SHALL take precedence over a Google Contacts name, and both SHALL take precedence over a message-store display-cache or push name for the same identity. Google enrichment SHALL only fill unresolved or weaker phone identities and MUST NOT guess a phone mapping. Each enrichment operation SHALL report source-appropriate counts so the user can tell whether it worked, including when a source contributes nothing.

#### Scenario: Names improve after the fact
- **WHEN** a `wa.db` with matching contacts is imported after messages already exist
- **THEN** existing chats and senders display the enriched names without re-importing messages

#### Scenario: Google contact resolves an archived phone identity
- **WHEN** an explicitly connected Google account contains an unambiguous international phone number for an archived identity whose name is unresolved or weaker
- **THEN** existing chats and senders display the Google contact name without re-importing messages

#### Scenario: Phone display-cache names resolve LID identities
- **WHEN** the message-store database carries a display name for a LID identity that has no saved contact name
- **THEN** chats and senders under that identity (or its merged canonical form) display that name instead of an unresolved state

#### Scenario: Stronger saved names beat Google and display-cache names
- **WHEN** the WhatsApp contact database, Google Contacts, and the message-store display cache carry names for the same identity
- **THEN** the WhatsApp contact database's name is displayed, followed in precedence by Google Contacts and then the display cache

#### Scenario: Enrichment is reported per source
- **WHEN** a database import or Google Contacts sync completes
- **THEN** the operation reports contacts read and names improved plus its source-specific identity-link, match, ambiguity, or skip counts, even when the source contributed nothing
