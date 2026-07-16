# Testing

## Commands

Use:

```powershell
npm test
npm run doctor
```

Use `npm run build` when frontend, production serving, or TypeScript compilation behavior changed.

Live maintainer commands are explicit opt-in and should not be run with real accounts during automated tests:

```powershell
npm run live:proof -- --phone <countrycode-number>
npm run live:start -- --phone <countrycode-number>
npm run live:status
npm run live:gaps
```

Memory commands are local-first by default:

```powershell
tsx src/server/cli.ts memory-status
tsx src/server/cli.ts memory-rem --dry-run
tsx src/server/cli.ts memory-rem
tsx src/server/cli.ts memory-query --query "topic"
tsx src/server/cli.ts memory-validate
```

Codex-backed generation is opt-in:

```powershell
tsx src/server/cli.ts memory-provider enable-codex
tsx src/server/cli.ts memory-provider login
```

## Current Test Coverage

The test suite covers:

- reply-owned quote snapshot parsing, monotonic backup/live enrichment, local thumbnail delivery, cross-chat non-navigation, and generalized live `contextInfo` capture
- cleanup safety
- import staging cleanup
- guided onboarding state derivation
- UI import API key verification, progress polling, refresh reattachment, cancellation, rollback, and privacy-safe progress logging
- shared terminal progress rendering for CLI and UI import jobs
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
- live dependency safety checks
- live schema additivity
- live event idempotency
- per-chat gap detection
- bounded recovery outcomes
- live API state controls
- second-brain memory schema additivity
- Obsidian-friendly Markdown page generation
- citation sidecar writes and citation resolution
- dry-run evidence previews without durable page commits
- provider-disabled refusal for Codex generation
- layered memory query across committed pages and short-term messages
- stale citation marking after archive replacement
- structured signal capture across legacy, modern, iOS-shaped, malformed, and large receipt/history fixtures
- backup/live canonical parity, signal-anchor staleness, regeneration, and public-DTO privacy canaries for vCards, coordinates, transcripts, and receipt data

## Fixture Policy

Real WhatsApp files must not be committed.

Synthetic fixtures can be generated with:

```powershell
npm run generate-fixtures -- --dir fixtures/generated/basic
```

Generated fixtures are ignored by git and can be deleted at any time.

Live maintainer tests use synthetic protocol-shaped events and fake clients. They verify idempotency, per-chat gap detection, bounded recovery outcomes, and privacy-safe diagnostics without connecting to WhatsApp.

## Manual Acceptance

The local UI should make it easy to verify:
- first-run guided setup shows backup import as the only primary action
- import/re-import opens the wizard rather than inline path fields
- key verification succeeds/fails before merge/replace is shown
- replace mode requires explicit confirmation
- import progress shows file and message progress
- refreshing during a running import reopens the progress screen
- stopping an import warns first, cancels the job, and restores the pre-import archive state
- baseline-ready live sync shows link, not stop/unlink
- active, paused, and disconnected live states show distinct actions
- chats imported
- names look reasonable
- messages are in expected order
- group senders are mapped
- timestamps are plausible
- warnings are visible but privacy-safe
- re-running import does not duplicate rows
- structured locations/cards/previews/edits appear as safe thread summaries, while exact coordinates, vCard bodies, and transcript text do not appear in status or message-list payloads
- opening a compact location, vCard, deletion, transcript, edit, or system-event control lazy-loads its complete local detail; Escape closes the dialog and vCard downloads remain local/no-store
- group summaries name an actor only when that role was verified; missing roles say `Unknown/Unresolved contact`, and ambiguous backup self-membership flags never display as `You`
- a small local brain regeneration keeps citations stable, labels source-provided media interpretation honestly, and does not expose receipt data
- running memory REM creates Markdown under `.wapp-brain/memory/pages`
- memory pages include YAML front matter and citation labels
- memory query can find committed memory and current short-term messages
- citation inspection can reopen nearby local messages
