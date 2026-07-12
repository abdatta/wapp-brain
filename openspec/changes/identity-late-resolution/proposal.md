# Identity Late Resolution

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

Names resolve over time — Google contact sync, manual saves after a new number messages first — and resolution will keep improving for the life of the archive. The governing principle is *store references, render names*: every derived layer must key on JID and resolve display names at read time, so late resolution is free everywhere except the one place it can't be — LLM-generated prose, where names get baked into text. With `evidence-pack-fidelity`'s number-labelling in place, that baked prose becomes deterministically repairable: a phone number is a distinctive token you can find and substitute. This change builds the repair machinery so that saving a contact tomorrow retroactively improves every episode written today, at zero LLM cost.

## What Changes

- **Unified repair entry point**: one internal "identity improved for JID X" hook that both resolution variants route through — (a) same JID gains a display name (`upsertContacts` name transition), and (b) JID merges into an existing identity (`mergeIdentity`, whose brain rekey lands in `brain-correctness-debts`). Future resolution sources (msgstore `jid_map`, `lid_display_name`) reuse the same entry point.
- **Deterministic prose repair**: a substitution pass over the stamped episodes' claim text, summaries, and participants — replace the E.164 number with the resolved name (optionally `Rohit (then +91 98…)` for provenance); citations keep the raw truth checkable regardless of substitution coverage.
- **FTS repair**: the same hook enqueues the chunked per-JID `resolved_text` recompute (the rename-trigger gap — today only merges trigger it), so searching the new name immediately finds old messages.
- **Projection + participants refresh**: affected episodes re-project their Markdown; participant arrays recompute. Chat display names are confirmed render-time everywhere (never load-bearing from stored copies).
- **Optional model regeneration**: repaired episodes may be enqueued as low-priority `reextract` tasks (quality upgrade — the model can connect the named person to context) draining lazily under budget; the deterministic pass alone keeps the brain honest.
- **Resolution debt surface**: Brain panel line — "N episodes involve unresolved participants (M distinct numbers)", ranked by message volume, so contact-saving becomes a prioritized to-do list that shows exactly which saves buy the most brain quality.
- **Checkpoint**: assimilate a chat with an unresolved number, then save the contact — search by the new name finds old messages, the episode's claims now read with the name, the debt counter decrements, all without a single model call.

## Capabilities

### Modified Capabilities

- `identity-and-naming-integrity`: display-name resolution becomes a first-class repair trigger with a unified entry point across resolution sources.
- `brain-assimilation`: Staleness Propagation gains "name resolution" as a source with a deterministic-repair-first policy (substitution + recompute before any model regeneration); derived layers must never treat a display name as immutable input.

## Impact

- **Code**: `src/server/db/sqliteRepository.ts` (`upsertContacts` transition hook, substitution pass, episode stamp queries) + mirror, `src/server/brain/episodes.ts` (re-projection), Brain panel debt line, SSE nudge on repair completion.
- **Schema**: none beyond `episode-contract-v2`'s `unresolved_participants` stamp (this change is its consumer).
- **Tests**: rename-triggers-repair end-to-end (prose substituted, FTS recomputed, stamp cleared), merge-variant routing, provenance rendering, debt surface counts.
- **Depends on**: `episode-contract-v2` (stamps in commit shape), `evidence-pack-fidelity` (number labels make substitution reliable), `brain-correctness-debts` (merge rekey).
