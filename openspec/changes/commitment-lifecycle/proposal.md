# Commitment Lifecycle

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Fable.**

## Why

The review's sharpest lifecycle finding: commitments and questions can open but nothing can ever close them. The original design names a `status` field but defines no writer or transition for it, has no `resolves` edge kind, and no closure step in any rollup task — so the flagship "open commitments" surface at L0 accumulates monotonically into noise, while uniform salience decay hides a quiet chat's unresolved commitment exactly as its due date approaches. "X sent the report" would commit as an unlinked fact. Closure must be a first-class, cited state transition — and its most common evidence in real WhatsApp is a reaction ("👍", "done ✅"), which is why `evidence-pack-fidelity`'s reaction annotations are a hard prerequisite.

## What Changes

- **`resolves` edges**: a later claim resolves a commitment/question node, with the citation postdating the commitment — the structural link between "I'll send it" and "sent ✅".
- **Status transitions with writers**: `open → fulfilled | cancelled | still_open` applied via the weekly rollup contract — the rollup input includes the entity's open commitment/question nodes and the JSON schema requires a validated `resolutions` array (`{node_id, status, cites}`), applied in the same transaction as the page rewrite.
- **Kind-aware L0 semantics**: "open commitments" at L0 is defined as status-open nodes *regardless of salience*, each carrying an as-of/last-evidence stamp; past-due open items flagged `overdue`; items with no new evidence for N days labelled `stale` distinctly from `open`.
- **Due-date capture**: commitment nodes carry due dates from claim `event_at` where stated, powering proximity boosts and overdue detection.
- **Question→answer linkage**: the same machinery covers question nodes — a citing later claim resolves the question, linked for retrieval.
- **Checkpoint**: assimilate a conversation where a promise is made, then acknowledged days later (including by reaction) — the commitment node opens, the rollup closes it with a citation; an unresolved commitment in a quiet chat survives dormancy and shows as overdue past its due date.

## Capabilities

### New Capabilities

- `commitment-tracking`: cited lifecycle for commitments and questions — open/fulfilled/cancelled/still-open transitions with postdating-citation validation, overdue/stale distinction, dormancy exemption, L0 surface semantics.

### Modified Capabilities

- `brain-assimilation`: Consolidation Lifecycle amended — rollups execute closure as part of their contract; scenarios added (commitment resolved by later evidence; unresolved commitment survives dormancy).
- `brain-retrieval`: L0 overview contract pins open-commitment semantics (status-driven, salience-independent, as-of stamped).

## Impact

- **Schema**: status/due/last-evidence fields in commitment/question node payloads (or dedicated columns), `resolves` edge kind.
- **Code**: rollup prompt + validation extension (`resolutions` array), overdue/stale computation, L0 assembly.
- **Tests**: open→fulfilled via reaction evidence, postdating-citation validation rejects backdated resolutions, dormancy exemption, overdue flagging, still-open re-assertion.
- **Depends on**: `knowledge-graph-foundation` (nodes/edges exist), `evidence-pack-fidelity` (reaction closure evidence reaches packs), `episode-contract-v2` (`event_at` for due dates). Executes through `semantic-rollups`' rollup calls — these two changes should be scheduled adjacently.
