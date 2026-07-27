---
name: propose-apply-verify
description: Drive one roadmap change end to end in a single session — /opsx:propose, then /opsx:apply, then an autonomous iterative verification loop (CLI + browser) that fixes what it finds and ends with a verification report. Use when the user says "/propose-apply-verify <change>", "do <change> end to end", "propose, build and verify <change>", or wants a change taken from seed to verified without manual checking.
---

# Propose → Apply → Verify

Take ONE named change from seed to **implemented and independently verified** in a single run: expand it into artifacts, implement every task, then verify the result yourself — iterating on fixes until everything passes or a genuine blocker needs the user. The user's role is to read the final report and, if they choose, repeat the verification steps as confirmation; it is **not** to perform verification for you.

**Input**: the change name — `/propose-apply-verify <change-name>`. If omitted, infer it from conversation context; if ambiguous, list active changes and ask. Announce: "Driving change: `<name>` — propose → apply → verify."

Archiving is deliberately NOT part of this skill. It ends by offering `/opsx:archive`, because archiving merges spec deltas and updates docs — a step the user may want to review first.

## Phase 0 — Pre-flight (quick, don't ceremonialize)

- Run `npm run roadmap:sync`, then read the change's row in `openspec/changes/ROADMAP.md`. Unlike other repos, wapp-brain proposals carry **no Model/Gate banner** — the **Model** cell and the **Checkpoint (gate)** cell in the Change Inventory table are the authority.
- If the session model is a lower tier than the Model cell names, say so and let the user decide whether to continue.
- Read the change's `proposal.md`, and note both gate sources the loop must cover: the roadmap's Checkpoint cell **and** the final "Verification on the live archive" (or equivalent gate) section of `tasks.md`.
- Confirm a clean-enough baseline: `git status` scoped to intended work; `npm test` green before starting if the tree is dirty from unrelated work.
- Check the live environment before assuming anything about it:
  - A dev server is often already running on port **3600** (client on 5900). Check before starting another.
  - `better-sqlite3` is a **single writer** — never run a CLI command against `archive.sqlite` while the server holds it. Stop the server, or work on a copy (a copied DB carries the real ledger caps).
  - Never run the live maintainer under `tsx watch` with real credentials.

## Phase 1 — Propose

Run the `/opsx:propose <name>` flow (the `openspec-propose` skill). If `openspec status --change <name>` already shows all artifacts complete, skip straight to Phase 2 and say so. After artifacts land, run `npm run roadmap:sync`.

## Phase 2 — Apply

Run the `/opsx:apply <name>` flow (the `openspec-apply-change` skill): read the context files, implement every task, check each `- [x]` off as it completes, run `npm run roadmap:sync` once implementation begins. Pause only for genuine design conflicts — prefer momentum plus a recorded decision over stopping to ask.

## Phase 3 — Verify, fix, re-verify (the heart of this skill)

Verify **independently, with whichever tools are most effective** — the CLI, the browser pane against a real build, or both. Do not ask the user to carry out manual verification unless an action is genuinely impossible without them (real WhatsApp hardware/credentials, a quota or model-access decision, confirming a destructive wipe).

Run as a loop, not a checklist:

1. Verify thoroughly (everything applicable below).
2. Identify every bug, regression, incomplete behavior, or surprise.
3. Fix everything you can.
4. Re-run the verification relevant to each fix, plus the full gates.
5. Repeat until all checks pass, or a genuine blocker remains that only the user can clear. **Never stop at the first successful-looking result** — check edge cases, console errors, network traffic, server logs, and both automated and manual-equivalent paths before calling it done.

### Always (any change) — from AGENTS.md

- `npm test` — green. This repo has **no `lint`, `typecheck`, or `test:e2e` script**; don't invent gates that don't exist.
  - If exactly one test times out and it varies run to run, that's contention, not regression — re-run with `npm test -- --testTimeout=30000` to tell them apart before "fixing" anything.
  - Never bypass `tests/setup/vault-isolation.ts`. Config paths default to the user's **real** `.wapp-brain/`; that setup file is the only thing keeping the suite from deleting the live vault.
