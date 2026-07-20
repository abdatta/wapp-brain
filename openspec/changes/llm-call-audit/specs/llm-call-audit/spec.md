# llm-call-audit Delta Spec

## ADDED Requirements

### Requirement: Per-Call Audit Capture
The brain SHALL record exactly one audit row for every call that passes through the `generateStructured()` provider boundary, written at that single chokepoint so coverage is complete — including health probes and calls that fail. Each row SHALL capture, always and regardless of any opt-in, only non-sensitive metadata: a timestamp, the provider, the resolved model, the reasoning effort (when the provider has one), the caller-supplied purpose and run/task/chat linkage, the wall-clock latency, the input and output token counts with the `estimated` flag, output size in bytes, and a success flag with a stable public error code on failure. No prompt, message body, model output, or credential SHALL appear in these metadata columns.

#### Scenario: Successful call is captured
- **WHEN** a model-backed generation completes successfully through the provider boundary
- **THEN** one audit row exists carrying the provider, model, effort, purpose, linkage, latency, token usage, and a success flag, with no prompt or response text in any metadata column

#### Scenario: Failed call is captured
- **WHEN** a provider call fails (timeout, bad envelope, degraded refusal, or non-JSON output)
- **THEN** one audit row exists with the success flag false and the stable public error code, even though the caller-side token ledger never recorded the call

#### Scenario: Probe is captured like any call
- **WHEN** the provider reachability probe runs
- **THEN** its call is recorded as an audit row with its purpose marked as a probe

### Requirement: Opt-In Payload Capture
The system SHALL capture the full system+user prompt and the raw model response for a call ONLY when payload capture is explicitly enabled by configuration, which SHALL default to off. Captured payloads SHALL be stored solely in the local archive, treated as sensitive derived data, and truncated to a configured per-row byte cap with a flag marking truncation. When payload capture is off, payload columns SHALL remain null while metadata capture continues unaffected.

#### Scenario: Payloads absent by default
- **WHEN** a call is captured with payload capture at its default off state
- **THEN** the audit row has full metadata and null prompt and response columns

#### Scenario: Payloads present when enabled
- **WHEN** payload capture is explicitly enabled and a call runs
- **THEN** the audit row additionally carries the exact system+user prompt and raw response, each truncated to the configured cap with a truncation flag when exceeded

### Requirement: Bounded Audit Retention
The audit table SHALL be bounded by a configured maximum row count, pruning oldest rows first as new calls are recorded, so diagnostic capture never grows without limit. Pruning SHALL be a cheap indexed operation that never blocks the server event loop.

#### Scenario: Oldest rows pruned at the cap
- **WHEN** the configured maximum row count is exceeded by new captures
- **THEN** the oldest audit rows are removed so the row count stays at or below the cap, and the most recent calls remain

### Requirement: Capture Never Affects The Observed Call
Audit capture SHALL be best-effort and strictly observational: it SHALL run outside the call's timed path, SHALL NOT change the request sent, the response returned, or the success/failure outcome, and SHALL NOT add a provider round-trip. A capture or sink failure SHALL be swallowed and surfaced only through safe local diagnostics, never propagated to the caller.

#### Scenario: Sink failure does not break the call
- **WHEN** the audit sink throws while recording a call
- **THEN** the model call's result or error is returned to the caller unchanged and the failure is not raised

#### Scenario: Capture is transparent to behavior
- **WHEN** the same call runs with capture enabled and with capture disabled
- **THEN** the request sent to the provider and the result returned to the caller are identical in both runs

### Requirement: Call Audit Read Surface
The system SHALL expose a local read surface listing captured calls in reverse-chronological order with their metadata (time, purpose, provider, model, effort, latency, tokens, status) and a single-call detail view. Payload prompt and response SHALL be shown only when they were captured; when they were not, the detail view SHALL show an explicit off state explaining that payload capture is disabled and how to enable it. The detail route SHALL be localhost-only and non-caching, consistent with the archive's other sensitive focused routes.

#### Scenario: Call list reads newest first
- **WHEN** the owner opens the calls surface after several calls have run
- **THEN** the calls list them newest first with per-call metadata and a status for successes and failures

#### Scenario: Detail shows payloads only when captured
- **WHEN** the owner opens a call whose payloads were captured
- **THEN** the detail view renders the exact prompt and response; and for a call captured with payloads off, it renders the off state instead of empty fields

### Requirement: Audit Data Is Derived And Resettable
The audit table SHALL be derived diagnostic data, not archive-of-record: it SHALL be wiped by brain derived-data reset and by cleanup, SHALL never be uploaded, and SHALL never appear in default logs. Losing it SHALL affect only historical inspection, never archive or brain correctness.

#### Scenario: Reset wipes the audit table
- **WHEN** brain derived data is reset
- **THEN** the audit table is emptied in the same operation and subsequent calls repopulate it

#### Scenario: Payloads stay out of default logs
- **WHEN** payload capture is enabled and calls run
- **THEN** captured prompts and responses appear only in the local audit store and its focused route, never in console output or debug logs
