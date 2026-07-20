## Context

Every brain model call funnels through one boundary — `generateStructured()` in `src/server/brain/provider.ts`, dispatching to the `claude-cli`, `codex`, or `extractive` adapter. Today that boundary is deliberately opaque: its header states "prompts, model outputs, and session tokens are never logged," and the only per-call record is the `brain_llm_ledger` row the *caller* writes (`repository.recordBrainLlmUsage({ purpose })` in `runJob.ts`), which stores day/purpose/provider/token aggregates and nothing else. Consequences:

- No prompt, model, effort, latency, or response is inspectable for any individual call.
- **Failed calls leave no trace** — `generateStructured` throws before the caller's ledger write runs, so the calls most worth inspecting are exactly the ones with zero record.
- The ledger does not even record which *model* a call used, only the provider.

The archive owner wants transparency now, and the roadmap is about to spend the strong-model budget (HIGH-effort rollups in `semantic-rollups` #11, deep retrieval in `brain-retrieval-pipeline` #12) where both cost and rot risk concentrate. This change adds local, privacy-preserving, per-call transparency without new infrastructure.

The hard constraint is privacy. Prompts here are WhatsApp-derived evidence packs — message bodies, contacts, metadata. `docs/SECURITY_AND_PRIVACY.md` makes "all WhatsApp data stays local by default" the Core Rule and forbids logging prompts/outputs. Any capture of prompt/response content is therefore sanctioned only as **local, opt-in, sensitive derived data**.

## Goals / Non-Goals

**Goals:**
- One airtight capture point covering 100% of provider calls, including probes and failures.
- Rich per-call metadata always available (provider, model, effort, purpose, linkage, latency, tokens, status) at negligible cost and zero privacy risk.
- Full prompt+response available when the owner explicitly opts in, stored locally, size- and retention-capped, treated as sensitive.
- A reload-safe read surface to inspect one call end-to-end, linked from the run console.
- Zero new runtime dependencies and zero new infrastructure.

**Non-Goals:**
- No hosted or third-party observability service; no cloud egress of any prompt content.
- No trace waterfalls, prompt-diffing, eval-scoring dashboards, or replay/playground (Langfuse-class UI). If those are wanted later, this table is a clean feed for them.
- No change to *what* the brain sends a model or how it decides to call one — this is observation only.
- No unification of the existing token ledger into the audit table (they coexist; a later change may consolidate).
- No multimodal/media payloads (the provider seam is text-only today).

## Decisions

### D1: Build a local audit table + routed surface, not Langfuse (or any off-the-shelf tracer)

The obvious move is Langfuse. We rejected it for this app, on three independent grounds:

1. **No auto-instrumentation applies.** Langfuse's drop-in value is wrapping a standard SDK (`openai`) or a LangChain callback. Neither adapter here is that: `claude-cli` is a spawned `wsl.exe` subprocess reading a JSON envelope; `codex` is a custom `gpt-oauth-client`. There is no HTTP client to wrap and no `base_url` to point at a proxy (which also rules out Helicone-style proxies). We hand-instrument the single chokepoint regardless — so the tracer's *only* remaining contribution is its UI.
2. **Privacy.** Langfuse Cloud (the free Hobby tier) ships every prompt to a third-party cloud, a direct violation of the Core Rule given prompts are WhatsApp evidence. Self-hosted Langfuse keeps data local but requires a multi-container stack (Postgres + Clickhouse + Redis + object store) running beside a single-user local Windows app — disproportionate operational surface for a trace viewer.
3. **Fit.** The substrate for a native surface already exists: the single chokepoint, a SQLite layer with a ledger sibling, the brain run console, per-model spend surfaces, and the `BrainTokenUsage` plumbing. A table + one route reuses all of it and honors the privacy invariant natively.

**Alternatives considered:** Langfuse Cloud (rejected: cloud egress of private prompts); self-hosted Langfuse (rejected: infra weight vs. a single-user local app, for UI we can approximate); Helicone/proxy tracers (rejected: no standard endpoint to redirect); Arize Phoenix / OpenLLMetry via OTel (rejected: same privacy + infra tradeoffs, still hand-instrumented). **Revisit trigger:** if we later want prompt-version diffing, eval dashboards, or a replay playground *and* accept running the stack — the `brain_llm_calls` table is a ready export feed, so this is not a one-way door.

### D2: Capture via an injected sink at the chokepoint, keeping the provider DB-free

`provider.ts` today imports no repository — it is a pure boundary. To preserve that (and testability), capture is dependency-inverted: a module-level `setLlmAuditSink(sink)` lets the server install a writer at startup; the chokepoint calls `sink?.record(record)`. The provider never imports `sqliteRepository`.

Interception wraps `generateWithHealthTracking` (the point that already sees success and failure, model resolution, and timing) rather than each adapter — one wrapper, both providers, plus the probe. On both the success and the catch path it computes latency and assembles the record. **Alternative considered:** returning audit metadata on `BrainGenerationResult` and recording at each call site — rejected: it misses failures (the throw path returns nothing) and every call site would have to remember to record, defeating "airtight."

### D3: Metadata always, payloads opt-in — split by sensitivity, not convenience

Metadata (provider, model, effort, purpose, linkage, latency, tokens, status, error code, output bytes) is non-sensitive and cheap, so it is captured unconditionally — this alone answers "which model, how slow, how many tokens, did it fail." Payloads (system+user prompt, raw response) contain message bodies, so they are gated behind `WAPP_BRAIN_LLM_AUDIT_CAPTURE_PAYLOADS` (default off), truncated to `WAPP_BRAIN_LLM_AUDIT_MAX_PAYLOAD_BYTES` with a truncation flag, and treated exactly like the existing dry-run evidence previews (sensitive local data). This mirrors the established loopback-detail boundary: metadata is broadly safe; full content is owner-only, local, and deliberate.

### D4: Audit context threaded through the request

The chokepoint knows model/effort/latency/payloads/status; only the *caller* knows purpose and run/task/chat linkage. So `BrainGenerationRequest` gains an optional `audit?: { purpose; runId?; taskId?; chatSourceId? }`, populated by the episode, lifecycle, and (future) rollup call sites — the same `purpose` values already passed to `recordBrainLlmUsage` ("episode", "lifecycle", …), plus a "probe" for the health probe. Missing context degrades gracefully to an unlabeled row; it never blocks capture.

### D5: Best-effort, off the hot path, bounded

The sink runs after the model call resolves, outside the timed path, wrapped so any throw is swallowed to safe diagnostics — capture must never change a call's result, latency, or outcome. Writes use the existing synchronous better-sqlite3 layer (sub-millisecond for small rows; payload rows bounded by the byte cap), and retention prunes oldest-first to stay under `WAPP_BRAIN_LLM_AUDIT_MAX_ROWS` via an indexed delete, honoring the standing "never block the event loop" rule.

### D6: Derived, resettable, parity across repositories

`brain_llm_calls` is diagnostic derived data: added to the reset/delete table order so brain reset and cleanup wipe it, never uploaded, never in default logs. The writer/reader lands in both `sqliteRepository` and `memoryRepository` (parity, as the lifecycle change did) so tests and both runtimes agree.

### D7: Surface as a route, not a panel

`client-navigation` mandates "new UI surfaces are added as routes." The Calls surface is `/brain/calls` (sibling of `/brain/commitments`): reverse-chron list → deep-linkable single-call detail, lazily code-split, reload-safe, linked from the run console. The detail route is localhost-only + `no-store`, like the vCard route. "Panel in the run console" from the request is honored as a link into this route, not a bolted-in sub-view.

## Risks / Trade-offs

- **Payload capture is a real privacy surface** → default OFF; local-only; size- and retention-capped; documented in `SECURITY_AND_PRIVACY.md` as sensitive like dry-run previews; wiped by reset/cleanup; owner-only focused route. Enabling it is a deliberate, reversible act.
- **A large prompt could bloat a row** → per-row byte cap with a truncation flag; retention row-cap bounds total growth.
- **Capture bugs could perturb calls** → strictly observational, off the timed path, sink-throws-swallowed; a spec scenario asserts request/result are identical with capture on vs off.
- **Provider gains an (inverted) capture concern** → dependency-inverted sink keeps `provider.ts` repository-free; absent sink is a no-op, so unit tests and the extractive path are unaffected.
- **Audit ≠ ledger drift** → the two coexist by design; the audit table is the richer, failure-inclusive record, the ledger stays the budget authority. Consolidation is explicitly out of scope and left as a later option.
- **"Not Langfuse" may disappoint if rich UI is later wanted** → recorded revisit trigger in D1; the table is a clean export feed, so adopting a tracer later is not blocked.

## Migration Plan

No data migration — additive table plus new config flags, all defaulting to today's behavior (payloads off, metadata capture is new but non-sensitive). Per the roadmap's standing breaking-change sanction, the `brain_llm_calls` table may be dropped/recreated freely; it is derived and rebuilds from subsequent calls. Rollback is removing the sink installation and the route; the table can be left empty or dropped with no effect on archive or brain correctness.

## Open Questions

- **Default retention size** — `WAPP_BRAIN_LLM_AUDIT_MAX_ROWS` starting value (proposed a few thousand rows). Tune against real run volume during the phase-1 checkpoint.
- **CLI surface** — is a `brain:calls` list command worth shipping in phase 3, or is the route enough? Lean route-only unless the checkpoint shows a need.
- **Metadata vs payload retention split** — one row-cap for both is simplest; if payload rows dominate size we may later keep more metadata-only rows than payload rows. Defer until measured.
