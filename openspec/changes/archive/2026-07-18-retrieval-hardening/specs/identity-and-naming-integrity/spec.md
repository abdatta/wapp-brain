# identity-and-naming-integrity — Delta Spec (retrieval-hardening)

## MODIFIED Requirements

### Requirement: Identity Improvement Repair Trigger

Every improvement to an identity's resolved display SHALL route through a single internal repair entry point so that repair happens once and identically for every source. The sources SHALL include: a JID gaining a display name (contact save, live sync, Google Contacts enrichment), a JID whose genuine display name changes to a different genuine name (a rename, from the in-app rename or any contact source), a JID merging into a canonical identity, and any future name source (the message-store `jid_map` and `lid_display_name` tables). Given the improved JID, the entry point SHALL deterministically and with no model call bring every derived layer keyed on that identity up to date: it SHALL recompute the derived search text for the identity's messages and for messages that mention it — so a search for the newly known name immediately finds already-archived messages, closing the gap where only identity merges triggered that recompute — it SHALL confirm chats and senders resolve to the new name at read time rather than from any stored copy, and it SHALL drive the brain's deterministic prose and projection repair for episodes involving that identity. A rename SHALL trigger repair only when the resolved label actually changed, so bulk contact upserts that restate existing names cause no recompute work. Repair SHALL be non-blocking (bounded, chunked, yielding) and idempotent, so re-running it after everything is already repaired changes nothing and consumes no model call.

#### Scenario: Saving a contact makes old messages searchable by the new name

- **WHEN** a chat with an unresolved phone-number participant is already archived and the user then saves that number as a contact
- **THEN** searching the newly saved name returns those already-archived messages, with no model call

#### Scenario: Renaming an already-named contact repairs derived search text

- **WHEN** an identity already displaying one genuine name is renamed to a different genuine name (via the in-app rename or a contact-source update)
- **THEN** the rename routes through the same repair entry point and searching the new name finds the identity's already-archived messages, with no model call

#### Scenario: Restated names cause no repair work

- **WHEN** a bulk contact upsert writes the same display name an identity already resolves to
- **THEN** no derived-layer recompute runs for that identity

#### Scenario: Name-gained and merge variants trigger the same repair

- **WHEN** an identity improves either by an existing JID gaining a display name or by a LID merging into its phone identity
- **THEN** both route through the one repair entry point and the same derived layers (search text, display, brain prose and projection) are brought up to date

#### Scenario: A future name source reuses the entry point

- **WHEN** a later resolution source (for example the message-store `jid_map` or `lid_display_name` table) resolves a name or number for an identity
- **THEN** it invokes the same repair entry point rather than implementing its own derived-layer repair

#### Scenario: Repair is idempotent and model-free

- **WHEN** the repair entry point runs for an identity whose derived layers are already up to date
- **THEN** no search text, prose, or projection changes, and no model call is made
