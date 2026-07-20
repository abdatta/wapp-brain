# LLM Call Audit

> Proposal seed (2026-07-20). Demand-driven: the archive owner has no per-call transparency into what the brain sends each model. See `openspec/changes/ROADMAP.md` for ordering. **Recommended model: Opus** — provider-seam surgery, schema, and a routed read surface that are demanding but fully pinned by existing conventions (the `brain-model-provider` privacy contract, the ledger, the route architecture); no open contract judgment. Independent of the brain chain, but best landed **before** the strong-model rollup spend (`semantic-rollups` #11, `brain-retrieval-pipeline` #12) so those HIGH-effort calls are auditable from their first run.

## Why

Every model call the brain makes funnels through one boundary — `generateStructured()` — but by design nothing about an individual call is inspectable afterward. The `brain_llm_ledger` records only per-day/purpose/provider **token aggregates**; there is no way to see the exact prompt, model, reasoning effort, latency, or response for a given call, and failed calls (which never reach the caller-side ledger write) leave no trace at all. As the roadmap moves into strong-model, HIGH-effort consolidation — where the budget and the rot risk concentrate — that opacity is a correctness *and* cost blind spot. This adds local, privacy-preserving per-call transparency **without new infrastructure or a third-party service**.

We evaluated Langfuse (the obvious off-the-shelf answer) and rejected it for this app; the rationale is recorded in `design.md`. In short: neither provider is a standard SDK call (the claude-cli adapter is a spawned WSL subprocess; codex is a custom OAuth client), so there is no auto-instrumentation to inherit — the single chokepoint gets hand-wrapped either way, leaving only Langfuse's UI as the delta, bought at the cost of either shipping WhatsApp-derived prompts to a third-party cloud (a direct violation of the Core Privacy Rule) or standing up a multi-container stack (Postgres + Clickhouse + Redis + object store) beside a single-user local app.

## What Changes

- **New `brain_llm_calls` table** — one row per `generateStructured()` call, written at the single chokepoint via an injected capture sink so coverage is airtight (including health probes and, crucially, **failed calls**). Metadata is captured **always**: timestamp, provider, model, reasoning effort, purpose, run/task/chat linkage, latency, input/output tokens (+ the `estimated` flag), success/error code, and output size.
- **Opt-in payload capture** — the full system+user prompt and the raw model response are captured **only** when an explicit debug flag is enabled (default OFF). Payloads live solely in the local archive, are treated as sensitive derived data (like the existing dry-run evidence previews), and are subject to a per-row size cap.
- **Bounded retention** — a configurable row cap (ring-buffer prune, oldest-first) keeps the table from growing without limit; the audit table is derived/diagnostic and is wiped by brain reset and cleanup.
- **Routed "Calls" read surface** (`/brain/calls`) — a reverse-chronological call list (time, purpose, provider/model, effort, latency, tokens, status) with click-into-one-call detail, linked from the brain run console. Realized as a **route**, not an in-page panel, per the `client-navigation` contract. Payloads render only when capture is enabled; otherwise the detail view shows a clear "payload capture is off" state explaining how to turn it on.
- **BREAKING (sanctioned)** — the `brain-model-provider` **Provider Privacy** requirement is amended: prompts and model outputs remain unlogged by default, but MAY be captured to the local audit store under explicit opt-in. Covered by the roadmap's standing breaking-change sanction; the audit table is rebuildable/derived.
- **Explicitly not Langfuse** — no new service, no Docker stack, no cloud egress; zero new npm dependencies.

## Capabilities

### New Capabilities

- `llm-call-audit`: per-call capture at the provider chokepoint (metadata always, payloads opt-in), bounded local retention, a routed read surface for inspecting one call end-to-end, and the guarantee that capture never alters or slows the calls it observes.

### Modified Capabilities

- `brain-model-provider`: the **Provider Privacy** requirement is amended to permit opt-in, local-only payload capture; a new requirement makes the provider emit a per-call audit record at the chokepoint (covering successes, probes, and failures) through an injected sink, keeping the provider free of a direct repository dependency.
- `client-navigation`: a new routed, lazily code-split, reload-safe `/brain/calls` surface, reachable from the brain run console.

## Impact

- **Schema**: new `brain_llm_calls` table (metadata columns + nullable payload columns), indexed on `at_ms`, `run_id`, and `purpose`; added to the reset/delete table order. New config: `WAPP_BRAIN_LLM_AUDIT_CAPTURE_PAYLOADS` (default off), `WAPP_BRAIN_LLM_AUDIT_MAX_ROWS` (retention cap), `WAPP_BRAIN_LLM_AUDIT_MAX_PAYLOAD_BYTES` (per-row payload cap).
- **Code**: a capture hook at `generateWithHealthTracking` in `src/server/brain/provider.ts` (the one interception point) driven by a module-level sink installed at server startup; an audit context (`purpose`, `runId`, `taskId`, `chatSourceId`) threaded through `BrainGenerationRequest`; writer/reader + retention prune in `sqliteRepository` with `memoryRepository` parity; `GET /api/brain/calls` (list) + detail route (localhost-only, `no-store`); a lazily-loaded `/brain/calls` client page + run-console link; optional `brain:calls` CLI.
- **Dependencies**: **none added** — the whole point versus Langfuse.
- **Docs**: `docs/SECURITY_AND_PRIVACY.md` gains a "Call Audit" note (opt-in payload capture is sensitive local data, default off, retention-capped); the provider.ts privacy header is updated to reflect the sanctioned opt-in path.
- **Privacy**: payload capture is default OFF; when ON it is local-only, size- and retention-capped, never in default logs, and viewable only through the focused localhost route — consistent with the existing loopback-detail and vCard privacy boundaries.
