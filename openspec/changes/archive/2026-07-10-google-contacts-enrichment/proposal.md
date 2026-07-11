## Why

WhatsApp's optional `wa.db` is often missing, stale, or inaccessible, leaving otherwise valid phone-addressed chats and senders without useful names. An explicit, read-only Google Contacts connection can fill many of those gaps while preserving Wapp Brain's local-first privacy model.

## What Changes

- Add an explicit Google OAuth connection flow that requests read-only contacts access and returns through the local server.
- Store OAuth credentials only in the private `.wapp-brain/` workspace, never in the archive, logs, browser storage, or source control.
- Import Google contact names and phone numbers through the People API and match them to archived phone identities using conservative phone normalization.
- Enrich unresolved or weaker archive contact names without replacing names learned from stronger WhatsApp saved-contact sources.
- Show connection, import, match, ambiguity, skip, and error status in the local UI, with manual resync and disconnect/revoke controls.
- Keep raw Google responses, email addresses, and unrelated profile fields out of durable storage.
- When Google Contacts is connected, require a fresh contact sync before each brain build/update begins so newly imported or live-discovered phone identities are named before assimilation.

## Capabilities

### New Capabilities
- `google-contacts-integration`: OAuth connection lifecycle, privacy boundaries, People API synchronization, and user-facing controls.

### Modified Capabilities
- `identity-and-naming-integrity`: Google Contacts becomes a lower-priority enrichment source for unresolved phone identities with deterministic precedence and visible results.

## Impact

- Adds local API routes and UI controls for Google connection and contact synchronization.
- Extends archive contact provenance and enrichment behavior, plus status/result DTOs.
- Adds Google OAuth configuration variables and a private token-state file under `.wapp-brain/`.
- Adds a Google API client dependency or equivalent standards-based HTTP integration.
- Requires Google Cloud project setup with the People API enabled and an OAuth web client whose callback targets the local server.
