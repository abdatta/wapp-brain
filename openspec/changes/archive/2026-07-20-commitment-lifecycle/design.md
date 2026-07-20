# Commitment Lifecycle — Design

## Context

`knowledge-graph-foundation` (#9) shipped the substrate this change animates: one node per commitment/question claim, born `open` in `payload_json` (`{status, holderJid, dueMs}` — due already derived `valid_until ?? event_at`), kind-aware dormancy exemption with the due-proximity/overdue salience boost already live in `computeGraphSalience`, `replies_to` edges landing on lifecycle nodes from both directions of assimilation order, and `resolves` reserved in the edge vocabulary with **no producer**. Nothing can close anything: the open set grows monotonically.

Three facts shape the design:

1. **Closure evidence is invisible to episode extraction.** The WhatsApp-native acknowledgment — a 👍 reaction or a short reply landing *days after* the promise — annotates a message that was already assimilated. Evidence packs render reactions only on in-pack messages, and staleness propagation does not cover late reactions, so no episode call will ever see them. The only consumer that can see this evidence is a **deterministic candidate query** over `live_message_updates` (reactions), quoted-snapshot replies, and later claims. This is why `evidence-pack-fidelity`'s reactor identity resolution is a hard prerequisite: the sweep reuses it.
2. **Transitions are model/user-produced state, but graph tables are wipeable.** The graph is derived-of-derived, rebuilt from episodes with zero model calls (`rebuildBrainGraph`). If status lived only in node payloads, every rebuild would silently reopen everything. Lifecycle truth must therefore live in a **durable append-only table keyed by claim id** (stable across graph wipes), with node payloads a mechanical projection — exactly the episode/claims pattern one tier down.
3. **#10 lands before #11 (`semantic-rollups`) but closure "executes through rollup calls".** The Wave E pairing means this change defines the **single resolutions contract** — the JSON schema fragment, its validation, and the transactional writer — and ships a standalone executor (the closure sweep) so the checkpoint passes now. #11 embeds the same fragment and calls the same writer inside its page-rewrite transactions; it must not re-decide any of this.

Integration points confirmed in code: `commitBrainEpisode` supersede path (graph scope rule G4), `rebuildBrainGraph`/`resetBrainDerivedData`, `computeGraphSalience` (reads `payload.status`), run machinery in `runJob.ts` (run kinds, budgets, ledger, provider gates), `generateStructured` with per-call `model`/`effort`, reactions in `live_message_updates` with `occurred_at_ms`, quoted replies via `message_quoted_snapshots`/`quoted_source_message_id`, and the flat client routes (`/brain`, `/brain/eval`, `/graph`).

Constraints: deterministic-first (model calls only for judgment SQL cannot make); store-references-render-names; manual-first spend; async progress + loud failures; breaking-change sanction active (additive DDL preferred here anyway — nothing needs a wipe).

## Goals / Non-Goals

**Goals:**

- Cited, append-only lifecycle transitions (`open → fulfilled | cancelled`, `still_open` review, `reopened`) for commitment and question nodes, applied in one transaction with postdating-citation validation.
- The resolutions contract defined **once**: schema fragment `{node, status, cites, note?}`, closed-world cite validation, and the writer `applyBrainLifecycleTransitions` — consumed by this change's sweep and by #11's rollups.
- Deterministic closure-candidate scaffolding (pure SQL): postdating reactions on cited messages, replies quoting cited messages (including cross-chat Reply Privately), later entity-overlapping claims, due-date passage — bounded, ranked, and powering both the sweep's input and a sweep-due skip rule so unchanged nodes never burn calls.
- A manual-first **closure sweep** run kind: model judges offered candidates per chat batch, strict collect-all validation with one retry, **no fallback** (there is no honest extractive closure — failure leaves nodes open with visible issues).
- User transitions from the UI/CLI as a certainty-grade source (close/cancel/reopen, optional note, no citation requirement).
- L0 open-items semantics pinned: status-driven, salience- and dormancy-independent, `overdue` and `stale` distinct from `open`, as-of/last-evidence stamps; served at `/api/brain/lifecycle`, CLI `brain:lifecycle`, and a `/brain/commitments` page.
- Rebuild determinism preserved: reset wipes lifecycle tables; rebuild re-projects node payloads and `resolves` edges from the durable events with zero model calls; regeneration re-keys transitions onto replacement claims by citation intersection or orphans them honestly.

**Non-Goals:**

- No rollup engine, doc revisions, or pages (#11) — the sweep is a lifecycle-only call, never a page rewrite.
- No auto-scheduled sweep: dueness/candidate counts surface; the user triggers spend (revisit cadence in #11 alongside rollup scheduling).
- No episode-extraction contract change and **no `EXTRACTION_VERSION` bump** — commitments/questions are already extracted; this change only consumes them.
- No retrieval fusion of resolved Q→A pairs (#12 reads the linkage this change stores).
- No new detection of commitments the extractor missed, and no embeddings/heuristics beyond the three deterministic candidate producers.

## Decisions

### L1. Durable truth: append-only `brain_lifecycle_events` keyed by claim id; node payload is a projection

- `brain_lifecycle_events(id INTEGER PK, claim_id TEXT NOT NULL, to_status TEXT CHECK ('fulfilled'|'cancelled'|'still_open'|'reopened'), source TEXT CHECK ('model'|'user'), evidence_at_ms INTEGER NULL, note TEXT NULL, run_id TEXT NULL, model TEXT NULL, orphaned_at_ms INTEGER NULL, created_at_ms INTEGER NOT NULL)` with index `(claim_id, id)`.
- `brain_lifecycle_event_cites(event_id INTEGER, source_message_key TEXT NOT NULL, resolving_claim_id TEXT NULL, timestamp_ms INTEGER NULL, UNIQUE(event_id, source_message_key))`.
- **Fold semantics** (pure function, shared by both repositories): status = last `fulfilled`/`cancelled` not followed by `reopened`, else `open`; `resolvedAtMs` = that event's `evidence_at_ms ?? created_at_ms`; `lastReviewedAtMs` = max event `created_at_ms` (any status — a terminal, review, or reopen all count as review).
- Projection: node `payload_json` gains `resolvedAtMs`/`lastReviewedAtMs` beside the folded `status`; `computeGraphSalience` needs **zero changes** (its `status==='open'` exemption and due boost now simply see the projection; fulfilled/cancelled nodes decay and may go dormant — intended).
- *Why claim id, not node id*: node ids die on every rebuild; claim ids survive graph wipes and are already the lifecycle node natural key (`commitment:<claim_id>`). *Why append-only*: "closure must be a first-class, cited state transition" — the event log IS the citation trail, gives reopen/audit for free, and makes rebuild a replay instead of a merge. *Alternative rejected*: single current-state row per claim (loses history, makes user-vs-model disagreement invisible); status column on `brain_nodes` (wiped by rebuild, wrong table for durable truth).

### L2. Closed-world postdating validation

A model-sourced terminal transition (`fulfilled`/`cancelled`) MUST carry ≥1 cite; every cite MUST be a source message key **the sweep offered as candidate evidence for that node** (closed world — hallucinated or out-of-scope keys are validation errors), and every cite's timestamp MUST postdate the **anchor** = max citation timestamp of the lifecycle claim (the promise's own last evidence). The candidate query enforces postdating at selection time; the writer re-checks independently so #11's rollup calls get the same guarantee without trusting their own input assembly. `still_open`/`reopened` and user-sourced events need no cites (user authority is certainty-grade; a note is optional). *Why max-citation anchor over node `first_seen`*: first_seen is graph metadata that shifts under rebuild widening; the claim's own citations are the commitment's evidence and are immutable.

### L3. The closure sweep: run kind `lifecycle`, direct loop, no fallback

- New `BrainRunKind` `"lifecycle"`; a direct chunked loop like the manual run (no task-queue durability needed — re-running is idempotent because resolved/reviewed nodes fall out of the sweep-due set). Scope: whole archive or one chat (`chatSourceId`), model + effort user-selectable; ledger purpose `lifecycle`; daily call caps enforced; per-run `maxModelCalls`/`maxTokens` honored; provider gates identical to episode runs (enabled, not degraded, session present; owner-name refusal applies).
- **Sweep-due predicate** (pure SQL): an open lifecycle node is due when it has ≥1 candidate whose timestamp postdates `max(lastReviewedAtMs, anchor)`, OR its due date passed since the last review. Nodes with no new evidence are skipped entirely — no spend on unchanged state.
- **Call shape**: batch up to 8 due nodes of one chat per call. Per node: the claim text, kind, holder label, opened/due dates rendered with absolute dates, then its candidate evidence as fenced, injection-hardened lines (same BEGIN/END discipline as episodes) with per-line keys: reactions (`[k3] 👍 by Asha — 3 days after the promise`), replies (full text, quoted-antecedent named), later claims (dated, with their citation keys), due passage as non-citable context. Identity labels resolve through the same contact/owner labelling used everywhere; raw message text sent is bounded per line and per node (top-K candidates, recency-ranked).
- **Response contract**: `{resolutions:[{node, status: fulfilled|cancelled|still_open, cites:[keys], note?}]}`. Normalization salvages the routine deviations (lone object, comma-joined cites) mechanically; validation collects ALL errors (unknown node, non-offered cite, backdated cite, unknown status) into one retry; second failure records error-severity validation issues (episode-issue table, kind `lifecycle`) and leaves the nodes open — **no fallback by design**. Prompt stance: conservative — close only on explicit evidence, prefer `still_open` when unsure, `cancelled` requires evidence of withdrawal/mootness, never infer fulfillment from silence.
- `still_open` responses (and offered nodes absent from the response) record a `still_open` review event so `stale` can mean "reviewed and still open" honestly rather than "never looked".
- *Why a dedicated sweep instead of episode-contract extension*: closure evidence lives outside any pack window (fact 1); adding open-node context to episode prompts would tax the mid-tier extractor and violate "weak model reads, mid model writes, strong model consolidates" — closure is consolidation-class judgment, and the sweep lets the user point a stronger model/effort at exactly that. *Why no fallback*: an extractive "closure" would fabricate a state transition; leaving the node open is the honest failure mode (coverage is not at stake, unlike episodes).

### L4. Deterministic candidate producers (pure SQL, bounded)

Per open lifecycle node, from its claim's citation message keys (the anchor set):

1. **Reactions**: `live_message_updates` rows (`update_type='reaction'`, applied, non-empty emoji) targeting anchor keys with `occurred_at_ms` > anchor — reactor JID resolved to identity labels (the `evidence-pack-fidelity` machinery).
2. **Replies**: archived messages whose captured quoted snapshot or legacy pointer resolves to an anchor key, postdating the anchor — including cross-chat Reply Privately (the snapshot is reply-owned; no group query needed). This is the stored form of the graph's `replies_to` evidence, queried directly so candidates exist even before the reply's own window assimilates.
3. **Subsequent claims**: current model-generated claims in the same chat whose citations postdate the anchor and which share ≥1 entity with the lifecycle claim (JID match; normalized-name match when both sides lack a JID), most-recent-first top-K. Their citation keys are the citable currency; at apply time, a cite that appears in an offered claim's citations records that claim as `resolving_claim_id` — the "resolves" link between claims the proposal names.
4. **Due passage**: `dueMs < now` renders as context (non-citable) so the model can judge `cancelled`/`still_open` on overdue items.

Caps: K candidates per node (default 12, recency-ranked within kind priority reaction > reply > claim), bounded line lengths. The same query powers the per-node `candidateCount` badge and the aggregate sweep-due count on the brain surfaces. *Why these three*: they are exactly the deterministic signals the archive already stores that structurally point back at the promise; anything fuzzier (semantic similarity) is #12's territory and would break "deterministic first".

### L5. One writer: `applyBrainLifecycleTransitions`

Single transactional entry point (both repositories, doc-comment parity) taking validated transitions + `{source, runId?, model?}`: inserts events + cites, re-projects the affected nodes' payloads (fold from L1), upserts `resolves` edges — src = resolver person node (canonical JID of each cited evidence actor: reactor, reply sender, or citing claim's message sender), dst = lifecycle node, evidence = the cited message keys (`evidence_key` = `msg:<key>` so re-application converges) — and refreshes salience for exactly the touched nodes (scoped recompute; the global pass stays run-end). User transitions without cites write no `resolves` edge (no conversational evidence to project — the event row itself is the record). Emits a brain-status/SSE refresh so surfaces update without reload. *Why edges as projection, not truth*: rebuild wipes edges; events + cites regenerate them mechanically (L7), keeping "no edge without evidence" true by construction.

### L6. L0 read surface: status-driven, salience-independent

- `listBrainLifecycleItems({status?, kind?, chatSourceId?, holder?, limit, offset})` → items carrying: node id/slug/kind, claim id + text, chat source id + read-time label, holder JID + read-time label (person-aggregated), `openedAtMs` (anchor), `dueMs`, `lastEvidenceAtMs` (node last_seen), `lastReviewedAtMs`, folded status, flags `overdue` (open ∧ due < asOf) and `stale` (open ∧ max(lastEvidence, lastReviewed) older than `WAPP_BRAIN_LIFECYCLE_STALE_DAYS`, default 30), `candidateCount`, and for closed items the resolving event (status, source, date, note, cites with sender labels). Response stamped `asOfMs`. Default filter `open`; ordering pinned: overdue first (most-overdue first), then due ascending (soonest), then undated by last-evidence descending; deterministic tiebreak by node id.
- Surfaces: `GET /api/brain/lifecycle` (+ transition POST routes), CLI `brain:lifecycle` (list/close/reopen/sweep), and a lazily-loaded `/brain/commitments` page: filterable list, overdue/stale chips, citation click-through to the thread view (existing message-key navigation), per-item close/cancel/reopen with note, and a "Run closure sweep" control wired through the run console machinery (model/effort pickers, live progress, loud failures). The Brain page gets a compact strip (open/overdue/sweep-due counts → link); `BrainGraphStats.openLifecycleNodes` stays and gains closed/overdue companions. Meaning stays server-side: flags, ordering, and display strings ship in the DTO (questions render `answered` for `fulfilled` — one status vocabulary, kind-aware display).
- **Pinned for #12** (per the placement note): L0 "open commitments" = folded-status-open nodes regardless of salience or dormancy, each carrying as-of/last-evidence stamps — `brain-retrieval-pipeline` references these semantics, never redefines them.

### L7. Rebuild, reset, regeneration, merge

- `rebuildBrainGraph` gains a **lifecycle projection step** after episode replay + signal sync: fold events for every claim that exists as a current lifecycle claim, write payload projections, re-derive `resolves` edges from event cites (resolver = cited message's sender at replay time). Zero model calls; rebuild-equals-incremental extends to lifecycle state.
- `resetBrainDerivedData` wipes both lifecycle tables (they are derived state whose re-derivation costs model spend — same class as episodes; a reset already accepts that).
- **Supersede re-key** (regeneration): in the same transaction that removes a superseded episode's lifecycle nodes and commits the replacement, events keyed to a dead lifecycle claim re-key onto a replacement claim when exactly one same-kind lifecycle claim in the replacement episode(s) shares ≥1 citation key with the old claim; otherwise events get `orphaned_at_ms` (kept for audit, excluded from folds, counted on the surface as "orphaned resolutions" debt). The new node is honestly open again; the sweep can re-close it from the same still-stored evidence.
- `mergeIdentity`: no lifecycle-specific work — events key on claim ids (stable through merges), `resolves` edges ride the existing graph node-merge reconciliation.

### L8. #11 handoff (specify together, land back-to-back)

Pinned here so `semantic-rollups` implements rather than re-decides: (a) the rollup JSON schema embeds this change's `resolutions` array fragment verbatim; (b) rollup input selection's first quota tier ("open commitments/questions") reads the L6 query; (c) rollup calls apply resolutions via `applyBrainLifecycleTransitions` inside the page-rewrite transaction, with the same closed-world rule — cites must be message keys the rollup input actually contained; (d) the sweep remains after #11 as the scoped, page-free closure path (a rollup closes as a side effect of consolidation; the sweep exists to close without paying for consolidation).

## Risks / Trade-offs

- **[False closure — model marks fulfilled on ambiguous evidence]** → conservative prompt stance, closed-world + postdating validation, `cancelled` needs explicit evidence, full event history visible with citations, one-click user reopen (its own audited event).
- **[Candidate query misses closure phrased with zero entity overlap and no structural link]** → accepted v1 gap (deterministic-first); the item stays honestly open, user close covers it, and #12's retrieval layer is the designed home for fuzzier matching.
- **[Sweep spend growth at archive scale]** → sweep-due skip rule (no new evidence → no call), per-chat batching (≤8 nodes/call), per-run call/token budgets, daily caps, manual trigger only.
- **[Projection drift between events and node payloads]** → one writer (L5), rebuild re-projects from events (L7), and a determinism test asserts fold(events) == payload after arbitrary interleavings; memory repository mirrors for parity.
- **[Orphaned resolutions accumulate through regeneration]** → deterministic citation-intersection re-key catches the common case (same window, same promise message); the orphan count is a visible debt surface, not silent loss.
- **[`still_open` review floods events on repeated sweeps]** → the sweep-due rule prevents re-offering unchanged nodes, so reviews only append when new evidence arrived — bounded by evidence, not by sweep frequency.

## Migration Plan

1. Additive DDL only (two tables + indexes); no existing-table changes, no data wipe, no `EXTRACTION_VERSION` bump. Existing open lifecycle nodes are immediately listable and sweepable.
2. Ship code; the L0 surface works instantly over current graph state; first sweep is user-triggered.
3. Rollback: drop the two tables and remove the `lifecycle` run kind; a graph rebuild clears projected payload fields and `resolves` edges.

## Open Questions

- Stale threshold default (30 days, env `WAPP_BRAIN_LIFECYCLE_STALE_DAYS`) — calibrate once real archive data shows the open-set age distribution.
- Sweep cadence automation (fold into #11's rollup scheduling vs. its own dueness alert) — deliberately deferred; manual-first until spend patterns are observed.
- Whether `question` nodes eventually want a distinct `answered` status value rather than display mapping — revisit if #12's Q→A retrieval finds the shared vocabulary limiting.
