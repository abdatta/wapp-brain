# Two-Level Person Model

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Fable.**

## Why

Same person, multiple numbers; multiple people, same name — and both must be connectable *and* disconnectable without data surgery. The original D6 plan (person nodes that hard-merge with redirect stubs) makes un-merging nearly impossible, and over-merge is the worse failure: it poisons generated rollup prose with misattributions, while under-merge only delays aggregation that a later connect retroactively heals. So identity splits from person: **identity nodes** (one per canonical JID, never merged, never deleted — where claims, mentions, and citations anchor) and **persons** (a grouping over identities via an editable membership table). Connect = insert a row; disconnect = delete a row. Nothing in the system ever groups by name; name collisions only ever produce *suggestions*.

## What Changes

- **Identity level**: one node per canonical JID, immutable anchors; LID↔PN collapses stay at the archive layer (`mergeIdentity`) since those are the same WhatsApp identity, not a human-level judgment.
- **Person level**: `person_members(person_id, identity_id, source, linked_at)` with `source ∈ {google, user, model_suggested}`; person-level surfaces (pages, salience, groupings) aggregate over membership at read/rollup time, so connect/disconnect touches zero episodes and only re-derives cheap aggregations.
- **Deterministic auto-connect**: two certainty-grade sources connect without confirmation (one-click disconnect stays available) — numbers on the same Google contact, and WhatsApp "X changed their phone number" system messages (457 of them, all JID-resolvable, now captured by `archive-signal-capture` (22)). Shared-vCard JIDs are a weaker suggestion source from the same change.
- **Suggestion machinery (produce, never apply)**: same display name, shared groups, co-citation, and the succession pattern (number A goes silent in the chats where number B appears — sharpened by the group-participant join/leave timeline from `archive-signal-capture` (22)) generate ranked suggestions with evidence attached; the D6 LLM `merge_adjudicate` budget demotes to a suggestion producer. Rejections are persisted so a dismissed pair is never re-suggested.
- **Pack-local person resolution rule**: extraction-time entity resolution stays strictly pack-local (participants + mentioned JIDs) — never a global name lookup; unresolvable names commit as unresolved text entities pending suggestion.
- **Render-time disambiguation**: anywhere a person's name collides with another person's, the display appends a disambiguator (number or shared-chat context) — two Rohits look different everywhere, automatically.
- **Optional unconfirmed hints**: high-confidence suggestions may surface as display-level annotations ("possibly the same as +91 99… — unconfirmed") without ever influencing claims or rollup synthesis.
- **Checkpoint**: two same-name contacts remain separate persons with separate views; linking two numbers under one Google contact auto-connects them with visible provenance; disconnecting reverses it and person-level surfaces re-derive — with zero episode changes in all cases.

## Capabilities

### New Capabilities

- `person-identity-model`: the two-level identity/person model — immutable identity anchors, editable person membership with provenance, deterministic auto-connect sources, suggestion producers with rejection memory, pack-local resolution rule, render-time disambiguation.

### Modified Capabilities

- `brain-assimilation`: Knowledge Graph Maintenance amended — person aggregation happens via membership, replacing hard person-node merges; redirect stubs remain only for externally-held person ids.

## Impact

- **Schema**: `brain_identities` (or identity-kind nodes), `persons`, `person_members`, `person_suggestions` (with status + evidence payload + rejection memory).
- **Code**: repository methods (connect/disconnect/suggest/reject with audit trail), Google-enrichment hook for same-contact detection, number-change system-message miner, suggestion detectors as scheduled deterministic jobs.
- **Docs**: design.md D6 person-merge section rewritten to the two-level model.
- **Tests**: same-name separation, auto-connect provenance, disconnect re-derivation, rejection memory, succession-pattern detector, pack-local-only resolution.
- **Depends on**: `episode-contract-v2` (identity-anchored `brain_claim_entities` is what makes person edits metadata-only forever).
