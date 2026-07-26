## Why

The extraction contract requires every episode to carry at least one claim. Real conversations do not cooperate: a window containing a single `"😂"`, `"Hello 😇"`, or `"Ki khobor?"` has nothing durable in it. The model recognises this and returns an empty claims array — the correct answer — and the pipeline treats it as a validation failure.

What follows is worse than a wasted call. The retry hands the model its own correct answer back as an error (*"The episode contains no claims. Fix every one of them and answer again"*), which is fabrication pressure applied precisely where there is no evidence to ground a claim. Then an extractive placeholder commits, counts against the fallback-rate quality canary, and joins the sweep backlog — where every future sweep re-attempts it, gets the same correct answer, and re-commits the placeholder. Measured on the live archive after the truncation fix cleared every other failure class: **67 episodes**, permanently stuck, costing **134 model calls per sweep, forever**.

An empty claims array is also ambiguous today, in a way that makes simply accepting it unsafe. Three distinct paths produce one:

1. the model deliberately returned `claims: []`
2. the field was missing, null, or the wrong type, and was coerced to `[]`
3. the model returned `claims: ["some text"]` — strings rather than objects — and `normalizeModelEpisode` silently filtered every entry away

Path 3 is a malformed response that is indistinguishable from a considered judgment. So the fix is not "accept empty claims"; it is to make the model *assert* emptiness, and accept only the assertion.

## What Changes

- The contract gains an explicit **no-durable-claims declaration**: when a window holds nothing durable, the model returns an empty claims array *together with* a short stated reason for it. The prompt licenses this outcome directly and instructs the model never to invent a claim to fill the array.
- Acceptance becomes asymmetric, which is what closes path 3:
  - empty claims **with** a declaration → a valid model episode with a summary and no claims; committed, terminal, **no retry**
  - empty claims **without** a declaration → a collected validation error and the single retry, exactly as today
- Such an episode is `generator: "model"`. It is not a fallback, does not enter the fallback-rate canary, and is never re-swept — so the backlog actually clears.
- The declaration is recorded so its rate is queryable per model, because an explicit "nothing here" option is also an easy way for a model to finish early. A rising rate must be visible as a number rather than inferred.
- `EXTRACTION_VERSION` is bumped. Unlike the truncation fix, the extraction contract genuinely changes here, which is exactly what that signal is for.

## Capabilities

### New Capabilities

None. This changes the terms of an existing contract.

### Modified Capabilities

- `brain-assimilation`: the extraction contract admits a claimless episode when the model explicitly declares the window holds nothing durable; that declaration is terminal rather than retryable, and produces a model episode rather than an extractive fallback.
- `brain-evaluation`: per-model quality aggregates report the no-durable-claims declaration rate alongside the existing fallback and issue rates, so the escape hatch is measured.

## Impact

- `src/server/brain/episodes.ts` — `EPISODE_SYSTEM` and the prompt contract shape, `normalizeModelEpisode`, `validateModelEpisode`, the retry loop in `generateEpisodeForPack`, and `EXTRACTION_VERSION`.
- `src/server/db/sqliteRepository.ts` — persisting the declaration and including it in per-model aggregates.
- Re-derivation: the version bump makes every current episode regenerable through the existing Run console path. The 67 stuck episodes resolve into model episodes; the rest re-derive under the new contract.
- Downstream consumers that assume every episode has ≥1 claim need checking — rollups, the graph builder, and lifecycle all read claims and must treat an empty set as ordinary rather than exceptional.
- Bounded model spend for the re-derivation, under the existing ledger caps.

## Out Of Scope

- Episode packing granularity (why 47% of episodes hold ≤11 messages, 750 of them exactly at the split threshold). Small packs are productive — those under 5 messages average 1.97 claims — so there is no evidence yet that granularity is a defect. It stays a measurement question for the groundedness census, which will report precision bucketed by pack size.
- Grading the declarations themselves. The declaration makes recall gradeable for the first time, but the grading pass belongs to `claim-groundedness-signal`.
