# brain-assimilation — brain-run-console delta

## MODIFIED Requirements

### Requirement: Manual-First Run Control
Automatic consolidation SHALL be paused by default: the brain SHALL compute when a run is due (pending backlog plus a passed consolidation window) and surface a visible "run due" alert in the UI and status APIs, but SHALL NOT spend model budget until the user triggers a run or explicitly enables automatic scheduling. Every triggered run SHALL carry the user's provider and model selection, controllable entirely from the UI. User-triggered runs (UI routes and CLI) SHALL be refused with a clear message while no archive owner name is set; the automatic scheduler pass SHALL be exempt and keep its documented fallback label so enabling auto mode never stalls silently. The run configuration surface SHALL expose every run budget — chats per run, max model calls, and max token budget — with client-side validation mirrored by server-side clamps, and SHALL disable impossible selections with a stated reason rather than ignoring them: extractive mode disables model selection, model-call and token budgets, and regeneration; a missing or degraded provider session disables starting a model run while offering the probe; numeric budgets outside their ranges cannot be submitted.

#### Scenario: Run due but not auto-executed
- **WHEN** backlog exists and the consolidation window has passed with scheduling paused
- **THEN** the UI shows a run-due alert with the pending scope, and no model call happens until the user starts the run

#### Scenario: User triggers a run with a chosen model
- **WHEN** the user starts a brain run from the UI selecting a provider and model
- **THEN** the run executes with exactly that provider and model, its usage is recorded against them in the ledger, and progress is visible throughout

#### Scenario: Run refused without an owner name
- **WHEN** no archive owner name is set and a run or regeneration is triggered from the UI or CLI
- **THEN** the request is refused with a message naming the missing owner name, and the run console disables its start control with the same reason

#### Scenario: Extractive mode disables model-only controls
- **WHEN** the user selects extractive mode in the run console
- **THEN** model selection, the model-call budget, the token budget, and regeneration are disabled each with a stated reason, and a started run performs zero model calls

#### Scenario: Auto mode keeps working without a name
- **WHEN** automatic scheduling is enabled with no owner name set
- **THEN** scheduled passes still execute using the documented fallback owner label and their episodes remain regenerable

### Requirement: Token Budget Ledger
The brain SHALL record every model call's purpose and token usage in a daily ledger and SHALL enforce configurable daily call and token caps as a hard named block state, never silent degradation; budget-skipped work SHALL be reported in run summaries. A run that terminates in any non-completed terminal state (interrupted, budget-exceeded, failed) SHALL persist the totals it accumulated before stopping, and a budget-exceeded run SHALL persist a count of work left pending because the budget was reached. A user-triggered run MAY additionally carry a per-run maximum token budget: the run loop SHALL accumulate each model call's input and output tokens and stop before the next call once the budget is reached, ending the run as budget-exceeded with a message naming the token budget, with remaining work left pending. Provider status SHALL state whether the active provider's reported usage is exact or may be estimated, and surfaces offering the token budget SHALL reflect that accuracy.

#### Scenario: Budget exhausted
- **WHEN** the daily cap is reached mid-run
- **THEN** remaining tasks stay pending, the run reports a budget-exceeded state, and work resumes when budget is available

#### Scenario: Budget-exceeded run keeps its totals
- **WHEN** a run commits several episodes and then stops because the model-call budget is reached
- **THEN** the persisted run record retains the committed episode, claim, chat, and model-call counts and records how many chats were left pending for budget

#### Scenario: Token budget stops the run by name
- **WHEN** a run is started with a maximum token budget and accumulated usage reaches it
- **THEN** no further model call is made, the run ends budget-exceeded with a message naming tokens, committed episodes and coverage are kept, and remaining backlog stays pending

#### Scenario: Estimated usage is disclosed where the budget is offered
- **WHEN** the active provider can only estimate token usage for some calls
- **THEN** provider status reports that accuracy and the run console annotates the token budget accordingly instead of presenting estimates as exact

## ADDED Requirements

### Requirement: Owner Self-Identities
The archive owner SHALL be able to configure additional self-identity numbers (canonical identity JIDs) that the brain treats as the owner with absolute precedence: in evidence packs, a sender, quoted sender, reactor, or mention identity matching a self JID SHALL be labelled with the owner label ("Name (me)") even when that number is saved under a different contact name anywhere in the archive; its label variants SHALL anchor entities to the owner identity; and self JIDs SHALL never be stamped as unresolved or push-name participants. Self identities SHALL be stored canonically, validated as phone-shaped identity JIDs, and deduplicated. Because evidence rendering changes, the extraction version SHALL be bumped so previously committed episodes become regenerable. The configuration surface SHALL suggest identities already present in the archive via plain substring autocomplete over numbers and names — no relationship inference — and every suggestion and saved entry SHALL display the number's current otherwise-resolved name and message count so selecting a different person by mistake is visible before saving.

#### Scenario: Self number labelled as the owner despite a saved name
- **WHEN** a number saved in contacts as another name is configured as a self identity and a pack containing its messages is generated
- **THEN** those messages are labelled with the owner label, claims about them anchor to the owner identity, and the sender does not appear in the unresolved or push-name stamps

#### Scenario: Picker shows the number's current identity
- **WHEN** the user types digits matching an archived identity that currently resolves to another person's name
- **THEN** the suggestion shows that name and the identity's message count, and after adding, the saved entry continues to show that prior label as a warning

#### Scenario: Invalid self input is rejected
- **WHEN** the user submits a value that is not phone-shaped (8–15 digits) and not an archived identity JID
- **THEN** the entry is rejected client- and server-side with a stated reason and the stored list is unchanged

#### Scenario: Version bump makes precedence retroactive via regeneration
- **WHEN** self identities are configured after episodes were committed under the previous extraction version
- **THEN** those episodes are selectable by the regeneration path and a regenerated episode renders the self number with the owner label
