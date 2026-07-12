# People Management UI

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Sonnet.**

## Why

The two-level person model makes connect/disconnect safe metadata edits, but the human doing the confirming needs a surface that makes each decision a two-second glance instead of an investigation. The user resolves identities over time; the UI's job is to turn that stream into a ranked queue where the evidence is in front of you, certainty-grade links never even appear (auto-connected), and one dismissal is remembered forever.

## What Changes

- **People view**: list persons with their member identities, provenance per membership (google / user / model-suggested), linked-at timestamps, connect/disconnect controls, and each person's chats/volume at a glance.
- **Confirmation queue**: pending suggestions ranked by *insight value* (message volume / salience of the involved identities), not just confidence — connecting two heavy identities unlocks more brain quality than two one-message strangers.
- **Evidence panel per suggestion**: shared display name, Google contact status, shared groups, overlapping chats, succession pattern (A goes silent where B appears) — whatever the detectors produced, rendered so confirmation takes seconds.
- **Rejection memory surfaced**: "not the same person" persists (from `two-level-person-model`) and the pair never re-surfaces; a reviewable rejected list allows undo.
- **One identity-hygiene queue**: the unresolved-name debt surface (from `identity-late-resolution`) and the connection queue merge into a single ranked to-do — "save these contacts, confirm these pairs" — ordered by what most improves the brain.
- **Audit trail**: every confirm/reject/disconnect is a timestamped, sourced membership edit, reviewable in the view.
- **Checkpoint**: open the People view — same-Google-contact pairs are already connected with provenance shown; a same-name false pair is dismissed once and stays dismissed; confirming a true pair updates person-level surfaces without touching episodes.

## Capabilities

### Modified Capabilities

- `person-identity-model`: gains the management surface requirements — ranked suggestion queue with evidence, rejection review/undo, audit visibility, and the merged identity-hygiene queue.

## Impact

- **Code**: new People panel in `src/client/App.tsx` (or a split component), `/api/people/*` routes (list, suggestions, confirm, reject, disconnect), SSE nudges on membership changes.
- **Schema**: none new — consumes `persons`/`person_members`/`person_suggestions` and the unresolved-participant stamps.
- **Tests**: queue ranking, rejection permanence, confirm/disconnect round-trip through the API, privacy canary on suggestion payloads (evidence shows names/counts, never message bodies beyond what the user already sees in-app).
- **Depends on**: `two-level-person-model` (tables + detectors), `identity-late-resolution` (debt surface it merges with).
