## 1. Schema + chokepoint metadata capture (checkpoint: run a scoped job, see the calls appear)

- [ ] 1.1 Add `brain_llm_calls` DDL to the SQLite schema: metadata columns (`id`, `at_ms`, `provider`, `model`, `effort` nullable, `purpose`, `run_id` nullable, `task_id` nullable, `chat_source_id` nullable, `latency_ms`, `input_tokens`, `output_tokens`, `estimated`, `ok`, `error_code` nullable, `output_bytes`) plus nullable payload columns (`system_prompt`, `user_prompt`, `response_text`, `payload_truncated`); indexes on `(at_ms)`, `(run_id)`, `(purpose)`; add the table to the reset/delete table order. Verify schema-additivity on a real-archive copy.
- [ ] 1.2 Add the audit record + sink types to `shared/types.ts` (`BrainLlmCallRecord`, the `LlmAuditSink` interface, and an `audit?: { purpose; runId?; taskId?; chatSourceId? }` field on `BrainGenerationRequest`).
- [ ] 1.3 Implement the capture seam in `provider.ts`: a module-level `setLlmAuditSink(sink)` and a wrapper around `generateWithHealthTracking` that, on both the success and catch paths, computes latency and emits one record (provider, resolved model, effort, usage, ok/error_code, output bytes, passed-through audit context) via `sink?.record(...)` — best-effort, off the timed path, any throw swallowed. Keep `provider.ts` free of any repository import. The probe passes `audit.purpose = "probe"`.
- [ ] 1.4 Implement `recordBrainLlmCall` (metadata-only for now) + a bounded reader in `sqliteRepository`, mirrored in `memoryRepository`; install the sink at server startup so the provider writes through the repository.
- [ ] 1.5 Thread `audit` context at the existing call sites (episode, lifecycle, and the probe) so purpose/run/task/chat linkage lands — reuse the same `purpose` strings passed to `recordBrainLlmUsage`.
- [ ] 1.6 Tests: record emitted on success and on failure (with error code); probe captured; absent sink is a no-op; a thrown sink does not change the call's result or error; metadata columns never contain prompt/response text; memory/sqlite parity.
- [ ] 1.7 **User try-it checkpoint**: with a provider enabled, run a brain job scoped to one chat (per the model-run wedge hazard, never archive-wide) and confirm `brain_llm_calls` fills with one row per call carrying model, effort, latency, tokens, and status — including a deliberately failed call (e.g. degraded provider) that the token ledger never recorded.

## 2. Opt-in payload capture + bounded retention (checkpoint: enable → see prompt+response; disable → off; exceed cap → pruned)

- [ ] 2.1 Add config: `WAPP_BRAIN_LLM_AUDIT_CAPTURE_PAYLOADS` (default off), `WAPP_BRAIN_LLM_AUDIT_MAX_ROWS`, `WAPP_BRAIN_LLM_AUDIT_MAX_PAYLOAD_BYTES` in `config.ts` + `.env.example`, documented as sensitive/off-by-default.
- [ ] 2.2 Extend the capture path so that, only when payload capture is enabled, the record carries the exact system+user prompt and raw response, each truncated to the byte cap with `payload_truncated` set when exceeded; when disabled, payload columns stay null and metadata capture is unaffected.
- [ ] 2.3 Implement oldest-first retention prune to `WAPP_BRAIN_LLM_AUDIT_MAX_ROWS` on write, as a cheap indexed delete that never blocks the event loop (both repositories).
- [ ] 2.4 Tests: payloads null when off / present-and-capped when on; truncation flag at the byte cap; retention prunes oldest and keeps the newest; payloads never emitted to console/default logs; reset wipes the table; memory/sqlite parity.
- [ ] 2.5 **User try-it checkpoint**: enable payload capture, run a scoped job, and inspect one call's exact prompt + response in the DB; disable it and confirm new rows carry metadata only; drive past the row cap and confirm oldest rows are pruned.

## 3. Routed Calls read surface (checkpoint: open /brain/calls and inspect a real call end-to-end)

- [ ] 3.1 Routes: `GET /api/brain/calls` (reverse-chron list with metadata + optional filters purpose/provider/status) and a single-call detail endpoint that is localhost-only + `no-store` and returns payloads only when captured.
- [ ] 3.2 Client: a lazily code-split, reload-safe `/brain/calls` page (list with time/purpose/provider·model/effort/latency/tokens/status; click-through to deep-linkable single-call detail rendering metadata always and prompt/response when present, with an explicit "payload capture is off — how to enable" state otherwise); link to it from the brain run console.
- [ ] 3.3 Tests: list ordering + filters; detail returns payloads only when captured and the off-state otherwise; route is no-store; deep-link/reload restores a single call.
- [ ] 3.4 **User try-it checkpoint**: open `/brain/calls`, see recent real calls newest-first, click into one and read its metadata; with capture on, read its full prompt + response; confirm the run-console link and reload-safety (verify via `javascript_tool` per the live-sync screenshot hazard).

## 4. Verification gates and closeout

- [ ] 4.1 Full suite green (`npm test`), tsc build clean.
- [ ] 4.2 Docs: add a "Call Audit" section to `docs/SECURITY_AND_PRIVACY.md` (opt-in payload capture is sensitive local data, default off, retention-capped, wiped by reset/cleanup); update the `provider.ts` privacy header to reflect the sanctioned opt-in path.
- [ ] 4.3 Run `npm run roadmap:sync`.
