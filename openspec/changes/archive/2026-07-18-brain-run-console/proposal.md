# Brain Run Console

> User-requested (2026-07-18, mid-quota-weekend): modernize the Brain run controls, move configuration into a modal, make the owner name mandatory, add owner self-numbers with precedence labeling, and expose every run budget with validations that make invalid combinations unpickable.

## Why

The Brain panel's run controls grew organically into a flat strip of inputs (name, provider, model, probe, chats, run, regenerate, reset) with no validation story: a run can start with no owner name (episodes then say "the archive owner"), budgets beyond chat-count are invisible (max model calls exists in the API but not the UI; no token budget exists at all), and there is no way to tell the brain that another number in the archive is *you* — so the owner's second SIM shows up in episodes as a third person, under whatever name it happens to be saved as. With an unlimited-quota weekend ahead (large attended runs), the run surface needs to be trustworthy: every knob visible, every invalid combination disabled with a reason, and identity configured correctly before spend.

## What Changes

- **Run console modal**: the panel keeps a clean summary (coverage, provider/model, last run) plus one primary "Run brain…" button; all configuration moves into a modern modal — identity section, run mode (assimilate / regenerate), provider/model, budgets, and a danger zone (reset).
- **Owner name becomes mandatory for user-triggered runs**: the modal blocks Run until a name is set, and the server refuses UI/CLI-triggered runs without one (the automatic scheduler keeps its fallback so auto mode never silently stalls).
- **Owner self-identities**: a configurable list of additional numbers that are *the owner*. Evidence labeling treats them with absolute precedence — a self-number sender renders as "Name (me)" even when that number is saved under some other contact name. Stored as canonical JIDs; entity anchoring, late-binding stamps, and prompt identity all follow. `EXTRACTION_VERSION` bumps (evidence rendering changed), so existing episodes become regenerable.
- **Self-number picker**: type-ahead over identities already in the archive (simple substring autocomplete over numbers/names — no inference), each suggestion showing the number's *current* resolved name and message count so picking someone else by mistake is visually impossible; free-form numbers validated as phone-shaped.
- **Budgets, all of them, validated**: chats per run, max model calls (pre-filled from config, capped by the remaining daily ledger), and a new **max token budget** enforced by the run loop as a named budget stop. Client and server validate ranges; impossible combinations are disabled with a stated reason — extractive mode disables model/model-budgets/regenerate; a missing or degraded provider session disables Run with the provider's own message; the token budget is annotated or withheld when the active provider can only estimate usage.
- **Checkpoint**: with no name set, Run is disabled with a reason and the API refuses; adding a self number whose contact is saved as another name shows that name in the picker and, once saved, a new episode labels that sender "Name (me)"; extractive mode visibly disables model budgets; an over-range budget cannot be submitted; a token-budget run stops as `budget_exceeded` naming tokens.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: Manual-First Run Control gains the validated run-console contract (mandatory owner name, visible budgets, refusal semantics); new requirement for owner self-identity precedence in evidence labeling; token budget joins the ledger's named-stop family.

## Impact

- **Schema**: none new (`schema_meta` key `owner_self_jids`, canonical JIDs as JSON).
- **Code**: `src/server/brain/episodes.ts` (labeler self-set + version bump), `runJob.ts` (token budget), `provider.ts` (usage-accuracy surface), owner routes + suggestions endpoint in `server.ts`, repository methods (both repos), CLI guard; client: `BrainPage`/`panels.tsx` run console modal, autocomplete, validation, styles.
- **Tests**: labeler precedence + stamps exemption, owner API validation, suggestions endpoint shape, token-budget stop, run-refusal without owner name, mirror parity.
