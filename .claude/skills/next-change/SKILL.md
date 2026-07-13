---
name: next-change
description: Recommend the next roadmap change to work on, the Claude model to use for it, and a pre-flight checklist to verify before starting. Use when the user asks "what's next", "which change should I do", "what model should I use", "where are we on the roadmap", or wants a roadmap status/health check.
---

# Next Change Advisor

Answer three questions from the live state of the repo: **what change to do next, with which model, and what to verify before starting.** The single source of truth is `openspec/changes/ROADMAP.md`; never recommend from memory alone — always re-derive from files, because statuses drift as changes are proposed, implemented, and archived.

## Workflow

1. **Reconcile, then load the roadmap.** First run `npm run roadmap:sync` (equivalently `node openspec/tools/sync-roadmap-status.mjs`) — a deterministic reconciler that derives each change's Status from folder state (`changes/` + `archive/`) and rewrites only the leading status-icon cell and the Status word cell (seeded blank, then `📝`/`🔄`/`✅`), so the board is accurate before you read it. It works identically from any agent (Claude, Codex, or a plain shell) and is idempotent. Then read `openspec/changes/ROADMAP.md` in full: the Change Inventory table (numbers, Model column, hard dependencies, checkpoints), Execution Waves, the Clean Slate & Breaking-Change Sanction, and Standing Principles.

2. **Read each candidate's folder for progress detail.** Step 1's reconciler already refreshed the Status cells from folder state (that's the deterministic part — don't re-adjudicate or hand-edit the table), so the coarse state is trustworthy. Read the folders for the detail the table can't carry — task counts, which `- [x]`/`- [ ]` remain, and whether only gate items are left:
   - Archived → folder moved under `openspec/changes/archive/` → **done**.
   - Folder has `tasks.md` → expanded; count `- [x]` vs `- [ ]` → **in progress** (report progress and whether only PHASE GATE / user-verification items remain). Exclude tasks under a "PHASE RETIRED" or "SUPERSEDED" banner from the open count (`build-the-brain` keeps retired phases for the record — only its non-retired open tasks are real work).
   - Folder has only `proposal.md` + `.openspec.yaml` → **seeded** (needs `/opsx:propose` before implementation).
   - In the inventory but no folder anywhere → flag as drift; recommend fixing the roadmap.

3. **Compute unblocked work.** A change is unblocked when every hard dependency in its inventory row is done (archived, or all tasks checked with its gate passed). Order candidates by wave (A→H), then by number. Note soft/"recommended-first" orderings from the dependency cells but do not treat them as blockers.

4. **Recommend.** Lead with ONE primary recommendation — the earliest-wave unblocked change that advances the critical path (the chain toward `episode-contract-v2` → eval → backfill → semantic tier). Then list genuinely parallel options separately (e.g. `client-route-architecture`, `retrieval-hardening`, the #16–18 verify-and-archive closeouts) so the user can multi-track. If a change is in progress with open non-gate tasks, recommend finishing it before opening a new one.

5. **State the model.** Read the recommended change's Model cell (also echoed in its proposal banner). Tell the user to start the working session on that model before running `/opsx:propose` or implementing (Fable / Opus / Sonnet — chosen per the rationale note under the inventory table; mention the rationale in one clause).

6. **Build the pre-flight checklist** for the recommended change. Always derive it from the change's own `proposal.md` (read it) plus repo state, and include whichever of these apply:
   - **Workflow step**: if the change is seeded, the first action is `/opsx:propose <change-name>` to expand it into design/specs/tasks — not writing code.
   - **Dependency gates**: list any dependency whose tasks are checked but whose PHASE GATE / user-verification item is still open — those need the user's manual verification first (name the exact gate task).
   - **Clean baseline**: `git status` clean or intentionally scoped; `npm test` green before starting; note the current branch.
   - **Data implications**: whether the change plans a wipe or breaking schema change (the standing sanction allows it — archive layer only is sacred); whether the dev server should be stopped or restarted; whether `.wapp-brain/` derived files are affected.
   - **Context to load**: the change's proposal, the relevant design decisions in `openspec/changes/build-the-brain/design.md` (D1–D13), and any spec deltas the proposal names under Capabilities.
   - **Live-environment cautions** that apply to this repo: the server usually runs on port 3600 (check before assuming it's down); never run the live maintainer under `tsx watch` with real creds; better-sqlite3 is a single writer — no second process on the DB while the server runs.
   - **User-only items**: anything in the checklist only the user can do (run verification gates on the real archive, provide quota/model access, confirm a wipe) — call these out explicitly so they aren't discovered mid-change.

7. **Report — use EXACTLY this output template.** Formatting rules: every bullet is ONE line (hard limit ~100 chars); no multi-line paragraphs anywhere; bold key at line start; pre-flight items are `- [ ]` checkboxes so the user can tick them off; omit a section entirely if it's empty (except Do next and Pre-flight, which always appear).

   ```markdown
   ## Roadmap — Wave <X> · ✅ <N> archived / 🔄 <N> in progress / <N> seeded

   ## ▶ Do next: `<change-name>` (#<n>)

   | | |
   |---|---|
   | **Why now** | <one line> |
   | **Model** | <Fable/Opus/Sonnet> — <5-word rationale> |
   | **First action** | `/opsx:propose <change-name>` (or the concrete implement step) |

   ## Pre-flight

   - [ ] <one line per item, imperative, most blocking first>
   - [ ] 🧍 <user-only items prefixed with 🧍 so they stand out>

   ## Parallel options

   | Change | Model | One-line note |
   |---|---|---|

   ## Waiting on you
   - <gate-only items: change → exact gate task, one line each>

   ## ⚠ Drift
   - <mismatch → one-line fix; omit section if none>
   ```

## Rules

- Never skip re-reading ROADMAP.md and the candidate's proposal — recommendations must reflect the files as they are now.
- Never recommend starting archive-scale assimilation (backfill, large model runs) unless `episode-contract-v2`, `identity-late-resolution`, and `brain-eval-harness` are all done — this is the roadmap's contract-before-spend gate.
- If the user asks a narrower question ("what model for X?", "is Y blocked?"), answer just that from the same derivation; don't dump the full briefing.
- When a change finishes, remind the user to `/opsx:archive` it — the status-icon + Status cells reconcile automatically from folder state (this skill runs `npm run roadmap:sync` first), so no manual status stamping is needed. The definition of done is every folder under `openspec/changes/` archived.
