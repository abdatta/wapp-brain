# Testing

## Commands

Use:

```powershell
npm test
npm run doctor
```

Use `npm run build` when frontend, production serving, or TypeScript compilation behavior changed.

## Current Test Coverage

The test suite covers:
- cleanup safety
- synthetic legacy imports
- file-backed SQLite persistence
- idempotent re-imports
- inspection without message body leaks
- unsupported schemas without raw row dumps
- privacy canaries
- modern-ish chat/jid/message schemas
- group sender attribution
- large-ish message paging
- 1000+ chat pagination
- malformed message skips
- unsupported schema failure
- synthetic crypt15 decryption

## Fixture Policy

Real WhatsApp files must not be committed.

Synthetic fixtures can be generated with:

```powershell
npm run generate-fixtures -- --dir fixtures/generated/basic
```

Generated fixtures are ignored by git and can be deleted at any time.

## Manual Acceptance

The local UI should make it easy to verify:
- chats imported
- names look reasonable
- messages are in expected order
- group senders are mapped
- timestamps are plausible
- warnings are visible but privacy-safe
- re-running import does not duplicate rows
