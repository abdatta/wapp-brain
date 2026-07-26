## 1. Contract and prompt

- [ ] 1.1 Add the no-durable-claims declaration to the contract shape in the episode prompt, with a short stated reason as its payload
- [ ] 1.2 State in the prompt that returning no claims is legitimate for a window of greetings, reactions, or small talk, and that inventing a claim to fill the array is not — today the prompt is silent and the retry says the opposite
- [ ] 1.3 Decide the declaration's representation (top-level field vs reserved claim kind) and record the choice in the design's open questions

## 2. Normalization and validation

- [ ] 2.1 Carry the declaration through `normalizeModelEpisode` without mechanical salvage inventing one
- [ ] 2.2 In `validateModelEpisode`, accept an empty claims array WITH a declaration as valid; keep an empty array WITHOUT one as the existing collected error
- [ ] 2.3 Verify the malformation paths still fail: missing claims field, `claims: null`, `claims: "text"`, and `claims: ["text"]` (entries filtered to nothing by normalization) must all remain retryable errors, never a silent declaration
- [ ] 2.4 Stop the retry when the response is a valid declaration — it is a correct answer, not a failure
- [ ] 2.5 Unit-test each acceptance and rejection path above

## 3. Commit path

- [ ] 3.1 Commit a declared-empty episode as `generator: "model"` with its summary, no claims, and no `fallback_reason`
- [ ] 3.2 Persist the stated reason so it can be read against the evidence later
- [ ] 3.3 Confirm such an episode is excluded from the extractive backlog and from sweep selection
- [ ] 3.4 Confirm it remains eligible as prior-episode continuity context for the next episode in its chat

## 4. Downstream audit (most likely source of regression)

- [ ] 4.1 Audit rollups for assumptions that an episode has ≥1 claim; make an empty set contribute nothing rather than erroring or short-circuiting
- [ ] 4.2 Audit graph building and lifecycle for the same assumption
- [ ] 4.3 Audit episode projection and any retrieval/query surface that renders claims
- [ ] 4.4 Add a test that a claimless episode flows through consolidation, graph, and projection without error

## 5. Measurement

- [ ] 5.1 Record the declaration per episode so it is queryable per model stamp and extraction version
- [ ] 5.2 Add the declaration rate with its denominator to per-model quality aggregates, beside the fallback and issue rates
- [ ] 5.3 Render it on the quality surface with its sample size

## 6. Version bump and re-derivation

- [ ] 6.1 Bump `EXTRACTION_VERSION` — the contract's terms genuinely changed
- [ ] 6.2 Re-derive through the Run console's Regenerate path
- [ ] 6.3 Confirm the 67 previously-stuck episodes resolve into claimless model episodes
- [ ] 6.4 Confirm the extractive backlog reaches zero, and that a subsequent sweep finds nothing to do — the property that was never true before
- [ ] 6.5 Record the baseline declaration rate per model for later comparison

## 7. Close out

- [ ] 7.1 Run the full test suite green
- [ ] 7.2 Sync the delta specs into `openspec/specs/` and reconcile the roadmap board