- `npm run doctor` — clean.
- `npm run build` — clean. This is also the typecheck (`tsc -p tsconfig.json` + `vite build`). Skip it only for docs-only work where keeping `dist/` out of the worktree matters.

### When applicable — derive from what the change touched

- **Schema** (new/changed tables or columns): DDL, ordered table lists, and the additive-migration list in `sqliteRepository.ts`, mirrored in `memoryRepository.ts`; re-import stays idempotent; `npm run doctor` clean on a real-shaped DB. A new table with no test is an incomplete change.
- **Retrieval-affecting**: `npm run brain:eval -- --gate` — golden-set recall@k per class at or above the baseline with the same golden hash. Anecdotal spot queries are not a gate; a cross-hash comparison must be labelled as one.
- **Brain producers / extraction contract**: **scope every model run to one chat** (`npm run brain:run -- --chat <id>`). An unscoped run pegs CPU and wedges the live server on the 326k-message archive. Check `fallback_reason` for the real provider error rather than assuming a 400 was transient.
- **Docs/vault projection**: `npm run brain:docs project`. The vault is a pure projection, so the real test is a delete → rebuild round-trip restoring the files intact.
- **Privacy surface** (any new public DTO field, log line, or status payload): the suite's privacy canaries must cover it. Message bodies, coordinates, vCard bodies, transcripts, receipt data, and keys never leave the local detail endpoints — a new field without a canary is an incomplete change.
- **UI surfaces**: run the app and inspect it — dev via the browser pane's `server` (3600) + `client` (5900) launch configs, or the production path (`npm run build` then `npm run preview`).
  - **Screenshot and click tools time out in this repo regardless of load.** Verify through `javascript_tool` (fetch the API, read the DOM, `_cyreg.cy` for Cytoscape), `read_page`, `read_console_messages`, and `read_network_requests`. Zero console errors; zero unexpected requests (read the network log, don't assume).
  - Show progress for anything ≥~1s and never block the event loop; failures must be visible in the UI **and** the server console, never silent.
  - No raw JSON in the UI — inferred vs authoritative must be distinguishable, with freshness stated.
- **Per-node / per-row surfaces**: bulk-query or wedge. A surface issuing one query per node dies on the real archive — prove it against a copy of the live DB, not a fixture, and benchmark under the status-poll cadence.
- **Demo mode** (anything touching the config seam): `npm run demo` provisions and serves the synthetic workspace on port **3610** against `.wapp-brain-demo`; the real `.wapp-brain/` is untouched (inventory/mtime before vs after); live/Google/provider endpoints refuse.
- **Background servers you started**: stopping the task orphans the node child on Windows — kill by port PID and verify the port is free.
- **The change's own gate**: the roadmap Checkpoint cell and every clause of the `tasks.md` verification section — verify each literally, and say which test or action proved it.

### Rules of the loop

- Fixes discovered here are part of THIS change — fix, re-verify, and note them in the report. Work beyond the change's scope goes to `openspec/todos/`, not into silent scope creep.
- If a pre-existing test breaks because the change legitimately altered the UI/contract, fix the test to assert the same intent precisely — never delete or weaken an assertion to get green.
- Breaking changes and wipe-and-regenerate are sanctioned for derived data (the roadmap's standing sanction); the **archive layer is sacred**. If a gate needs a wipe of real derived data, that's a 🧍 item for the user, not a unilateral call.
- Prefer real verification over asserting success. If a gate was not run, the report must say so.

## Phase 4 — Report, then hand back

End with a concise report containing, in order:

1. **The verification steps the user would normally have been asked to perform.**
2. **Which steps you completed yourself, and whether you used the browser, the CLI, or both.**
3. **The bugs or issues you identified.**
4. **The fixes you made.**
5. **The verification you repeated after each fix.**
6. **The final status of all checks** (one line per gate).
7. **Any remaining blockers or limitations that genuinely require the user** — prefix with 🧍.

Only after the full loop is complete, tell the user they can repeat the listed steps themselves as a final confirmation — and offer the next actions: `/opsx:archive <name>` (merges spec deltas, updates the docs the proposal named), and `/next-change` for what follows. **Never stage or commit anything unless the user explicitly asks** — they curate their own staging.
