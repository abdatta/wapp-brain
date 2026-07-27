## ADDED Requirements

### Requirement: No-Durable-Claims Declaration Rate
Per-model quality aggregates SHALL report the rate at which episodes committed with a declared empty claim set, per model stamp and extraction version, with its denominator, alongside the existing fallback and issue rates. Licensing an explicit "nothing durable here" answer also gives a model a legitimate way to finish early, so the rate at which it is used SHALL be a visible measured number rather than an inference. The declaration's stated reason SHALL be retained on the episode so it can be read against the evidence, making the assertion auditable rather than merely counted.

#### Scenario: Declaration rate appears beside the fallback rate
- **WHEN** the quality surface renders per-model aggregates and at least one episode committed with a declared empty claim set
- **THEN** the declaration rate is shown per model stamp with its denominator, next to the fallback rate and issue rates

#### Scenario: A model that over-declares is visible
- **WHEN** one model's declaration rate is materially higher than another's on comparable packs
- **THEN** the difference is readable from the aggregates with sample sizes shown, without requiring a separate investigation

#### Scenario: The stated reason survives for audit
- **WHEN** an episode committed with a declared empty claim set is later inspected
- **THEN** the reason the model gave is available alongside the episode's evidence, so a reader or grader can judge whether the declaration was truthful
