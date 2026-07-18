## Context

Run controls live flat in `BrainPanel` (`src/client/panels.tsx`): name input (optional), provider/model selects, probe, chat count, Run, Regenerate, Reset. `BrainRunRequest` supports `mode/model/chatSourceId/maxChats/maxModelCalls/regenerate` but the UI exposes only mode/model/chats. Owner identity is a single `schema_meta` display name; self-ness in evidence comes exclusively from `fromMe`/`"me"` sentinels (`isSelfMessage`), so the owner's other numbers label as ordinary contacts. Usage accuracy differs by provider: claude-cli surfaces exact usage; codex falls back to character estimates flagged `estimated`. The app has an established modal pattern (`modalBackdrop` + modal section, e.g. `PairingModal`) and SSE-driven refresh.

## Goals / Non-Goals

**Goals:**
- One run console modal owning identity + run configuration, in the app's design language, dark/light safe.
- Owner name mandatory for user-triggered runs (UI-disabled with reason, server-refused with a clear message).
- Owner self-JIDs with absolute labeling precedence, configured via an archive-aware autocomplete that always shows a number's current resolved name.
- Every run budget visible and validated client-side, enforced server-side: chats, model calls (ledger-aware), and a new token budget with a named stop.
- Impossible combinations disabled with stated reasons, never silently ignored.

**Non-Goals:**
- No person-layer changes (self numbers are owner config, not `person_members` rows; a future change may unify).
- No search/FTS or graph re-derivation for self precedence beyond what regeneration already provides (bumping `EXTRACTION_VERSION` makes old episodes regenerable; backfilling labels retroactively is regeneration's job).
- No scheduler behavior change: auto mode keeps the "the archive owner" fallback so enabling auto without a name never stalls silently.
- No chat-scoped run picker in this pass (API supports it; UI defers until a real need).

## Decisions

### C1. Self identities in `schema_meta`, canonical, validated at write

`owner_self_jids` stores a JSON array of canonical identity JIDs (`@s.whatsapp.net`/`@lid` only), written through a new `setArchiveOwnerSelfJids`/`getArchiveOwnerSelfIdentities` repository pair (both repos). Input accepts bare digit strings or JIDs; the server normalizes (digits → `<digits>@s.whatsapp.net`), canonicalizes through identity links, dedupes, and rejects non-phone-shaped input (8–15 digits). Reads return `{jid, number, currentLabel, messageCount}` — the label the archive would OTHERWISE use, which is exactly what the picker must show to prevent mis-selection. *Why schema_meta*: bounded owner config beside `owner_display_name`; a table adds nothing until self identities grow semantics (person-layer unification is a named future).

### C2. Labeler precedence, stamps exemption, version bump

`buildPackLabeler(messages, ownerName, selfJids)` treats a participant as the owner when `isSelfMessage` OR its canonical JID ∈ selfJids — senders, quoted senders, reactors, mention identities alike render `ownerLabel` ("Name (me)"), their label variants anchor entities to the owner identity, and they are exempt from `numberTokenJids`/`pushNameJids` stamps (self is never "unresolved"). Precedence is absolute by construction: the self check runs before any display-name lookup, so a saved contact name cannot win. Evidence rendering changes ⇒ `EXTRACTION_VERSION` bumps; committed episodes become regenerable (existing Extraction Versioning requirement covers the mechanics).

### C3. Suggestions endpoint: substring over the archive, no inference

`GET /api/brain/owner/identity-suggestions?q=` matches identity-server JIDs from `contacts` by digit substring or name substring (LIKE, indexed enough at 4k contacts), capped at 12, each row `{jid, number, label, messageCount, isSelf}` ordered by message count. Deliberately dumb: no person-graph expansion, no ranking cleverness — the user asked for plain autocomplete, and the current-name display is the mistake-prevention mechanism.

### C4. Token budget as a first-class named stop

`BrainRunRequest.maxTokens` → the run loop accumulates `usage.inputTokens + usage.outputTokens` per model call and stops BEFORE the next call once the sum reaches the budget: remaining work stays pending, run ends `budget_exceeded` with a token-naming message (same family as call budgets — never silent). Provider status gains `tokenUsage: "exact" | "may-estimate"` (claude-cli exact; codex may-estimate, since it falls back to character estimates). UI: extractive mode disables both budgets ("no model calls to budget"); may-estimate annotates the token field ("estimates count toward this budget") rather than lying about precision.

### C5. Mandatory owner name at the user-triggered choke points

`POST /api/brain/runs`, `POST /api/brain/regenerate`, and CLI `brain-run`/`brain-regenerate` refuse with "Set your name first — episodes label your messages with it." when `getArchiveOwnerName()` is null. The automatic scheduler pass is exempt (documented): auto mode predates the constraint and must not silently stall; its episodes keep the fallback label and remain regenerable.

### C6. Modal in the house pattern, validation as derived state

`RunConsoleModal` (in `panels.tsx`, state owned by `BrainPage`) uses `modalBackdrop` + a new `runConsoleModal` section styled beside `pairingModal`: three sections (Identity, Run, Budgets). Reset stays OUT of the modal (user feedback 2026-07-18): it is a destructive archive-level control, not run configuration — it lives on the panel row as a quiet danger button. Panel and graph-strip metrics render shimmer skeletons (never placeholder zeros) until the first status/stats answer arrives, with their action buttons disabled while loading. Validation is a single pure function `deriveRunValidation(state) → {fieldErrors, disabledFields: {field: reason}, runDisabledReason}` so the UI can only render what the matrix allows: no name → Run disabled; extractive → model select + call/token budgets + regenerate disabled with reasons; `sessionMissing`/`degraded` → Run disabled with the provider's message (Probe offered); numeric ranges clamped on input with inline errors; self-number input adds only phone-shaped values or picked suggestions, dedupes, and marks entries whose current label differs from the owner name with that label as a warning chip. The panel itself slims to summary + "Run brain…" + the run-due alert.

## Risks / Trade-offs

- **[Self numbers mis-tagged by the user]** → the picker always shows the number's current resolved name + message count; removal is one click and takes effect on the next pack; regeneration repairs history.
- **[Token estimates under codex drift from real spend]** → the field is annotated, the ledger already flags estimated rows, and the stop is conservative (checked before each call).
- **[Auto-scheduler exemption surprises]** → documented in the spec delta; the modal nudges toward setting the name anyway (it is required for any manual run).
- **[Modal regressions on a surface used mid-quota-weekend]** → change is additive on the API side; old fields keep working; browser verification exercises the full matrix before handoff.

## Migration Plan

1. Additive server changes (routes accept old bodies; new fields optional).
2. `EXTRACTION_VERSION` bump lands with the labeler change; regenerable count simply grows — no forced regeneration.
3. Rollback: revert client; server additions are inert without callers.

## Open Questions

- Should self identities eventually live in the person layer as an "owner person"? Deferred — noted as the likely follow-up when MCP grants need owner scoping.
