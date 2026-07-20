# brain-model-provider Delta Spec

## MODIFIED Requirements

### Requirement: Provider Privacy
Provider adapters SHALL send only the prepared evidence or query context, never store session material outside the private workspace, and never write prompts, message bodies, model outputs, or credentials to default logs. Prompts and model outputs MAY be captured to the local call-audit store ONLY when payload capture is explicitly enabled by the owner; that capture SHALL default to off, SHALL remain on the local machine, and SHALL be treated as sensitive derived data. Credentials and session tokens SHALL NEVER be captured to the audit store under any setting.

#### Scenario: Failure logged safely
- **WHEN** a provider call fails
- **THEN** recorded diagnostics and default logs contain error class, counts, and token estimates but no prompt or message content

#### Scenario: Opt-in capture is local and off by default
- **WHEN** the owner has not enabled payload capture
- **THEN** no prompt or model-output text is persisted anywhere, and enabling capture stores that text only in the local audit store, never in logs and never off the machine

## ADDED Requirements

### Requirement: Per-Call Audit Record Emission
The provider boundary SHALL emit one audit record per call at the single `generateStructured()` chokepoint, covering successful calls, health probes, and failures alike. The record SHALL carry the provider, resolved model, reasoning effort, wall-clock latency, token usage with the estimated flag, a success flag with a stable public error code on failure, and the caller-supplied audit context (purpose and run/task/chat linkage) threaded through the generation request. Emission SHALL go through an injected sink so the provider module holds no direct repository dependency; when no sink is installed, or the sink throws, the call SHALL proceed and return unchanged.

#### Scenario: Record emitted for success and failure
- **WHEN** any call passes through the provider boundary, whether it succeeds or throws
- **THEN** the boundary emits one audit record with the call's provider, model, effort, latency, usage, status, and caller context

#### Scenario: Absent sink is a no-op
- **WHEN** the provider runs with no audit sink installed
- **THEN** generation behaves exactly as before with no error and no recorded row
