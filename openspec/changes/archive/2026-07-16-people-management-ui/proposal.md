# People Management UI

> Seeded 2026-07-11; expanded 2026-07-16 with premises re-verified against the shipped `two-level-person-model` (#5), whose three user-feedback rounds already delivered part of this seed's surface. **Recommended model: Sonnet.**

## Why

The two-level person model makes connect/disconnect safe metadata edits, and its closing feedback rounds already shipped a working queue: pair-grouped suggestion cards with fused confidence, per-merge value propositions, friendly evidence with kind filters and value-aware sorting, a side-by-side compare dialog with cross-chat activity, provenance-filterable connected views, and scan freshness. What remains is the difference between a working queue and a *complete management surface*: dismissals can't be undone, the unresolved-name debt (identities the brain refers to by bare number) lives in a different panel with no action attached, the compare dialog still can't show media or faces, membership history is invisible, and the page only updates when you act. This change finishes the surface so identity hygiene — "save these contacts, confirm these pairs" — is one ranked, evidence-rich, reversible to-do.

## What Changes

Already shipped by #5 (not re-specified here): People page + route + nav, `/api/persons/*` routes, pair-grouped ranked queue, evidence lines, compare dialog with DM threads + cross-chat group activity, connected-people filters/sorts/stats, dismissed list, scan freshness, pair-level accept/dismiss.

- **Dismissal review with undo**: the Dismissed tab gains per-pair undo — a user-initiated un-reject returns the pair's signal rows to pending (detector re-runs then re-rank or prune them naturally); rejection stays sacred against detectors, only the human can reverse it.
- **One identity-hygiene queue**: merge the unresolved-name debt surface (shipped read-only in the Brain panel via `getBrainResolutionDebt`) with the confirmation queue into a single ranked to-do — "name this contact" and "confirm this pair" items interleaved by the message volume they'd repair or unify.
- **Name-this-contact action**: the debt item's fix, in-app — set a display name on an identity from the People page; the write routes through the existing identity-repair entry point so episodes, search, and labels update deterministically, and a user-entered name ranks above every enrichment source.
- **Evidence explorer completion (user checkpoint feedback 2026-07-16)**: the compare dialog gains recent shared-media thumbnails per identity (stored media only, local), a shared-group membership timeline (joined/left windows from `group_membership_periods`), and — when live sync is connected — profile photos fetched on demand, cached locally with TTL and negative caching, never blocking the dialog.
- **Audit visibility**: the append-only `person_link_events` trail (connect/disconnect/union/dissolve/suggest/accept/reject with source + evidence) becomes reviewable in the People page.
- **Live refresh**: the People page subscribes to the existing archive-events SSE channel so background auto-connects, detector runs, and Google syncs update the queue without a manual reload.
- **Checkpoint**: dismiss a pair, undo it from the Dismissed tab, and watch it return ranked; name a bare-number identity from the hygiene queue and see its episodes/search repair with zero model calls; open a suggestion and decide it from media + faces + timeline without leaving the dialog; watch a background scan update the page while it's open.

## Capabilities

### Modified Capabilities

- `person-identity-model`: the Person Management Surface requirement grows into the complete surface — unified hygiene queue, dismissal undo, audit visibility, explorer media/photo/timeline evidence, and live refresh.
- `identity-and-naming-integrity`: Visible Contact Enrichment gains the user-set name source — entered in-app, strongest precedence (above the WhatsApp contact database and Google), routed through the same repair trigger as every other name source.

## Impact

- **Code**: People page extensions (hygiene tab, undo, audit view, explorer sections, SSE subscription) in `src/client/pages/people/`; server routes under the existing `/api/persons/*` namespace (undo, rename, audit, avatar) plus a debt-queue read that reuses `getBrainResolutionDebt`; live-maintainer/client support for bounded profile-picture fetch; avatar cache under `.wapp-brain/`.
- **Schema**: none new — consumes `persons`/`person_members`/`person_suggestions`/`person_link_events`, resolution-debt stamps, `group_membership_periods`, and `media_assets`; `contacts.display_name_source` gains the `user` value (TEXT column, no migration).
- **Tests**: undo round-trip (rejected → pending → detector re-rank; detectors still never resurrect rejections themselves), hygiene-queue ranking across both item types, rename-repair round-trip with precedence, avatar cache TTL + offline fallback, privacy canary on suggestion/audit payloads (names/counts, never message bodies beyond what the app already shows).
- **Depends on**: `two-level-person-model` (tables, detectors, queue, dialog — archived 2026-07-16), `identity-late-resolution` (debt surface + repair entry point — archived 2026-07-14), `client-route-architecture` (routed pages — archived 2026-07-13).
