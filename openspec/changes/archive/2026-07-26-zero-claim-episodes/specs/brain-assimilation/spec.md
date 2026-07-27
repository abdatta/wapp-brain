## MODIFIED Requirements

### Requirement: Cited Episode Extraction
Episodic consolidation SHALL produce structured digests conforming to extraction contract v2: `{summary, topics, claims:[{kind, text, cites, entities, event_at?, valid_until?, confidence}]}`, where every claim cites at least one exact source message key present in the evidence pack. A window that holds no durable information SHALL be representable: the model MAY return an empty claims array, and SHALL do so only together with an explicit stated reason for the emptiness. An empty claims array accompanied by that declaration SHALL be a VALID episode — committed with its summary, `generator` model, no claims, and no retry — and SHALL NOT be recorded as an extractive fallback, because nothing failed. An empty claims array WITHOUT the declaration SHALL remain a collected validation error, so that a malformed response (a missing, null, mistyped, or non-object claims payload that normalization reduces to nothing) is never mistaken for a considered judgment. The prompt SHALL state that returning no claims is a legitimate outcome for a window of greetings, reactions, or small talk, and SHALL instruct the model never to invent a claim to fill the array. Model output SHALL be normalized before validation — mechanical salvage of routine deviations (numeric or comma-joined cites, a lone claim object instead of an array, scalar-to-string coercion, missing optional fields defaulted) — so that salvageable responses never consume a retry. Validation SHALL collect ALL errors (missing summary, empty claim text, empty or unknown citations, unknown claim kind, unknown confidence, unparseable dates) into one list; an unknown claim kind SHALL be a retryable validation error, never a silent coercion. A failing revision SHALL be retried exactly once with every collected error enumerated in the retry message; on second failure the task SHALL be recorded as failed with all errors persisted as validation issues and an extractive fallback digest committed instead. The claim count budget SHALL be density-proportional (`min(16, max(4, ceil(messages/25)))`) with overflow truncated and flagged as a warning issue rather than retried; the summary word budget SHALL be density-proportional (`min(200, max(80, ceil(messages × 1.5)))`); the generation output-token budget SHALL scale with the claim budget. A valid episode SHALL commit atomically: episode, claims, citations, claim entities, topic links, commit stamps, and watermark advance in one transaction.

#### Scenario: Valid episode commits atomically
- **WHEN** a generated episode passes citation validation
- **THEN** the episode, claims, citations, claim entities, topic links, late-binding stamps, and watermark advance commit in one transaction

#### Scenario: Declared empty window commits as a model episode
- **WHEN** a window holds nothing durable (for example a single reaction or greeting) and the model returns an empty claims array together with a stated reason
- **THEN** the episode commits with its summary and no claims, is stamped `generator` model, is NOT counted as an extractive fallback, consumes no retry, and is never re-swept

#### Scenario: Undeclared empty claims still fails
- **WHEN** a response yields no claims without a stated reason — including a claims payload that normalization reduced to nothing because its entries were not objects
- **THEN** it is a collected validation error, the single retry applies as for any other validation failure, and a considered declaration is never inferred from a malformed payload

#### Scenario: Hallucinated citation rejected
- **WHEN** a generated claim cites a message key not present in the evidence pack
- **THEN** the revision is rejected, a validation issue is recorded, and coverage proceeds via the extractive fallback after the single retry fails

#### Scenario: Salvageable deviation normalized without a retry
- **WHEN** a model returns numeric cites, a lone claim object instead of an array, or omits optional fields
- **THEN** normalization repairs the payload mechanically, no retry is consumed, and the episode commits as if well-formed

#### Scenario: All errors collected into one retry
- **WHEN** a response contains several validation errors at once (an unknown citation, an empty claim text, an unknown kind)
- **THEN** the single retry message enumerates every error with its claim index, and on second failure all of them are recorded as error-severity validation issues alongside the extractive fallback

#### Scenario: Unknown claim kind is not silently coerced
- **WHEN** a claim arrives with a kind outside the contract vocabulary
- **THEN** it is a collected retryable error, and no claim is committed with a coerced kind

#### Scenario: Claim budget scales with density
- **WHEN** packs of 30 and 150 messages are generated
- **THEN** their prompts state claim budgets of 4 and 6 claims respectively (per the density formula), a response exceeding its budget is truncated to the budget with a warning issue, and the output-token budget scales accordingly

### Requirement: Episode Regeneration
The brain SHALL provide a regeneration path (CLI command, API route, and UI control) that selects current episodes that are extractive-generated or carry a stale extraction version, enqueues durable regeneration tasks (deduped per episode and target version), re-derives evidence packs from each episode's stored chat and time window over the closed interval, commits replacement episodes under the current contract without advancing watermarks, and marks the old episode `superseded` transactionally with the replacement. A window that yields no evidence SHALL still supersede the old episode and record an informational issue. The selection SHALL accept an optional pack-size scope — a maximum message count, inclusive — so re-derivation can target the population a contract change actually affects (thin windows) instead of the whole stale archive; the UI control SHALL preview the scoped selection's size via a spend-nothing dry run before the run starts. An unscoped run SHALL keep selecting every stale episode.

#### Scenario: Stale episode regenerated and superseded
- **WHEN** regeneration runs over an episode with a stale extraction version
- **THEN** replacement episodes for its window commit under the current version, the old episode's status becomes `superseded`, and the chat's watermark is unchanged

#### Scenario: Regeneration is resumable
- **WHEN** a regeneration run is interrupted mid-drain
- **THEN** completed replacements are not re-done (dedupe keys) and the remaining tasks execute on the next run

#### Scenario: Extractive placeholder upgraded
- **WHEN** regeneration runs with a model provider available over an extractive episode
- **THEN** the replacement is model-generated and the placeholder is superseded

#### Scenario: Pack-size scope narrows the selection
- **WHEN** a regeneration run is started with a maximum message count of 5
- **THEN** only stale episodes whose window holds at most 5 messages are selected and enqueued, the count shown before starting reflects that scope, and larger stale episodes remain regenerable later

## ADDED Requirements

### Requirement: Claimless Episodes Are Ordinary Downstream
A committed episode with an empty claim set SHALL be treated as ordinary by every consumer of episodes — consolidation, graph building, lifecycle, projection, and retrieval — rather than as an error, an empty state, or a placeholder. It SHALL remain eligible to serve as prior-episode continuity context, since it is model-generated and its summary is trustworthy. It SHALL NOT be selected for regeneration on the grounds of having no claims.

#### Scenario: A claimless episode is not re-swept
- **WHEN** a fallback sweep or regeneration pass selects work
- **THEN** an episode that committed with a declared empty claim set is not selected, and the extractive backlog does not include it

#### Scenario: Downstream consumers handle an empty claim set
- **WHEN** rollups, graph building, or lifecycle processing encounter an episode with no claims
- **THEN** each proceeds normally, contributing nothing from that episode rather than erroring or skipping the surrounding work

#### Scenario: A claimless episode still provides continuity
- **WHEN** the next episode in that chat is generated and looks up prior-episode context
- **THEN** a claimless model episode's summary is eligible as that context, exactly as any other model episode
