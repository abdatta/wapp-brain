# Contact And Group Identity Integrity

## Type

Feature / bug cluster

## Status

Ready to propose

## User Goal

Every chat and sender in the app should be identifiable by a human: a saved contact name, a push name, or a phone number — never a raw internal identifier. Groups must always show a group name; if the app cannot determine one, that is an alert-worthy problem, not a silent fallback.

## User Observation (2026-07-06, real device)

In a live-synced group thread, the same message appears twice: one copy attributed to a raw LID-style numeric sender, one copy attributed differently. The same WhatsApp message ingested under two participant identities (unmapped LID vs resolved form) produces two distinct archive rows because the message identity key includes the participant. Identity reconciliation must also deduplicate message rows keyed under split identities, not just merge contact/chat records.

## Expected Behavior

- A direct chat or message sender displays the best available name, falling back to a formatted phone number. Raw internal IDs (group IDs, LID-style identifiers) are never the primary label.
- A group chat displays its subject. If the subject is unknown, the app actively tries to fetch it while connected, and if it still cannot resolve one, the chat is flagged in a visible "naming health" alert rather than shown under a meaningless ID.
- The app never fabricates a phone number from an identifier that is not actually a phone number.
- One person or one chat is represented as one identity. When the platform migrates identifiers (LID/phone-number mapping), previously split records are reconciled instead of appearing as two contacts or two chats.
- Providing a contacts database (`wa.db`) visibly improves names, including retroactively for already-imported chats, and the import summary reports contacts read, matched, and names improved so the user can tell whether enrichment worked. (Absorbs the earlier `wa-db-contact-enrichment-not-reflected` backlog item.)
- Push names already known to the archive are used in message displays when no saved contact name exists.

## Behavior Questions

- When both a saved contact name and a push name exist and differ, which wins in the chat list vs inside a thread?
- Should identity reconciliation (merging split LID/phone records) be automatic, or reviewable before merge for safety?
- What does the "naming health" surface look like — a count in live status, a filterable list, or both?
- Should unresolved identities block second-brain memory generation for the affected chats, or just annotate them?

## Privacy Notes

Names and phone numbers are private metadata. Diagnostics should report counts and identity states, never dump contact rows. All resolution happens locally against the linked session and local databases.

## Acceptance Sketch

- **WHEN** a chat list row would otherwise display a raw internal identifier
- **THEN** the app displays a name or formatted phone number instead, or flags the chat in a naming-health alert.

- **WHEN** a group chat's subject is unknown while a live session is connected
- **THEN** the app attempts to fetch the subject, and flags the group as needing attention if it cannot.

- **WHEN** the same person exists under a legacy identifier and a phone identifier
- **THEN** the archive presents them as a single contact with one message history.
