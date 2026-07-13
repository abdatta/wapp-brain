# Episode Contract V2

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Fable.**

## Why

Without embeddings, the episode text *is* the semantic index — the extraction prompt is this system's embedding function, and it is currently the least-governed component in the stack. The shipped contract asks only for `{summary, claims}` (no entities, no topics, no dates, no confidence), validates existence but not sanity, caps every pack at 2–8 claims regardless of density, hands weak models unactionable retry feedback on routine JSON deviations, and interpolates untrusted message text with zero injection hardening. Since we are pre-production, the right move is to design the **final** contract in one shot, wipe existing episodes, and regenerate — extraction over the archive is the only genuinely expensive do-over in the architecture, so the contract must be final *before* the backfill spend.

## What Changes

- **BREAKING**: existing `brain_episodes/claims/citations` rows are wiped (brain reset — *already executed 2026-07-11; the brain starts this change at zero assimilation*) and the schema is rebuilt to the final shape — no additive-migration machinery.
- **Full extraction JSON**: `{summary, claims: [{kind, text, cites, entities: [{kind, name, jid?}], event_at?, confidence}], topics}` with the 50-nearest-topic vocabulary offer. Entities land in a `brain_claim_entities` junction keyed on identity JID at commit (even before the graph consumer exists — the point is never re-extracting). Topics live only in structured fields, never load-bearing in prose.
- **Temporal + epistemic fields**: nullable `event_at_ms` (and optionally `valid_until_ms`) on claims populated from the model's date field; `confidence` (`stated|hedged|reported`); prompt rules — resolve relative time to absolute dates using shown timestamps (never "tomorrow"/"kal"), preserve hedges, names never pronouns.
- **Versioning**: `extraction_version` stamped from a named constant, bumped on any prompt/contract change (including future quote-stitching or media-interpretation upgrades).
- **Validation v2**: normalize before validating (numeric cites, lone claim object, string coercion); collect **all** errors into one retry message; unknown claim kinds retry like unknown citations instead of silently coercing to `fact`; density-proportional claim cap (`max(4, ceil(messages/25))`, ~16 hard cap, scaled `maxOutputTokens`); a $0 lexical-anchoring lint (each claim must share a distinctive token with its cited messages) writing `unanchored` flags to a new `brain_validation_issues` table — flag, never block.
- **Injection hardening**: untrusted-data sentence in the system prompt plus a BEGIN/END MESSAGES fence; the interpolated previous-episode summary fenced too and filtered to `generator='model'`.
- **Commit stamps for late binding**: unresolved-participant JIDs and uninterpreted-media counts recorded per episode at commit — the debt surfaces that later repair (identity-late-resolution, future media transcription) queries.
- **`brain regenerate`**: command/route selecting episodes by `generator='extractive'` or stale `extraction_version`, re-deriving packs from stored windows, committing replacements, marking old rows `superseded` (giving that status its first writer).
- **Checkpoint**: wipe the brain, assimilate 2–3 real chats — claims carry entities, absolute dates, hedges; a deliberately malformed stub-model response is salvaged by normalization or falls back with an actionable multi-error retry recorded in `brain_validation_issues`.

## Gate 2.7 digest feedback (2026-07-12, first real model digest — Tanish UCLA chat, sonnet)

- **Referent misattribution, the headline defect**: after a 20-day silence gap, "was this done?" / "it was finally settled yesterday" was attributed to the *visa* (the pack's last major topic) when the surrounding messages show it was the *tuition payment* — the very next message asks how to generate a Flywire. The date math ("yesterday" → 2025-07-15) was correct; the anchor was wrong, and the claim carried no hedge. The v2 prompt rules must cover ambiguous-referent resolution across silence gaps (prefer the reply's local context over pack-level topic salience; hedge with `reported`/`hedged` confidence when the referent is inferred, not stated).
- **Summary length**: the ≤80-word cap read as "pretty short" on a 63-message pack; make the cap density-aware alongside the density-proportional claim cap.
- **Naming style**: owner rendered as full "Abhishek Datta" (per the never-"Me" rule) while others got short chat names ("Tanish") — jarring. Pick one consistent style for all participants (short display names for everyone, owner included, with the never-"Me"/never-pronoun rules kept). Note the participant labels this style operates on are already clean by the time #3 runs: `demask-contact-labels` (20, Wave A) strips WhatsApp's masked `+91∙∙∙∙∙∙∙∙86` placeholders upstream, so an unsaved participant surfaces as a full `+E.164` number or an honest unresolved state — the style rule need not special-case masks.
- Granularity of claims and citation quality were judged good; no changes requested there.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: Cited Episode Extraction requirement rewritten to the v2 contract (entities/topics/event-time/confidence, versioning, validation v2, anchoring lint, injection fencing, late-binding stamps, regeneration path). Rollup-facing rule added: extractive-generator claims never enter semantic consolidation.

## Impact

- **Schema (rebuilt, not migrated)**: `brain_claims` gains `event_at_ms`, `confidence`; new `brain_claim_entities(claim_id, node_or_jid, kind, role)`, `brain_topics`/claim-topic links, `brain_validation_issues`; `brain_episodes` gains `extraction_version`, `unresolved_participants`, `uninterpreted_media_count`; time-friendly index on `(status, end_at_ms)`.
- **Code**: `src/server/brain/episodes.ts` (prompt, validation, commit shape), `src/server/db/sqliteRepository.ts` + mirror (DDL, commit transaction), `src/server/cli.ts` + `/api/brain/regenerate` route, Brain panel regenerate control.
- **Docs**: design.md D5 rewritten to the v2 contract; a "late-binding inventory" section added (identity, media, quotes, reactions, forwards, chat names, topics — each with anchor + stamp + repair path).
- **Tests**: normalization salvage paths, multi-error retry, anchoring lint, hedge preservation, relative-date resolution, entity junction commit, regenerate-supersede flow.
