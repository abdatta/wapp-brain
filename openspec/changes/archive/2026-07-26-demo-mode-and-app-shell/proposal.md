# demo-mode-and-app-shell

## Why

Every surface of the app can only ever be run against the user's real WhatsApp archive — there is no way to demonstrate, screenshot, screen-share, or develop the UI without highly private data on screen, and no safe playground to explore the product before importing a real backup. The synthetic-fixture machinery stops at "importable test databases": nothing provisions a fully populated, isolated app instance (archive + brain + search) in one command, and the app shell has no notion of which workspace it is showing, so real and synthetic data would be indistinguishable at a glance — a privacy hazard in exactly the screen-sharing situations demo mode exists for.

## What Changes

- **Demo workspace isolation**: a `WAPP_DEMO=1` boot pivots every path the app owns (archive, media, live auth, brain, memory, traces, Google credentials) to a separate demo workspace (`.wapp-brain-demo/` by default). In demo mode, explicit `WAPP_WORK_DIR` / `ARCHIVE_DB_PATH` overrides are ignored so a demo process can never read or write the real `.wapp-brain/`.
- **One-command provisioning**: `npm run demo` provisions the demo workspace when missing — generates a curated deterministic synthetic backup (named contacts, 1:1 and group chats, reactions, quoted replies, media placeholders, links, edits), imports it through the real importer, runs a zero-model extractive brain pass, and builds the search index — then serves the app. `npm run demo:reset` wipes only the demo workspace.
- **External side-effect guards**: in demo mode, live-sync auto-resume is off and pairing/link endpoints refuse with a clear message; Google Contacts OAuth endpoints refuse; model-backed brain providers cannot be enabled (extractive only). A demo instance makes no external calls and spends no model budget.
- **Demo-aware app shell**: the server's status DTO carries the demo flag; the shell shows an unmistakable "Demo data" badge in the topbar, suppresses the real-data guided-setup banner in favor of demo copy, disables the guarded actions (pair, Google connect, model-provider enablement) with explanations instead of dead errors, and stamps the document title so even a bare browser tab is identifiable as demo.
- **Shell honesty cleanup**: the decorative dark-theme button in the topbar (renders, does nothing) is removed.

## Capabilities

### New Capabilities

- `demo-mode`: isolated demo workspace and its guarantees — path pivoting, ignore-real-overrides rule, one-command deterministic provisioning, external side-effect guards (live sync, Google OAuth, model providers), demo flag in the status API, and the shell's demo presentation (badge, onboarding copy, disabled-with-explanation actions, document title).

### Modified Capabilities

_None._ Existing specs describe normal-mode behavior and keep doing so; every mode-conditional requirement (what live sync, Google OAuth, providers, onboarding, and the shell do *when in demo mode*) lives in the new `demo-mode` spec, so no existing requirement text changes. The decorative theme-button removal touches no spec — `client-navigation` never required it.

## Impact

- **Server**: `src/server/config.ts` (demo pivot + flag), status DTO (`demo` field), live-sync start/pairing routes and auto-resume gate, Google Contacts OAuth routes, brain provider enablement (`src/server/brain/provider.ts`), new `demo` / `demo-reset` CLI commands (`src/server/cli.ts`).
- **Fixtures**: a curated demo scenario in `src/server/import/fixtures.ts` (reusing the existing synthetic-fixture machinery, including the signal-capture tables where cheap).
- **Client**: `src/client/shell/AppShell.tsx` (badge, title, theme-button removal), `OnboardingBanner.tsx` (demo copy), status context type, and the surfaces owning guarded actions (settings live panel, contacts Google section, brain provider controls).
- **Scripts**: `package.json` gains `demo` and `demo:reset`.
- **Tests**: config pivot isolation, provisioning determinism + idempotency, guard refusals, status DTO flag. Existing vitest setup-file isolation keeps tests off both real and demo workspaces.
- **No schema changes, no external dependencies, no model spend.** The real archive layer is untouched by construction.
