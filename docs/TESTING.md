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

Brain eval (zero model calls; delegates to a running server, opens the DB directly otherwise):

```powershell
npm run brain:eval -- --init        # scaffold the golden set
npm run brain:eval                  # run + report vs the latest same-hash baseline
npm run brain:eval -- --gate        # exit non-zero on recall regression
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
- brain eval harness: golden-set validation and hashing, recall math with invalid-expectation quarantine on both backends, gate verdicts, deterministic grading samples, denormalized grades surviving reset/rebuild, per-model aggregates with fallback attribution, and the eval API routes end-to-end

## Brain Eval Methodology

The eval harness (`brain-eval-harness`) makes brain quality measurable before any archive-scale spend. Two instruments:

**Golden-set retrieval recall.** `<WAPP_WORK_DIR>/eval/golden-queries.json` holds real queries — each with a stable id, a class (`paraphrase` / `person` / `commitment` / `temporal` / `code-mixed`; open vocabulary), the query text, and `expect`: the source message keys (`wa|<chatSourceId>|<sourceMessageId>`) search should surface. The file quotes real archive content, so it never enters git (see Fixture Policy); include `eval/` in whatever backup covers `archive.sqlite`. `npm run brain:eval` (or the `/brain/eval` page) executes every query through the real `searchMessages` path and records recall@k per class (k = 5/10/20; per-query recall = fraction of expected keys in the top k) into `brain_eval_runs`, stamped with the golden set's version + content hash. Expected keys that no longer resolve are quarantined as invalid expectations — a stale golden entry is never a retrieval miss. Zero model calls.

**Gate criterion.** Retrieval-affecting changes are judged by "golden-set recall@k per class meets or exceeds the recorded baseline" — not by anecdotal spot queries. The baseline is the most recent prior run with the same golden hash (or an explicit `--baseline <runId>`); `npm run brain:eval -- --gate` exits non-zero on regression, naming the regressed classes and offending queries. Cross-hash comparisons are labelled, never silently mixed. This is also the data producer for the embedding-rerank follow-up decision.

**Claim-citation grading.** The `/brain/eval` grading strip renders deterministically sampled claims (current model episodes only, stratified per model, ungraded first, claim-UUID order) beside their cited messages' full text. Grades: `supported` (citations establish the claim), `partial` (grounded but imprecise or overstated), `unsupported`, `unclear` (can't judge — excluded from precision). Strict precision = supported / (supported + partial + unsupported). Grades denormalize the episode's model/extraction-version stamps at grade time, so they survive regeneration, supersession, and brain resets — eval runs and grades are user-authored ground truth, not derived data. Per-model tables (precision, fallback rate via `attempted_model`, validation/anchoring rates — each with its denominator) drive the backfill model choice.

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
