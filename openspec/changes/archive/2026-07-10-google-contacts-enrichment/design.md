## Context

Wapp Brain already canonicalizes phone-form WhatsApp JIDs and enriches contacts from `wa.db`, but many archives lack that optional database. The app is a local Express/React process bound to `127.0.0.1`; private runtime state belongs under `.wapp-brain/`. Google People API access is the first explicit cloud data source and must remain opt-in, narrowly scoped, and locally persisted.

## Goals / Non-Goals

**Goals:**

- Connect one Google account through a CSRF-protected OAuth authorization-code flow.
- Read only contact names and phone numbers, then enrich matching archived phone identities.
- Keep tokens and sync state private and local, expose useful import counts, and support resync/disconnect.
- Preserve deterministic source precedence and avoid false matches.

**Non-Goals:**

- Authenticating access to Wapp Brain itself or creating multi-user sessions.
- Uploading WhatsApp data to Google, modifying Google contacts, or importing email/profile data.
- Guessing a country for ambiguous national phone numbers or resolving LID-only identities without a known phone mapping.
- Background polling in the initial version; synchronization is explicit on connect or user request.

## Decisions

### Local web-server OAuth flow

The server constructs Google's authorization URL with an unpredictable, single-use state value, `access_type=offline`, and the sole data scope `https://www.googleapis.com/auth/contacts.readonly`. Google redirects to a fixed `http://127.0.0.1:<server-port>/api/google-contacts/oauth/callback`, which is permitted for localhost OAuth clients. The callback exchanges the code server-side and redirects to the local UI with a non-sensitive outcome marker.

This is preferred over browser-only tokens because refresh credentials never enter JavaScript storage, and over a desktop/device flow because the existing product already has a local web server and UI. Client id and secret are operator-supplied environment configuration; no shared application secret is committed.

### Minimal private credential store

OAuth tokens and account metadata are written atomically to `.wapp-brain/google-contacts-auth.json` with restrictive permissions where supported. The archive stores only normalized enrichment/provenance data and aggregate sync results. Tokens, authorization codes, OAuth state, and raw People API payloads are never logged. Disconnect revokes the token when possible and always removes the local credential file.

### Direct People API synchronization

The integration uses standards-based HTTPS calls to Google's token and People endpoints rather than a large SDK. It requests `personFields=names,phoneNumbers,metadata`, contact sources only, and follows pages up to 1000 records each. Sync remains user-triggered except for one correctness boundary: when Google Contacts is connected, every brain build/update performs the same full sync before it creates a brain run or reads backlog. This catches phone identities newly learned from imports or live sync. If that required sync fails, assimilation does not begin and the brain run reports the safe provider error.

### Conservative phone matching

For each non-deleted Google person with a display name, each phone number is normalized independently. `canonicalForm` is preferred when it is valid E.164; otherwise values already containing an international `+` prefix are reduced to digits and validated. National-format numbers without a reliable country code are counted as skipped rather than guessed. Matching uses the digits stored in `contacts.phone_number` and phone-form JIDs.

If one normalized number maps to conflicting Google names, it is ambiguous and does not enrich anything. Multiple numbers for one person may enrich multiple archive identities. A Google name fills an absent/phone-fallback name but does not replace a name sourced from `wa.db` or another stronger saved-contact source.

### Provenance and result reporting

Contacts gain source-aware name provenance sufficient to enforce precedence (`whatsapp_saved` above `google_contacts`, with push/display caches below both). Repository enrichment runs transactionally and returns fetched people, usable numbers, matched identities, improved names, ambiguous numbers, and skipped numbers. Archive-change events refresh visible chats after improvements.

### Local UI surface

A Google Contacts panel in the existing local app reports configuration, connection/account state, last sync, and the latest aggregate result. Connect opens Google's top-level consent page, Sync triggers a server-side import, and Disconnect requires confirmation. Errors remain actionable without exposing provider payloads.

## Risks / Trade-offs

- **Sensitive refresh token on disk** → Store only under the ignored private workspace, use atomic/restrictive writes, redact errors, and delete on disconnect.
- **OAuth misconfiguration or unverified-app friction** → Report the exact local callback URI and setup steps without exposing the client secret.
- **Incorrect phone association** → Accept only reliable international forms, skip ambiguous/conflicting mappings, and never guess a country.
- **Google name overriding a better WhatsApp name** → Persist provenance and enforce explicit source precedence in repository writes.
- **Revocation endpoint unavailable** → Remove local credentials regardless and report that remote revocation could not be confirmed.
- **Large address books and API quotas** → Page at the maximum supported size, serialize syncs, bound responses, and expose retryable failures.

## Migration Plan

Additive schema initialization introduces contact-name provenance and Google sync metadata without rewriting messages. Existing non-empty contact names are conservatively treated as stronger legacy/WhatsApp names. Rollback removes the UI/routes and credential file; added columns/tables can remain inert without affecting archive reads.

## Open Questions

None blocking. Incremental sync and richer regional number parsing can be proposed later if full manual sync or strict international matching proves insufficient.
