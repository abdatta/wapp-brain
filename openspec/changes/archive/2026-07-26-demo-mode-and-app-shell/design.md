# demo-mode-and-app-shell — Design

## Context

Every path the app touches hangs off one seam: `config.ts` derives archive, media, live-auth, brain, memory, trace, and Google-credential locations from `workDir` (`WAPP_WORK_DIR`, default `.wapp-brain`). The synthetic-fixture machinery (`src/server/import/fixtures.ts`) already produces importable WhatsApp-shaped databases, including a signal-capture variant with mentions, locations, vCards, edits, and link previews. The brain has a zero-model `extractive` provider whose output is mechanical but citation-complete, so a brain pass can run with no external calls. The client has a persistent shell (`AppShell.tsx`) with a topbar, nav, onboarding banner, and status context — but no notion of which workspace the server is showing, and a decorative dark-theme button that does nothing.

Live sync against the real archive is typically running on this machine (port 3600, `tsx watch`); a demo instance must be able to coexist with it.

## Goals / Non-Goals

**Goals:**

- One command takes a fresh checkout (plus `npm install` + `npm run build`) to a browsable, populated app with zero real data and zero external calls.
- A demo process is *provably* incapable of touching the real workspace: isolation by construction at the config seam, not by discipline at call sites.
- Anyone glancing at a screen — window title or topbar — can tell demo data from real data.
- Deterministic provisioning: the same code version always produces the same demo archive, so screenshots and walkthroughs are reproducible.

**Non-Goals:**

- No synthetic *model-tier* brain content. The demo brain is whatever the real extractive pass yields (episodes with citations). Graph, rollup pages, and commitments surfaces may be sparse or empty in demo — they show their real empty states. Hand-seeding fake claims/graph rows via repositories would bypass the extraction contract; deliberately excluded. A future `demo-brain-seeder` can revisit.
- No light theme. The dead theme button is removed, not implemented.
- No changes to real-mode behavior beyond the removed decorative button.
- No packaging/distribution work ("app shell" here is the client shell, not an Electron/desktop shell).

## Decisions

### D1. Pivot at the config seam; ignore path overrides in demo mode

`WAPP_DEMO=1` makes `config.ts` set `workDir` to the demo workspace (`.wapp-brain-demo`) and **ignore** `WAPP_WORK_DIR`, `ARCHIVE_DB_PATH`, `WAPP_MEMORY_DIR`, and `WAPP_MEMORY_CODEX_SESSION_PATH`. Every derived path then lands under the demo workspace automatically — including future paths added to config. `config.demo: boolean` is the single flag the rest of the system reads.

*Alternative considered*: per-subsystem demo flags or a parallel config object — rejected; one seam covers all current and future paths and cannot be partially forgotten.

*Addition during implementation*: `WAPP_DEMO_DIR` relocates the demo workspace (needed by the spawned-server guard tests, useful for alternate disks). It is refused when it resolves to the real workspace — env-configured or default — so the isolation guarantee is not one env var away from meaningless.

Forced in demo mode regardless of env: `WAPP_BRAIN_PROVIDER=extractive` (and provider enablement refuses), `WAPP_MEMORY_PROVIDER=local`, `WAPP_MEMORY_REMOTE_MODEL_ENABLED=false`, `LIVE_AUTO_RESUME=false`. `APP_PORT` stays respected but its *default* becomes 3610 so a demo instance runs beside the real server on 3600.

### D2. Env var set by the CLI entry, before config loads

`npm run demo` runs `tsx src/server/cli.ts demo`. The CLI detects the `demo` / `demo-reset` subcommand **before importing any app module**, sets `process.env.WAPP_DEMO = "1"`, then dynamically imports the rest. This avoids Windows-hostile inline env syntax in npm scripts and a `cross-env` dependency. `WAPP_DEMO=1 npm run dev` (or a `$env:WAPP_DEMO="1"` PowerShell session) remains available for dev iteration; the vite dev proxy targets port 3600, so dev-mode demo requires `APP_PORT=3600` (documented, secondary path).

