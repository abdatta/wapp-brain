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
The system SHALL track consecutive provider failures, and after a configured threshold SHALL enter a visible degraded state (extractive-only) recording the degradation start time, surface it in brain status and doctor output, raise an alert through the operational alerting channel, and probe for recovery; degradation SHALL never be silent.

#### Scenario: CLI breaks mid-week
- **WHEN** the claude-cli provider fails three consecutive calls
- **THEN** subsequent tasks use the extractive fallback, status shows degraded-since, and an alert is raised

#### Scenario: Provider recovers
- **WHEN** a degraded provider's health probe succeeds
- **THEN** the brain exits the degraded state and records the recovery

### Requirement: Provider Privacy
Provider adapters SHALL send only the prepared evidence or query context, never log prompts, message bodies, model outputs, or credentials, and store session material only under the private workspace.

#### Scenario: Failure logged safely
- **WHEN** a provider call fails
- **THEN** recorded diagnostics contain error class, counts, and token estimates but no prompt or message content

