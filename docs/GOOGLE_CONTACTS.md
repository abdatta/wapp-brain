# Google Contacts enrichment

Wapp Brain can optionally connect one Google account and use contact names to resolve archived WhatsApp identities that already have a known international phone number. The connection is explicit, read-only, and initiated from the local UI.

## Google Cloud setup

1. Create or select a Google Cloud project and enable the **People API**.
2. Configure the OAuth consent screen for the account(s) that will use this local app.
3. Create an OAuth 2.0 **Web application** client.
4. Add this exact authorized redirect URI (adjust the port if `APP_PORT` differs): `http://127.0.0.1:3600/api/google-contacts/oauth/callback`.
5. Copy `.env.example` to `.env` if needed and set `GOOGLE_CONTACTS_CLIENT_ID` and `GOOGLE_CONTACTS_CLIENT_SECRET`.
6. Restart Wapp Brain, open the Google Contacts panel, and choose **Connect Google**.

The app requests only `https://www.googleapis.com/auth/contacts.readonly`. Google may show an unverified-app warning while a personal OAuth consent screen remains in testing; add the intended account as a test user in Google Cloud.

## Local data and matching

OAuth credentials are stored only in `.wapp-brain/google-contacts-auth.json`, which is covered by the repository ignore rules. Tokens, authorization codes, OAuth state, and raw People API responses are not placed in the SQLite archive or browser storage and are not logged. Disconnect attempts to revoke provider access and always deletes the local credential file.

Sync requests only contact names, phone numbers, and deletion metadata. Google's canonical E.164 phone form is preferred. An explicitly `+`-prefixed international number is accepted as a fallback; national-format numbers are skipped because Wapp Brain will not guess a country. Conflicting Google names for the same number are treated as ambiguous and skipped.

Google names fill unresolved or identity-derived labels. Existing saved WhatsApp names are preserved. Already-applied Google names remain in the local archive after disconnect until a stronger source replaces them.

## Current limitations

- Synchronization does not background-poll. The one automatic correctness boundary is a fresh sync before every brain build/update when Google Contacts is connected; if that refresh fails, assimilation does not begin.
- LID-only identities need an existing LID-to-phone mapping before a Google number can match them.
- The first sync is a full People API read and is subject to the Google project's quota.
- Revocation can fail while offline; local credentials are still removed.
