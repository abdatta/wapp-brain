# identity-and-naming-integrity Specification (delta)

## MODIFIED Requirements

### Requirement: Visible Contact Enrichment
Identity enrichment SHALL apply retroactively to already-archived chats, senders, and derived brain state (episodes, their claims, and the search index). Enrichment sources are user-set names entered in-app, the contact database (`wa.db`) where present, explicitly connected Google Contacts, and the message-store database's LID display-name table (`lid_display_name`) where present. A user-set name SHALL take the highest precedence: it SHALL NOT be overwritten by any enrichment or import source, and SHALL be replaceable only by another user action. Below it, a saved WhatsApp contact-database name SHALL take precedence over a Google Contacts name, and both SHALL take precedence over a message-store display-cache or push name for the same identity. A user-set name SHALL be validated before persisting: masked-number placeholders and digit-restatements of the identity's own number SHALL be refused. Google enrichment SHALL only fill unresolved or weaker phone identities and MUST NOT guess a phone mapping. Each enrichment operation SHALL report source-appropriate counts so the user can tell whether it worked, including when a source contributes nothing. When an enrichment resolves a name for an identity that already appears as an unresolved participant in committed episodes, it SHALL route through the identity repair trigger so those episodes and the search index are brought up to date deterministically, with no model call — user-set names included.

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

#### Scenario: A user-set name outranks every enrichment source
- **WHEN** the owner names an identity in-app and a later wa.db import or Google sync carries a different name for it
- **THEN** the user-set name is preserved and displayed, and only another in-app user action can replace it

#### Scenario: A user-set name repairs the brain like any other source
- **WHEN** the owner names an identity that appears as an unresolved participant in committed episodes
- **THEN** the name routes through the identity repair trigger and those episodes' prose and the search index update deterministically, with no model call

#### Scenario: Invalid user-set names are refused
- **WHEN** the owner submits a masked-number placeholder or a restatement of the identity's own digits as a name
- **THEN** the rename is refused with the reason, and the stored name is unchanged

#### Scenario: Enrichment is reported per source
- **WHEN** a database import or Google Contacts sync completes
- **THEN** the operation reports contacts read and names improved plus its source-specific identity-link, match, ambiguity, or skip counts, even when the source contributed nothing

#### Scenario: Enrichment repairs an already-assimilated episode
- **WHEN** enrichment resolves a name for a number that appears as an unresolved participant in a committed episode
- **THEN** that episode's prose and the search index are repaired deterministically through the identity repair trigger, without a model call and without re-importing messages
