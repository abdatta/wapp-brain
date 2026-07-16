# People Management UI

> Proposal-level seed (2026-07-11; premises re-verified against the codebase 2026-07-16). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Sonnet.**

## Why

The two-level person model makes connect/disconnect safe metadata edits, but the human doing the confirming needs a surface that makes each decision a two-second glance instead of an investigation. The user resolves identities over time; the UI's job is to turn that stream into a ranked queue where the evidence is in front of you, certainty-grade links never even appear (auto-connected), and one dismissal is remembered forever.

## What Changes

- **People view**: list persons with their member identities, provenance per membership (google / number_change / user — accepted suggestions land as `user` with the suggestion as evidence, per the shipped two-level-person-model), linked-at timestamps, connect/disconnect controls, and each person's chats/volume at a glance.
- **Confirmation queue**: pending suggestions ranked by *insight value* (message volume / salience of the involved identities), not just confidence — connecting two heavy identities unlocks more brain quality than two one-message strangers.
- **Evidence panel per suggestion**: shared display name, Google contact status, shared groups, overlapping chats, succession pattern (A goes silent where B appears) — whatever the detectors produced, rendered so confirmation takes seconds.
- **Rejection memory surfaced**: "not the same person" persists (from `two-level-person-model`) and the pair never re-surfaces; a reviewable rejected list allows undo.
- **Evidence explorer (user checkpoint feedback 2026-07-16)**: a suggestion opens an in-place explorer — side-by-side chat previews for both identities, shared-group timelines, media glimpses, and (when live sync is linked) fetched profile photos — so "same person?" is decidable without leaving the queue. The shipped minimal panel added phones, open-chat links, and friendly evidence lines; this change owns the full explorer.
- **One identity-hygiene queue**: the unresolved-name debt surface (shipped by `identity-late-resolution` as a read-only metric in the Brain panel, backed by `getBrainResolutionDebt` / `GET /api/brain/status`) and the connection queue merge into a single ranked to-do — "save these contacts, confirm these pairs" — ordered by what most improves the brain.
- **Audit trail**: every confirm/reject/disconnect is a timestamped, sourced membership edit, reviewable in the view.
- **Checkpoint**: open the People view — same-Google-contact pairs are already connected with provenance shown; a same-name false pair is dismissed once and stays dismissed; confirming a true pair updates person-level surfaces without touching episodes.

## Capabilities

### Modified Capabilities

- `person-identity-model`: gains the management surface requirements — ranked suggestion queue with evidence, rejection review/undo, audit visibility, and the merged identity-hygiene queue.

## Impact

- **Code**: a new lazy People page under `src/client/pages/` with a route in `routes.tsx` (post `client-route-architecture`, `App.tsx` is a providers+router shell), `/api/people/*` routes (list, suggestions, confirm, reject, disconnect), membership-change nudges over the existing `/api/archive/events` SSE channel (`useArchiveEvents`).
- **Schema**: none new — consumes `persons`/`person_members`/`person_suggestions` and the unresolved-participant stamps.
- **Tests**: queue ranking, rejection permanence, confirm/disconnect round-trip through the API, privacy canary on suggestion payloads (evidence shows names/counts, never message bodies beyond what the user already sees in-app).
- **Depends on**: `two-level-person-model` (tables + detectors), `identity-late-resolution` (debt surface it merges with).
