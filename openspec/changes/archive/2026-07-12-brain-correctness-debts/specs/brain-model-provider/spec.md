## ADDED Requirements

### Requirement: Startup Provider Reachability Probe
When a remote, model-backed provider is enabled and a session is present, the server SHALL run the provider's end-to-end reachability probe at startup, non-blocking, so a broken invocation (including a WSL bridge that no longer reaches the CLI) becomes a visible degraded state before the first run rather than surfacing only when a run is refused. Startup SHALL NOT block on the probe.

#### Scenario: Broken bridge is degraded from boot
- **WHEN** the server starts with a remote provider enabled whose configured invocation is unreachable
- **THEN** the startup probe records a degraded state and brain status shows the provider degraded without any run having been triggered

#### Scenario: Startup is not blocked by the probe
- **WHEN** the startup probe is slow or hangs on a remote round-trip
- **THEN** the server finishes starting and serving requests without waiting for the probe to return

### Requirement: Truthful Token Usage Accounting
Provider adapters SHALL record real token usage for every model call, and where the provider does not yet surface a usage object the adapter SHALL record a character-based estimate and flag the ledger row as estimated. Ledger rows SHALL never record silent zero usage for a call that consumed the model.

#### Scenario: Codex usage is recorded, not zeroed
- **WHEN** a codex-backed generation completes
- **THEN** the ledger row records the call's real input and output token usage from the completion, not zero

#### Scenario: Missing usage is estimated and flagged
- **WHEN** a provider call completes without a usage object available
- **THEN** the ledger row records a character-based token estimate and is marked estimated rather than recording zero
