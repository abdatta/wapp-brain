## ADDED Requirements

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

## MODIFIED Requirements

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