### D3. Provision-if-missing, through the real pipelines

`demo` provisions only when the demo archive is missing or carries no messages, then serves. Provisioning steps, all real code paths, with step-by-step console progress (ops ≥1s must show progress):

1. Generate the curated demo backup (`createDemoFixture` in `fixtures.ts`) into `<demoWorkDir>/source/`.
2. Import it with the real importer (same entry the `import` CLI uses) into the demo archive.
3. Run the extractive brain pass (real assimilation entry, provider = extractive).
4. Build the search index.
5. Write a `demo-manifest.json` (fixture version, counts) used for the idempotency check and shown by `demo --status`.

`demo-reset` deletes the demo workspace (never anything else) after an explicit `--yes` or interactive confirm, so re-provisioning is one command. If `dist/` is missing, `demo` still provisions but tells the user to run `npm run build` (or use the dev path) before serving fails.

*Alternative considered*: checking in a pre-built demo archive — rejected; a binary sqlite in git rots against schema changes, while provisioning through the real importer + extractor stays correct by construction and doubles as an end-to-end smoke test.

### D4. Curated deterministic demo dataset

One new fixture scenario, fixed content, fixed absolute timestamps (spread over ~3 weeks), fixed ids, no randomness: ~8 named contacts, two 1:1 chats and two groups (a trip-planning group with reactions, a quoted reply, a shared link with preview, an edit; a family chat with media placeholders and a voice-note placeholder). Innocuous fictional content only. The scenario reuses the signal-capture table shapes where cheap so the thread view shows reactions/quotes/edits. Media are placeholders (no blobs) — the media UI shows its real "not archived" states, which is honest and fine for demo.

### D5. Guards are server-enforced, client-explained

In demo mode the server refuses: live link/pair/resume routes, Google OAuth start/callback, brain provider enable/select of model-backed providers (all `409` with a stable `{ demo: true, message }` shape). The client reads `demo` from the status DTO and disables those affordances with a short explanation instead of letting the user hit the 409. Server-side enforcement is the guarantee; client-side is UX.

### D6. Demo presentation in the shell

- Status DTO gains `demo: boolean` (plus the demo workspace path for the settings surface).
- Topbar: an amber `Demo data` badge beside the `127.0.0.1` badge; brand subtitle switches to "Synthetic demo archive".
- Document title: `Wapp Brain — Demo` while demo, via the shell.
- Onboarding banner: suppressed in demo mode (its import → link → resume ladder is meaningless there); a one-time demo notice toast on first load explains what the instance is.
- The decorative Moon button is removed.

## Risks / Trade-offs

- **[Hardcoded `.wapp-brain` references outside config]** → audit with a repo grep during implementation; anything found is a bug to fix (must derive from config), covered by an isolation test that provisions a demo workspace in a temp dir and asserts the real-path defaults are never touched.
- **[Demo workspace committed by accident]** → add `.wapp-brain-demo/` to `.gitignore` in the same commit that introduces the name; contents are synthetic, but the repo should not carry generated sqlite either way.
- **[Provisioning drift: importer/extractor changes alter demo output]** → intended, not a risk to correctness — the manifest records the fixture version; `demo-reset` regenerates. Tests assert structural invariants (counts, chats present, episodes exist), not byte-exact hashes.
- **[Sparse brain surfaces undersell the product]** → accepted for this change (see Non-Goals); the archive surfaces (chats, thread, search, contacts) are the demo's substance and are fully populated.
- **[Port default change surprises]** → only the *demo* default is 3610; real-mode default stays 3600. Printed clearly at demo startup.
- **[Two servers, one machine: orphaned processes]** → demo serves in the foreground and prints its port; the existing Windows orphan hazard (kill by port PID) is unchanged but demo's distinct port keeps the two instances distinguishable.

## Migration Plan

Purely additive; no schema or data migration. Rollback = delete the demo workspace and the new code paths. Real-mode behavior changes only by the removed decorative button.

## Open Questions

- None blocking. If the extractive pass ever grows entity/claim output rich enough to populate the graph, the demo inherits it for free.
