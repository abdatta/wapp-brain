# demo-mode-and-app-shell — Tasks

## 1. Config seam and isolation

- [x] 1.1 `src/server/config.ts`: read `WAPP_DEMO` before schema parsing; when set, pivot `workDir` to `.wapp-brain-demo`, ignore `WAPP_WORK_DIR` / `ARCHIVE_DB_PATH` / `WAPP_MEMORY_DIR` / `WAPP_MEMORY_CODEX_SESSION_PATH`, force `WAPP_BRAIN_PROVIDER=extractive`, `WAPP_MEMORY_PROVIDER=local`, `WAPP_MEMORY_REMOTE_MODEL_ENABLED=false`, `LIVE_AUTO_RESUME=false`, default `APP_PORT` to 3610, and export `config.demo: boolean`
- [x] 1.2 Add `.wapp-brain-demo/` to `.gitignore` (and to doctor's required ignore patterns)
- [x] 1.3 Grep the server for hardcoded `.wapp-brain` path literals outside `config.ts`; fix any found to derive from config (audit result: only gitignore-coverage patterns, help text, and display labels — no functional paths)
- [x] 1.4 Tests: demo pivot resolves every config path under the demo workspace even with real-path env overrides set; real mode (no flag) honors overrides unchanged

## 2. Curated demo dataset

- [x] 2.1 `src/server/import/fixtures.ts`: add `createDemoFixture(directory)` — deterministic curated scenario (~8 named contacts, two 1:1 chats, two groups; reactions, a quoted reply, a link preview, an edited message, image/voice media placeholders; fixed absolute timestamps over ~3 weeks; innocuous fictional content; no randomness), reusing the signal-capture table shapes where cheap
- [x] 2.2 Test: generate the demo fixture into a temp dir, import it with the real importer into a temp archive, and assert the expected chats/contacts/messages and at least one reaction, quote, and edit landed

## 3. Demo CLI: provision, serve, reset

- [x] 3.1 New entry `src/server/demo/cli.ts` that sets `process.env.WAPP_DEMO = "1"` **before** dynamically importing any app module (config loads at import time); subcommands: default (provision-if-needed + serve), `status` (print manifest/counts, don't serve), `reset [--yes]` (delete only the demo workspace). Added npm scripts `demo`, `demo:status`, `demo:reset`
- [x] 3.2 Provisioning pipeline in `src/server/demo/provision.ts`: generate demo fixture into `<demoWorkDir>/source/` → import via the real importer with terminal progress → run the extractive brain pass via the real assimilation entry → build the search index → write `demo-manifest.json` (fixture version + counts); skip provisioning when the demo archive already has messages; step-by-step console progress lines
- [x] 3.3 Serve step: reuse the real server bootstrap; if `dist/` is missing, print clear guidance (`npm run build`) instead of a raw crash; startup line prints demo port and demo workspace path
- [x] 3.4 Test: provisioning into a temp demo workdir populates archive + episodes + manifest; a second run skips provisioning; reset deletes only the demo dir (a sibling "real" dir is untouched)

## 4. Server guards and status

- [x] 4.1 Status DTO (`/api/status`): add `demo: boolean` and the demo workspace path; type it through the client status context
- [x] 4.2 Live guards: in demo mode `POST /api/live/link`, `/api/live/resume`, `/api/live/stop`, `/api/live/unlink`, and gap retry refuse with `409 { demo: true, message }`; auto-resume is already off via config (asserted by the spawned-server test's status)
- [x] 4.3 Google Contacts guards: OAuth start/callback and sync refuse the same way in demo mode
- [x] 4.4 Provider guards: brain provider enable/select of model-backed providers refuses in demo mode (HTTP route 409 + `assertNotDemo` in `brain/provider.ts` covering the CLI path); memory codex enablement/connect refuses; effective providers stay extractive/local
- [x] 4.5 Tests: guard endpoints return the stable refusal shape in demo mode and behave normally otherwise; provider enable attempt in demo mode leaves extractive effective

## 5. Demo-aware app shell

- [x] 5.1 `AppShell.tsx`: amber `Demo data` topbar badge and subtitle "Synthetic demo archive" when `status.demo`; set `document.title` to "Wapp Brain — Demo" in demo (restore otherwise); remove the decorative Moon theme button
- [x] 5.2 `OnboardingBanner.tsx`: render nothing in demo mode; show a one-time demo notice toast on first load explaining the instance is synthetic
- [x] 5.3 Guarded affordances read `status.demo` and render disabled with a short explanation: settings live-sync panel (demo notice replaces link/resume actions), contacts Google panel (demo notice replaces Connect), brain provider selects in the run console, commitments sweep, and docs rollup controls

## 6. Docs and end-to-end gate

- [x] 6.1 README: "Demo Mode" section — `npm run demo`, `npm run demo:reset`, isolation guarantees, default port
- [x] 6.2 `npm test` (56 files / 603 tests) and `npm run build` green
- [x] 6.3 Gate passed 2026-07-26: clean-state `npm run demo` provisioned (53 msgs / 4 chats / 11 contacts / 11 extractive episodes / search indexed) and served on 3610 beside the live real server on 3600; browser showed demo badge + "Wapp Brain — Demo" title, populated chats/thread (quote, edit, link preview), working search UI, brain coverage 100%, suppressed real-data onboarding, demo notices replacing live-sync + Google panels, disabled provider selects; all guard endpoints returned `409 { demo: true }` and the effective provider stayed extractive; status reported `demoWorkspacePath` under `.wapp-brain-demo` with real-path env overrides proven ignored by the spawned-server test (raw mtime comparison of `.wapp-brain/` is not meaningful while live sync writes to it — isolation rests on the config-pivot + guard tests); second boot skipped provisioning; zero console errors, zero failed network requests
