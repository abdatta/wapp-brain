# brain-model-provider Specification

## Purpose
TBD - created by archiving change build-the-brain. Update Purpose after archive.
## Requirements
### Requirement: Provider Interface
The brain SHALL access language models exclusively through a single provider interface that accepts a system prompt, user content, an output schema, an output token bound, and an optional model selection, and returns validated structured JSON with token usage; consolidation and retrieval code SHALL NOT branch on provider identity.

#### Scenario: Provider swapped without pipeline change
- **WHEN** the configured provider changes between claude-cli, codex, and extractive
- **THEN** assimilation and deep-query behavior changes only in generation quality, not in control flow

### Requirement: User Model Selection
Each model-backed provider SHALL expose its selectable models (claude: fable, opus, sonnet, haiku; codex: gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna), the user SHALL be able to pick the provider and model from the UI (persisted as the default until changed), and ledger entries SHALL record which provider and model each call used.

#### Scenario: Model picked from the UI
- **WHEN** the user selects a provider and model in the brain panel
- **THEN** subsequent generation uses that selection and the choice survives restarts

#### Scenario: Per-run override
- **WHEN** a run is triggered with an explicit model
- **THEN** that run uses the override without changing the persisted default

### Requirement: Claude CLI Adapter
The system SHALL provide a provider adapter that invokes the local Claude Code CLI as a child process in non-interactive single-turn JSON mode, with tool access disabled, working directory pinned outside the private workspace, the prompt delivered over stdin, and a configurable invocation command supporting environments where the CLI is reachable only through a WSL bridge; the adapter SHALL parse structured output and never block the server event loop.

#### Scenario: Generation via CLI
- **WHEN** an episode task runs with the claude-cli provider enabled
- **THEN** the CLI is spawned per call, its JSON output is parsed and schema-validated, and failures are recorded as retryable task errors

#### Scenario: CLI reachable only inside WSL2
- **WHEN** the configured invocation is a WSL bridge command and the host process runs on Windows
- **THEN** prompts pass via stdin without any file path crossing the Windows/WSL boundary, and a startup health probe runs the exact configured invocation end-to-end so bridge failures surface as a visible degraded state

### Requirement: Codex Adapter Parses Responses
The Codex adapter SHALL send structured prompts through the existing OAuth client and parse the model response into the structured output contract; discarding model output SHALL be treated as a defect, not a mode.

#### Scenario: Codex output committed
- **WHEN** a consolidation runs with the codex provider enabled and opted in
- **THEN** committed pages reflect the model's generated content, subject to citation validation

### Requirement: Extractive Fallback
An always-available extractive provider SHALL produce citation-valid digests without any model, used when no provider is enabled, when budget is exhausted, or when generation fails validation twice, so assimilation coverage never blocks on model availability.

#### Scenario: No provider configured
- **WHEN** the brain runs with no model provider enabled
- **THEN** episodes commit with extractive digests and are labeled as extractive quality

### Requirement: Explicit Remote Opt-In
Providers that send archive-derived content off the local process (including the Claude CLI and Codex) SHALL be disabled until the user explicitly enables one, acknowledging that selected evidence will be sent to that provider; scheduled runs SHALL never enable or switch providers silently.

#### Scenario: Run without opt-in
- **WHEN** consolidation needs model generation and no remote provider is opted in
- **THEN** the run proceeds extractive-only and reports why

#### Scenario: Opt-in is provider-specific
- **WHEN** the user enables one provider
- **THEN** other providers remain disabled until individually enabled

### Requirement: Provider Health And Degradation
The system SHALL track consecutive transient provider failures, and after a configured threshold SHALL enter a visible degraded state (extractive-only) recording the degradation start time, the consecutive-failure count, and the actual last error, surface it in brain status and doctor output, raise an alert through the operational alerting channel, and probe for recovery; degradation SHALL never be silent. The recorded last error SHALL be available to run-interrupt messages so they name the true measured cause rather than a hardcoded guess. Deterministic-in-request failures SHALL NOT increment the consecutive-failure counter: they prove the provider is reachable and answering, so counting them latches a healthy provider as degraded and halts a run over content the provider will never accept.

#### Scenario: CLI breaks mid-week
- **WHEN** the claude-cli provider fails the configured number of consecutive calls (default 3) with transient errors
- **THEN** subsequent tasks use the extractive fallback, status shows degraded-since with the recorded last error, and an alert is raised

#### Scenario: Provider recovers
- **WHEN** a degraded provider's health probe succeeds
- **THEN** the brain exits the degraded state and records the recovery

#### Scenario: Rejected payloads never latch a healthy provider
- **WHEN** a run sends many payloads the provider rejects with an HTTP 400-class error, exceeding the configured consecutive-failure threshold in count
- **THEN** the provider does NOT enter the degraded state, health continues to reflect a reachable provider, and the run reports the rejected work rather than a provider outage

### Requirement: Provider Privacy
Provider adapters SHALL send only the prepared evidence or query context, never log prompts, message bodies, model outputs, or credentials, and store session material only under the private workspace.

#### Scenario: Failure logged safely
- **WHEN** a provider call fails
- **THEN** recorded diagnostics contain error class, counts, and token estimates but no prompt or message content

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

### Requirement: Well-Formed Generation Requests
Every generation request SHALL carry well-formed Unicode when it leaves the process. The provider boundary SHALL normalize the system and user text so no unpaired UTF-16 surrogate can reach an adapter, whichever builder produced the text. Because a correct builder never emits one, the boundary SHALL record when the normalization actually changes the text — the guard firing is itself a defect signal, not routine operation — using the existing privacy-safe diagnostics (call purpose and counts, never prompt content).

#### Scenario: A malformed prompt is repaired at the boundary
- **WHEN** a prompt reaches the provider boundary carrying an unpaired surrogate
- **THEN** the request is normalized to well-formed Unicode before dispatch, the call proceeds, and the substitution is recorded as a defect signal without logging any prompt content

#### Scenario: Well-formed prompts pass through untouched
- **WHEN** a prompt contains astral characters as correctly paired surrogates
- **THEN** the text is dispatched byte-identical and nothing is recorded

### Requirement: Provider Failure Classification
Provider failures SHALL be classified as either deterministic-in-request — the provider is reachable and refused this specific payload, such as an HTTP 400-class rejection — or transient, covering outages, timeouts, transport errors, auth failures, and usage limits. A deterministic-in-request failure SHALL NOT be retried with byte-identical input, since the same bytes cannot succeed, and SHALL be surfaced to the caller as a distinct, non-retryable failure class so callers can quarantine the offending work rather than treat the provider as unavailable.

#### Scenario: A 400-class rejection is not retried
- **WHEN** a generation call fails with an HTTP 400-class rejection and the caller would otherwise resend the same prompt
- **THEN** the failure is reported as deterministic-in-request, no retry is issued against identical input, and the reason is preserved for the caller

#### Scenario: A timeout stays retryable
- **WHEN** a generation call fails with a timeout or transport error
- **THEN** the failure is classified transient and existing retry and health behavior applies unchanged

