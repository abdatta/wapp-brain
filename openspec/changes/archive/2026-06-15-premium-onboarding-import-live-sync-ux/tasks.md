## 1. Setup State And API

- [x] 1.1 Add a derived setup/onboarding state model that combines archive status, import history, baseline readiness, live session state, maintainer state, and gap health.
- [x] 1.2 Extend local status endpoints to expose privacy-safe fields needed by the onboarding and live-sync UI states.
- [x] 1.3 Add server tests for empty archive, baseline too old, baseline ready unlinked, linking, syncing, paused, disconnected, and needs-attention states.
- [x] 1.4 Update shared client types and status-fetching hooks to consume the new setup state without duplicating state derivation in components.

## 2. Import Wizard Backend

- [x] 2.1 Add local import staging under `.wapp-brain/import-staging/` with per-session directories and cleanup on cancel, completion, and failure where safe.
- [x] 2.2 Add local upload endpoints for required `msgstore.db.crypt15` and optional `wa.db`, key file, and media inputs, with size/status progress and privacy-safe errors.
- [x] 2.3 Add a key verification endpoint that validates a provided raw key or key file against the selected encrypted backup before import starts.
- [x] 2.4 Add merge and clear-and-replace import modes to the UI-driven import path while preserving existing CLI import behavior.
- [x] 2.5 Expose import progress through polling or an event stream using the existing importer progress phases and warning summaries.
- [x] 2.6 Add backend tests for staging cleanup, key verification success/failure, merge mode, replace mode, and progress reporting.
- [x] 2.7 Add active import discovery, cancellable jobs, and archive restore-point rollback for stopped UI imports.
- [x] 2.8 Add privacy-safe server logs for UI import job progress and terminal states.
- [x] 2.9 Show interactive terminal progress bars for UI imports run through the local server/dev server.
- [x] 2.10 Yield between message import batches so UI polling can stay current during large imports.

## 3. Import Wizard UI

- [x] 3.1 Replace inline import path fields with an import/re-import action that opens a guided modal wizard.
- [x] 3.2 Build the file selection step with file pickers for crypt backup, optional `wa.db`, optional key file, optional media folder, and advanced path fallback.
- [x] 3.3 Build the key entry and verification step with local-only privacy copy, success state, failure state, and disabled progression until verification succeeds.
- [x] 3.4 Build the merge versus clear-and-replace step with archive counts and an explicit destructive confirmation for replace.
- [x] 3.5 Build the import progress step with phase-specific progress bars, counts, warnings, cancellation/failure states, and completion handoff to the next setup action.
- [x] 3.6 Add UI tests for first import, re-import merge, re-import replace confirmation, verification failure, and import completion.
- [x] 3.7 Reattach the import wizard after browser refresh and add a confirmed stop-import action.

## 4. Live Sync UI Flow

- [x] 4.1 Replace misleading unconfigured-state actions with `Link WhatsApp` when the baseline is ready and `Import backup` when it is not.
- [x] 4.2 Build a UI pairing flow that starts linking, shows QR or pairing-code status, handles expiry, and updates automatically on successful connection.
- [x] 4.3 Separate pause/resume maintainer actions from unlink-device actions, with unlink behind explanatory confirmation.
- [x] 4.4 Surface gap health, last activity, disconnected state, and baseline-too-old warnings as state-specific guidance rather than always-visible technical fields.
- [x] 4.5 Add UI/API tests for ready-unlinked, linking, active sync, paused sync, disconnected, no-baseline, and unlink confirmation scenarios.

## 5. Premium Onboarding Presentation

- [x] 5.1 Build the guided setup surface with backup/archive/live-sync phase rail, one primary action per state, and compressed status mode after setup.
- [x] 5.2 Apply premium visual treatment with polished gradients, motion, status transitions, and depth while preserving dense browse ergonomics.
- [x] 5.3 Add responsive layouts for narrow sidebar/mobile widths and desktop widths, ensuring no text or controls overlap.
- [x] 5.4 Add reduced-motion support for animated onboarding and progress surfaces.
- [x] 5.5 Review colors and layout against the app design constraints, avoiding decorative clutter and preserving readability.

## 6. Documentation And Verification

- [x] 6.1 Update docs for UI import, key verification, merge/replace behavior, live linking, pause/resume versus unlink, and local staging privacy.
- [x] 6.2 Update doctor/cleanup behavior and documentation to account for sensitive import staging directories.
- [x] 6.3 Run `npm test` and fix any regressions.
- [x] 6.4 Run `npm run doctor` and fix any regressions.
- [x] 6.5 Run `npm run build` because this change affects frontend/API production behavior.
- [x] 6.6 Start the local app and inspect the onboarding, import wizard, and live-sync states in the browser at desktop and narrow widths.
