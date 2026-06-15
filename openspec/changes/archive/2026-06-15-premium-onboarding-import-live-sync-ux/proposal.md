## Why

The current sidebar exposes low-level import and live-sync controls before the user understands the archive lifecycle, which makes states like "not configured" plus "baseline ready" feel contradictory. First-time users need a premium guided experience that makes the correct order obvious: import a backup, verify it, choose merge/replace behavior, then link live sync and monitor it.

## What Changes

- Replace the path-entry import section with a guided import wizard opened from a clear primary action.
- Add native file picking for `msgstore.db.crypt15`, optional `wa.db`, optional media folder, and key file where supported by the browser/runtime, with manual path fallback only when necessary.
- Add key-entry/key-file verification before import proceeds, using a privacy-safe local verification endpoint that does not persist keys or decrypted databases by default.
- Add an explicit merge vs clear-and-replace decision before import starts.
- Show import progress in the UI with CLI-parity phases: validating, verifying key, decrypting, inspecting schema, importing messages, refreshing stats, warnings, and completion.
- Redesign live sync as a guided state card:
  - when not connected and baseline is ready, show a primary "Link WhatsApp" action that opens the QR/pairing flow;
  - when connected and syncing, show sync state, last event, gap health, and "Pause sync";
  - when connected but paused, show "Resume sync" and "Unlink device";
  - when no baseline exists or the baseline is too old, show the blocking reason and the backup import action.
- Remove misleading stop/unlink controls from the default not-configured state.
- Add a premium onboarding surface with polished visual treatment, motion, and status feedback while preserving the app's local-first privacy posture.

## Capabilities

### New Capabilities

- `premium-onboarding-workflow`: Covers the first-run and re-import guided workflow, premium onboarding shell, clear state machine, import wizard, live-sync next actions, and UI progress feedback.

### Modified Capabilities

- `whatsapp-style-thread-view`: Replace collapsed raw import path controls with the guided import/re-import entry point and preserve archive browsing once onboarding is complete.

## Impact

- Client UI: major redesign of onboarding, import, and live-sync panels in `src/client/App.tsx`, `src/client/api.ts`, and `src/client/styles.css`.
- Server/API: new local endpoints for file selection/import staging if available, key verification, import mode selection, progress streaming, and live QR/pairing status.
- Import pipeline: expose progress events over a local UI channel and support clear-and-replace import mode.
- Live maintainer: expose UI-driven link, pause/resume, unlink, and state summaries while preserving baseline gating and read-only guardrails.
- Tests/docs: add UI/API tests for onboarding states, import wizard choices, progress events, and live-sync state labels.
