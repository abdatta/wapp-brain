## ADDED Requirements

### Requirement: Identity Improvement Repair Trigger

Every improvement to an identity's resolved display SHALL route through a single internal repair entry point so that repair happens once and identically for every source. The sources SHALL include: a JID gaining a display name (contact save, live sync, Google Contacts enrichment), a JID merging into a canonical identity, and any future name source (the message-store `jid_map` and `lid_display_name` tables). Given the improved JID, the entry point SHALL deterministically and with no model call bring every derived layer keyed on that identity up to date: it SHALL recompute the derived search text for the identity's messages and for messages that mention it — so a search for the newly known name immediately finds already-archived messages, closing the gap where only identity merges triggered that recompute — it SHALL confirm chats and senders resolve to the new name at read time rather than from any stored copy, and it SHALL drive the brain's deterministic prose and projection repair for episodes involving that identity. Repair SHALL be non-blocking (bounded, chunked, yielding) and idempotent, so re-running it after everything is already repaired changes nothing and consumes no model call.

#### Scenario: Saving a contact makes old messages searchable by the new name

- **WHEN** a chat with an unresolved phone-number participant is already archived and the user then saves that number as a contact
- **THEN** searching the newly saved name returns those already-archived messages, with no model call

#### Scenario: Name-gained and merge variants trigger the same repair

- **WHEN** an identity improves either by an existing JID gaining a display name or by a LID merging into its phone identity
- **THEN** both route through the one repair entry point and the same derived layers (search text, display, brain prose and projection) are brought up to date

#### Scenario: A future name source reuses the entry point

- **WHEN** a later resolution source (for example the message-store `jid_map` or `lid_display_name` table) resolves a name or number for an identity
- **THEN** it invokes the same repair entry point rather than implementing its own derived-layer repair

#### Scenario: Repair is idempotent and model-free

- **WHEN** the repair entry point runs for an identity whose derived layers are already up to date
- **THEN** no search text, prose, or projection changes, and no model call is made

## MODIFIED Requirements

### Requirement: Visible Contact Enrichment
Identity enrichment SHALL apply retroactively to already-archived chats, senders, and derived brain state (episodes, their claims, and the search index). Enrichment sources are the contact database (`wa.db`) where present, explicitly connected Google Contacts, and the message-store database's LID display-name table (`lid_display_name`) where present. A saved WhatsApp contact-database name SHALL take precedence over a Google Contacts name, and both SHALL take precedence over a message-store display-cache or push name for the same identity. Google enrichment SHALL only fill unresolved or weaker phone identities and MUST NOT guess a phone mapping. Each enrichment operation SHALL report source-appropriate counts so the user can tell whether it worked, including when a source contributes nothing. When an enrichment resolves a name for an identity that already appears as an unresolved participant in committed episodes, it SHALL route through the identity repair trigger so those episodes and the search index are brought up to date deterministically, with no model call.

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

#### Scenario: Enrichment repairs an already-assimilated episode
- **WHEN** enrichment resolves a name for a number that appears as an unresolved participant in a committed episode
- **THEN** that episode's prose and the search index are repaired deterministically through the identity repair trigger, without a model call and without re-importing messages
