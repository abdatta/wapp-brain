# Brain Roadmap — Change Sequencing & Dependency Chart

> Written 2026-07-11, after the multi-agent architecture review (26 adversarially-verified findings). Governing strategy: **finalize the write contract → make quality measurable → then spend.** All brain data is derived and rebuildable, so wipe-and-regenerate replaces migration machinery everywhere; the only expensive do-over is re-running extraction over the archive, which is why `episode-contract-v2` gates the backfill.
>
> Each change listed below has a proposal-level seed at `openspec/changes/<name>/proposal.md`. Expand a change with `/opsx:propose` when its turn comes; proposals for later waves are deliberately lighter so earlier gates can inform them.
>
> **Ask `/next-change`** at any time for the current recommendation: which change to do next, which model to use, and the pre-flight checklist — derived live from this file and each change folder's actual state.

## Change Inventory

|  | # | Change | Model | Status | Hard dependencies | Checkpoint (gate) |
|---|---|--------|-------|--------|-------------------|-------------------|
| ✅ | 0 | `build-the-brain` (narrowed) | Opus | **archived 2026-07-12** | — (ops-spine remainder paired naturally with #3) | gates 2.7 / 3.8 passed live (scheduler, catch-up, crash-resume, staleness); archived to `archive/2026-07-12-build-the-brain` |
| ✅ | 1 | `brain-correctness-debts` | Opus | **archived 2026-07-12** | — | compound-cursor watermark, merge rekey, run honesty, startup probe, real usage — shipped; gates 11.1/11.3 test-covered, 11.2 verified live; archived to `archive/2026-07-12-brain-correctness-debts` |
| ✅ | 2 | `evidence-pack-fidelity` | Opus | **archived 2026-07-13** | — (#1 recommended first) | reactions/replies/forwards/number-labels visible in a real episode; week-bounded quiet-chat packs |
| ✅ | 3 | `episode-contract-v2` | **Fable** | **archived 2026-07-13** | #1, #2 | wipe + assimilate 2–3 chats: entities, absolute dates, hedges in claims; salvageable weak-model JSON |
| ✅ | 4 | `identity-late-resolution` | Opus | **archived 2026-07-14** | #3, #20 | save a contact → old episodes + search repair with zero model calls |
|  | 5 | `two-level-person-model` | **Fable** | seeded | #3 | same-name stays separate; Google same-contact auto-connects; disconnect re-derives, zero episode changes |
|  | 6 | `people-management-ui` | Sonnet | seeded | #4, #5, #19 | ranked hygiene queue; dismissed pair stays dismissed |
|  | 7 | `brain-eval-harness` | Opus | seeded | #3 | recall table + per-model precision/fallback tables on the real archive |
|  | 8 | `retrieval-hardening` | Opus | seeded | — (#7 soft, to measure delta; rename hook shared with #4) | typo'd query returns labelled relaxed results; "nhi" finds "nahi"; renamed contact searchable |
|  | 9 | `knowledge-graph-foundation` | Opus | seeded | #3, #5 | nodes/edges from claim entities; open commitment survives salience recompute |
|  | 10 | `commitment-lifecycle` | **Fable** | seeded | #2, #3, #9 | promise → reaction-acknowledged → cited closure; overdue flagged |
|  | 11 | `semantic-rollups` | **Fable** | seeded | #9, #10 (adjacent) | coherent cited entity pages; undeclared claim-drop refused; mechanical rollback |
|  | 12 | `brain-retrieval-pipeline` | **Fable** | seeded | #8, #9, #11, #19 (query-panel UI) | zero-keyword paraphrase recovered in deep mode; coverage verdict + gap sentences; one-call week summary |
|  | 13 | `mcp-agent-surface` | Opus | seeded | #5, #12 | Haiku-class client answers cited in ≤2 calls via `brain_ask`; attributed agent spend |
|  | 14 | `historical-backfill` | Opus | seeded | #0 (spine), #3, #4, #7 | kill-resume clean; coverage climbing; named budget stops |
|  | 15 | `memory-teardown-and-docs` | Sonnet | seeded | #12, #13 | no `memory_*` remnants; docs match reality; full suite green |
| ✅ | 16 | `native-import-picker` | Sonnet | **archived 2026-07-11** | — (independent of the brain chain) | gate 9.1 passed; archived to `archive/2026-07-11-native-import-picker` |
| ✅ | 17 | `import-media-cdn-recovery` | Sonnet | **archived 2026-07-12** | — (independent) | gates 6.1/6.2 passed on the real archive; archived to `archive/2026-07-12-import-media-cdn-recovery` |
| ✅ | 18 | `complete-media-archival` | Sonnet | **archived 2026-07-12** | — (independent; richer media improves evidence interpretation labels, no blocker either way) | gates 11.1/11.3–11.5 passed live with a real sender; archived to `archive/2026-07-12-complete-media-archival` |
| ✅ | 19 | `client-route-architecture` | Opus | **archived 2026-07-13** | — (pure client refactor; soft: before #7's grading strip, #13's grants UI, #14's dashboard) | every surface at its own URL, reload-safe; search deep links navigate routes; App.tsx reduced to a shell |
| ✅ | 20 | `demask-contact-labels` | Opus | **archived 2026-07-13** | — (independent of the brain chain; builds on the archived `identity-and-naming-integrity` capability) | masked-name counts on `contacts`/`chats` → ~0; former `+91∙∙∙∙∙∙∙∙86` senders read as full `+E.164` numbers in search + thread view; a re-assimilated chat's claims carry full numbers/names, no `∙` masks |
| ✅ | 21 | `reply-quote-recovery` | Opus | **archived 2026-07-14** | #3 (before #14) | backup-imported and live-synced replies share one snapshot; a *Reply Privately* group quote's full text reaches episode evidence and a truncated thread bubble; regeneration upgrades old episodes; pointer-only sources fall back with no regression |
|  | 22 | `archive-signal-capture` | Opus | seeded | #3 (before #14; feeds #5/#8/#9) | re-import a backup — number-change, structured mention, group join w/ timestamp, shared location, JID-resolved vCard, backfilled link preview, edit, and deletion each land; an evidence pack shows a mention/location/link/edit; a number-change feeds a person auto-connect |

**Model column** — the Claude model recommended to drive each change's `/opsx:propose` + implementation session. **Fable** where irreversible design judgment concentrates: #3 (the extraction contract is the system's embedding function — every episode ever written inherits it), #5 (person/identity semantics must be right forever), #10/#11 (lifecycle + anti-rot rollup machinery, the highest-rot vector, designed as a pair), #12 (ranking/fusion/coverage-verdict design — the product surface). **Opus** for everything demanding but well-specified by its proposal (core-transaction surgery, pack building, graph mechanics, refactors) — including `reply-quote-recovery` (#21) and `archive-signal-capture` (#22), where the design is pinned by WhatsApp's own storage model and the work is importer + schema + pack-rendering, not open contract judgment (their *utilization* is owned by the Fable/Opus consumer changes #5/#8/#9). **Sonnet** only where the path is fully paved: CRUD UI over decided tables (#6), deletion + docs (#15), and the three verify-and-archive closeouts (#16–18).

**Status icon (leading column) & Status column** — a human-readable projection of each change's lifecycle, shown twice: a glyph in the unlabeled leading column that reads like a to-do list filling in left to right, and the same state as a word in the Status column. The four states progress from `seeded` (blank cell — proposal seed only) → `📝 proposed` (`tasks.md` present) → `🔄 active` (a task checked) → `✅ **archived YYYY-MM-DD**` (folder under `archive/`). The **source of truth is the openspec files/folders** (a change's presence, its artifacts, and whether it lives under `archive/`); both cells are *derived* from them, never hand-stamped. Every lifecycle skill keeps them in sync by running the shared reconciler `npm run roadmap:sync` (`openspec/tools/sync-roadmap-status.mjs`), which writes the icon and the word from one derivation so they can't drift: `/opsx:propose|apply|archive` reconcile right after they change folder state, and `/next-change` reconciles on read as a safety net. It self-corrects manual drift and works identically from Claude or Codex. Run it anytime the table looks stale. (Re-theme the glyphs by editing the `ICONS` map in the reconciler and this legend.)

**Definition of done for this roadmap**: every folder under `openspec/changes/` is archived. Each change is `/opsx:archive`d after its checkpoint passes; #16–18 need only their verification gates (plus one test for #17) and can close in Wave A. This file itself is absorbed into the docs pass and retired at #15.

## Deferred & Demand-Gated (not yet seeded)

Identified future work that is deliberately **not** an inventory row yet — nothing is sequenced, budgeted, or gated on it until the data says it's worth doing. Seed each via `/opsx:propose` only when its trigger fires.

- **`media-interpretation`** — send image / audio / document *content* to the model (vision + voice-note transcription) so episodes reason over media, not just its text and kind-labels. Deliberately excluded from `episode-contract-v2` (3): the provider seam is text-only and multimodal is a large, separate spend. Instead, #3's **D13 `brain_media_gaps`** signal measures the demand — the model flags, per episode, when unavailable media **blocked** or **would have enriched** an inference, with `modality` derived at commit. **Trigger to seed**: the `brain_media_gaps` aggregate justifies the spend, and the modality split (audio vs image) sets the build order. Sibling of `brain-eval-harness` (7) in spirit — *measure, then spend*. Deps when seeded: **#3** (the signal, plus the `brain regenerate` path it targets — materiality-first, `impact='blocks'` episodes re-derived under a bumped `EXTRACTION_VERSION`); no new coverage machinery needed.

## Dependency Graph

```mermaid
graph TD
    C1[1 brain-correctness-debts] --> C3[3 episode-contract-v2]
    C2[2 evidence-pack-fidelity] --> C3
    C3 --> C4[4 identity-late-resolution]
    C3 --> C5[5 two-level-person-model]
    C3 --> C7[7 brain-eval-harness]
    C4 --> C6[6 people-management-ui]
    C5 --> C6
    C3 --> C9[9 knowledge-graph-foundation]
    C5 --> C9
    C2 --> C10[10 commitment-lifecycle]
    C9 --> C10
    C9 --> C11[11 semantic-rollups]
    C10 --> C11
    C8[8 retrieval-hardening] --> C12[12 brain-retrieval-pipeline]
    C9 --> C12
    C11 --> C12
    C5 --> C13[13 mcp-agent-surface]
    C12 --> C13
    C0[0 build-the-brain ops spine] --> C14[14 historical-backfill]
    C3 --> C14
    C4 --> C14
    C7 --> C14
    C12 --> C15[15 memory-teardown-and-docs]
    C13 --> C15
    C16[16 native-import-picker · verify+archive]
    C17[17 import-media-cdn-recovery · test+verify+archive]
    C18[18 complete-media-archival · verify+archive]
    C19[19 client-route-architecture] --> C6
    C19 --> C12
    C20[20 demask-contact-labels] --> C4
    C20 -.->|clean labels before the spend| C14
    C3 --> C21[21 reply-quote-recovery]
    C21 -.->|capture quotes before the spend| C14
    C3 --> C22[22 archive-signal-capture]
    C22 -.->|capture signals before the spend| C14
    C22 --> C9
    C22 -.->|number-changes, membership, vcards| C5
    C22 -.->|structured mentions, link previews| C8
```

## Execution Waves

Changes within a wave can run in any order or in parallel; a wave starts when its members' dependencies are met.

- **Wave A — now, parallel**: `brain-correctness-debts` (1), `evidence-pack-fidelity` (2). `retrieval-hardening` (8), `client-route-architecture` (19), and `demask-contact-labels` (20) are dependency-free and can slot in from here on — 19 is pure client work, fully parallel to the server-side chain, and must land before Wave D's `people-management-ui` (its own hard deadline; earlier is better so #7's grading strip and #14's dashboard are born on the `/brain` page rather than added to the monolith). **`demask-contact-labels` (20) should land before the archive-scale spend**: it strips WhatsApp's masked-number placeholders so episodes are born with clean, substitutable `+E.164` labels — a hard prerequisite for `identity-late-resolution` (4)'s deterministic substitution and therefore upstream of `historical-backfill` (14). Also in this wave: **close out the three near-done archive-layer changes** — `native-import-picker` (16: run gate 9.1), `import-media-cdn-recovery` (17: write parser test 5.1, run gates 6.1/6.2), `complete-media-archival` (18: run gates 11.1/11.3–11.5) — then `/opsx:archive` each.
- **Wave B — the keystone**: `episode-contract-v2` (3). Everything downstream consumes its contract; nothing token-expensive should run before it lands. The `build-the-brain` ops-spine remainder (run objects 3.5, scheduler 3.3, catch-up audit) pairs naturally with this wave.
- **Wave C — parallel after the contract**: `identity-late-resolution` (4), `two-level-person-model` (5), `brain-eval-harness` (7), `reply-quote-recovery` (21), `archive-signal-capture` (22). **`reply-quote-recovery` (21) and `archive-signal-capture` (22) are capture-before-spend gates for `historical-backfill` (14)** — like `demask-contact-labels` (20), they make episodes born complete. #21 captures WhatsApp's chat-local quoted-message snapshot (recoverable for 95.9% of the archive's 38.8k replies). #22 stops the importer dropping populated source tables the 2026-07-13 audit surfaced — 457 number-changes, 5,639 structured mentions, the 158-group membership timeline, 153 locations, 177 vCards, 3,121 link previews, edits/deletions, and privacy-scoped engagement aggregates — landing them for its consumers `two-level-person-model` (5), `retrieval-hardening` (8), and `knowledge-graph-foundation` (9), so #22 wants to land before #9's Wave D. Both bump `EXTRACTION_VERSION`; existing episodes regenerate.
- **Wave D — parallel**: `people-management-ui` (6), `knowledge-graph-foundation` (9). **`historical-backfill` (14) may START here** (gates 3/4/7 met) and runs as a months-long background drain or attended turbo sessions while later waves are built — coverage metadata keeps partial assimilation honest by design.
- **Wave E — adjacent pair**: `commitment-lifecycle` (10) then `semantic-rollups` (11) — closure executes inside rollup calls, so specify together, land back-to-back.
- **Wave F**: `brain-retrieval-pipeline` (12).
- **Wave G**: `mcp-agent-surface` (13).
- **Wave H — closeout**: `memory-teardown-and-docs` (15).

## `build-the-brain` Supersession Map

| Original task | Disposition |
|---|---|
| Phases 1–2 (1.1–2.8) | Delivered; untouched |
| 2.7 gate, 3.3 scheduler, 3.5 run objects, 3.7 tests, 3.8 gate | **Stay in `build-the-brain`** (operational spine) |
| 3.4 catch-up audit | Stays; its `--turbo` backfill half → `historical-backfill` |
| 3.2 full extraction | → `episode-contract-v2` (extended: event-time, confidence, versioning, validation v2, injection hardening, late-binding stamps) |
| 3.6 staleness | Edits/deletes/interpretation staleness stays; merge rekey → `brain-correctness-debts`; name repair → `identity-late-resolution`; person auto-merge → `two-level-person-model` |
| 4.1/4.2/4.4 rollups + guard + projection | → `semantic-rollups` (declared supersession, input quotas, extractive quarantine) |
| 4.3 graph + salience | → `knowledge-graph-foundation` (+ kind-aware dormancy) + `two-level-person-model` (membership replaces person hard-merges) |
| 4.5 retrieval | → `brain-retrieval-pipeline` (layered merge, coverage verdicts, pinned deep path, timeline + claims) |
| 4.6 memory removal | → `memory-teardown-and-docs` |
| 5.x MCP | → `mcp-agent-surface` (+ `brain_ask`, spend authority, weak-model gate) |
| 6.x docs/closeout | → `memory-teardown-and-docs` |
| *(new, no predecessor)* | `brain-eval-harness`, `evidence-pack-fidelity`, `identity-late-resolution`, `people-management-ui`, `retrieval-hardening`, `commitment-lifecycle`, `demask-contact-labels` |

## Clean Slate & Breaking-Change Sanction

- **Clean slate executed 2026-07-11**: all partial brain derived data was wiped before roadmap start — 30 episodes, their claims/citations, all watermarks, and 30 projected episode files removed via `POST /api/brain/reset`; `GET /api/brain/episodes` confirmed empty. The roadmap begins from zero assimilation. (The reset surfaced a coverage-count artifact — `assimilatedVisibleMessages: 1` with zero watermark rows, a timestamp-0 message counted by the `<=` predicate — additional evidence for `brain-correctness-debts`' watermark-predicate fixes.)
- **Standing sanction (user, 2026-07-11)**: at ANY point in this roadmap, breaking changes are allowed — schema drop-and-recreate instead of additive migration, contract changes without compatibility shims, and wiping some or all derived data (brain tables, FTS, graph, persons, eval runs) whenever a cleaner design results. The archive layer (`messages`, `chats`, `contacts`, media blobs) is the only data that must never be lost; everything above it is rebuildable by construction. Changes SHOULD prefer the clean redesign over the compatible-but-compromised one and note in their proposal when a wipe is part of the plan.

## Standing Principles (from the review)

1. **Contract before spend**: no archive-scale assimilation until `episode-contract-v2` + `brain-eval-harness` are green. Re-extraction is the only expensive do-over in the system.
2. **Store references, render names**: derived layers key on JIDs/node ids and resolve display names at read time; names baked into generated prose must be number-labelled (substitutable) and stamped for repair. No derived layer may treat a display name as immutable input.
3. **Late-binding inventory**: identity, media interpretation, quoted replies, reactions, forwards, chat names, topics — each needs an anchor, a version/coverage stamp, and a repair path. Any new feature baking an interpretation into stored text must say which row it adds to this table (kept in `build-the-brain/design.md`).
4. **Under-merge beats over-merge**: person identity is an editable membership, never a destructive merge; suggestions are produced by detectors and applied only by certainty-grade sources or the user.
5. **Deterministic first, model second**: repair, closure candidates, conflict candidates, input selection, and `brain_ask` are all pure-SQL scaffolding; model calls are reserved for synthesis the structure cannot do.
6. **Weak model reads, mid model writes, strong model consolidates**: the read surface must satisfy a Haiku-class client (`brain_ask` gate); episode writes stay mid-tier with structural validation; flagship tiers are reserved for rollup-class synthesis.
