## Context

The current app exposes a technical sidebar rather than a guided workflow. In the screenshot that triggered this change, the Live Sync panel says `not configured`, also says the imported archive baseline is ready, and still shows `Stop Live Sync` and `Unlink Live State`. That is technically explainable but product-hostile: a user cannot tell whether WhatsApp is linked, whether syncing is active, or what to do next.

The import flow has the same issue. It asks for local paths, keys, and options inline, which is acceptable for CLI users but poor for a premium desktop/local app experience. The app needs a first-run journey that explains the order of operations and does the local work through direct file selection, verification, confirmation, and progress.

Constraints:

- WhatsApp data and keys stay local.
- Browser file picker access is limited by web platform security; selected files can be uploaded only to the local `127.0.0.1` server, while folder picking may need `webkitdirectory` or a path fallback.
- The existing CLI import path remains valuable and should continue working.
- Live sync must remain gated by a recent imported baseline.
- Visual polish is desired, but it cannot hide ambiguous state.

## Goals / Non-Goals

**Goals:**

- Make the setup order obvious: import backup first, then link live sync, then browse/monitor.
- Replace inline path fields with a premium import modal/wizard using file pickers where possible.
- Verify the backup key before import and show clear success/failure before asking merge/replace.
- Let users choose merge with existing archive or clear-and-replace before import starts.
- Show import progress in the UI with phase-specific bars and status text comparable to the CLI.
- Make live sync state unambiguous and action-specific.
- Provide a first-run/onboarding experience that feels polished, animated, and premium without compromising readability or privacy.

**Non-Goals:**

- No remote upload or hosted import.
- No removal of CLI import workflows.
- No automatic live linking before a backup baseline exists.
- No promise that browser folder pickers work identically on every browser; provide graceful fallback.
- No marketing landing page. The first screen is still the working app/onboarding flow.

## Decisions

### Use A Guided Setup State Machine

Derive a setup state from `/api/status` and `/api/live/status`:

- `empty_archive`: no import run or no messages.
- `baseline_too_old`: archive exists but latest message is outside recovery limits.
- `baseline_ready_unlinked`: archive is ready, live session is not linked.
- `linking`: pairing QR/code is active.
- `syncing`: live session connected and maintainer running.
- `paused`: live session exists but maintainer is stopped.
- `disconnected`: live session exists but the client is disconnected.
- `needs_attention`: live gaps are open or uncertain.

Rationale:

- The UI can show exactly one primary action for each state.
- Stop/unlink controls appear only when they make sense.
- Baseline readiness becomes a prerequisite explanation, not a confusing badge beside unrelated controls.

Alternatives considered:

- Keep collapsible panels and tweak labels. Rejected because the information architecture is the problem, not just wording.
- Hide live sync entirely until import. Rejected because showing the future step helps users understand the full setup path.

### Introduce A Premium Onboarding Shell

Use a top-level onboarding/status area above the chat browser when setup is incomplete or attention is needed. Use rich visual treatment, motion, and confident hierarchy:

- large phase heading and concise status copy;
- three-step progress rail: Backup, Archive, Live Sync;
- primary action button for the current step;
- secondary details only after expansion;
- tasteful animated gradients or shimmer on progress surfaces, but no decorative clutter.

Rationale:

- The user asked for maximum premium feeling, but the app is still an operational archive tool. Polish should improve orientation and trust.

### Replace Inline Import Fields With A Wizard

The import/re-import action opens a modal wizard:

1. Select backup files.
2. Enter key or select key file.
3. Verify key locally.
4. Choose merge or replace.
5. Import with progress.
6. Review completion and warnings.

Rationale:

- Users should not need to paste paths into a desktop-like local app.
- Key verification before import prevents long-running failures and gives confidence.
- Merge/replace is a destructive decision and deserves an explicit confirmation step.

### Keep File Selection Local

For browser-based UI, selected files are posted to local endpoints that stage them under `.wapp-brain/import-staging/`. The app should prefer `input type=file` and local upload to the server, not raw path fields. A path fallback can remain for environments where the app cannot read selected folder structures.

Rationale:

- Browsers intentionally hide absolute file paths.
- A local file upload to `127.0.0.1` preserves privacy while enabling normal web file picker UX.

### Stream Import Progress

Expose progress over a local event stream or polling endpoint. Reuse `ImportProgressEvent` phases from the importer so UI and CLI report the same lifecycle. The UI should show:

- current step;
- file verification/decryption progress;
- message import progress;
- warning count;
- completion/failure state;
- privacy-safe log location if applicable.

Rationale:

- The CLI already has good phase/progress concepts.
- UI parity reduces implementation drift and makes verification easier.

### Clarify Live Sync Actions

Live Sync card actions by state:

- No baseline: `Import backup` primary, no stop/unlink.
- Baseline ready, unlinked: `Link WhatsApp` primary.
- Linking: show QR/pairing modal and `Cancel linking`.
- Connected/syncing: show `Pause sync`, `View gaps`, optional `Unlink device` in danger area.
- Paused: show `Resume sync`, `Unlink device`.
- Disconnected: show `Reconnect`, `Unlink device`.

Rationale:

- `Stop sync` means pause the maintainer, not unlink the WhatsApp companion device.
- `Unlink device/state` means remove local credentials and require relinking.
- Those two actions should never be shown as if they apply to an unconfigured state.

## Risks / Trade-offs

- Browser file APIs may not expose folders consistently -> Use file pickers for required files, `webkitdirectory` for media when available, and path fallback only as an advanced option.
- Large uploads to the local server could feel slow -> Stream/stage files with progress and avoid holding full backup files in browser memory when possible.
- Replace mode is destructive -> Require explicit confirmation and show archive counts before clearing.
- Premium visuals could reduce scanability -> Keep typography compact in operational areas and verify desktop/mobile layouts with screenshots.
- Live sync QR flow can expire -> Show expiry/retry state and regenerate QR cleanly.
- Staged files are sensitive -> Store under `.wapp-brain/import-staging/`, clean after import, and include doctor/cleanup coverage.

## Migration Plan

1. Add onboarding/status model and API fields needed for UI state derivation.
2. Add local import staging and key verification endpoints.
3. Add UI wizard shell, file pickers, key verification, merge/replace confirmation, and progress streaming.
4. Replace sidebar import controls with a compact import/re-import entry point.
5. Redesign Live Sync card actions around the state machine.
6. Add visual polish, responsive behavior, and motion with reduced-motion fallback.
7. Update tests and docs.

Rollback strategy:

- Keep CLI import and live commands unchanged.
- If the wizard is disabled, fall back to the existing import API and chat browser.
- Staged files can be removed by cleanup.

## Open Questions

- Should replace mode delete only archive data or also live checkpoints/session state?
- Should media folder import be part of the first wizard pass or remain optional/advanced until media ingestion exists?
- Should the QR/pairing flow live inside the app server at `127.0.0.1:3600` instead of a separate temporary port?
