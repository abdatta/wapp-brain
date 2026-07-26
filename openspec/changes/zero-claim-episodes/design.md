## Context

After `well-formed-prompt-truncation` cleared every provider-side failure class, one cause remained on the live archive: 67 current episodes, all `The episode contains no claims`, all fragments of busy chats, sizes from 1 to 11 messages. Sampling their content settles what they are — a lone `"😂"`, a lone `"Hello 😇"`, a lone `"Ki khobor?"`. The model was right every time.

The tempting fix — skip the model for small packs — is refuted by the same archive. **2,083 packs under 5 messages produced valid model episodes, averaging 1.97 claims each.** A one-message `"I'll be there at 6"` is a commitment; a one-message `"😂"` is nothing. Size does not predict claimlessness; only content does, and the model is the only available judge. So the pipeline must keep asking, and must accept the answer when it comes back empty.

The obstacle is that an empty claims array is currently ambiguous between deliberate judgment and three malformation paths, one of which (`claims: ["text"]` filtered to nothing by normalization) leaves no trace at all. That ambiguity is why "just accept empty" would be unsafe, and it shapes the whole design.

## Goals / Non-Goals

**Goals:**

- A window with nothing durable in it produces an honest, terminal episode instead of a placeholder.
- The 67 stuck episodes clear permanently, and the sweep stops re-attempting them.
- No retry ever tells a model its correct "nothing here" answer was wrong.
- A deliberate empty answer is distinguishable from a malformed one, in the data.
- The rate at which the escape hatch is used is measurable per model.

**Non-Goals:**

- Changing pack construction or granularity — explicitly deferred pending measurement.
- Grading whether a declaration was truthful; that is the census's job in `claim-groundedness-signal`.
- Relaxing citation rules for claims that *are* present. Every claim still cites, unchanged.
- Reducing model calls on small packs by skipping generation — refuted above.

## Decisions

**A stated reason, not a boolean.** `no_durable_claims: true` costs the model one token and is therefore the cheapest possible way to finish early. A short phrase ("single laughing reaction, no content") raises that cost, and — more importantly — makes the assertion auditable: a human or a grader can read it against the evidence and judge whether it is true. A boolean is unfalsifiable; a reason is a proposition. *Alternative considered:* a boolean plus a separate lint on pack size. Rejected — it infers intent from a heuristic instead of asking, and leaves nothing for a grader to check.

**Asymmetric acceptance is the mechanism, not a detail.** Empty-with-reason commits; empty-without-reason stays a collected validation error with the existing single retry. This is what closes malformation path 3: a response that emitted strings instead of claim objects will not also carry a coherent stated reason for emptiness, so it still fails and still retries. Accepting bare emptiness would silently convert every malformed response into a "nothing here" episode — strictly worse than today, because today they at least surface as fallbacks.

**Terminal, and a model episode.** The result is `generator: "model"` with an empty claim set. It is not a fallback: nothing failed. This matters beyond bookkeeping — extractive episodes are excluded from consolidation and from prior-episode continuity context, and are perpetually re-swept. A claimless model episode participates normally and is never revisited, which is the property that makes the backlog actually clear.

**Prompt licenses the empty answer explicitly.** The instruction must say that returning no claims is a legitimate outcome for a window of greetings, reactions, or small talk, and that inventing a claim to fill the array is not. Today's retry says the opposite of this, and the prompt is silent — between them they create the fabrication pressure. Fixing validation without fixing the prompt would leave the model still trying to satisfy a rule it no longer needs to.

**Measure the escape hatch from day one.** Adding a legitimate way to finish early can make a model lazier, and that failure mode is invisible without a denominator. The declaration rate per model stamp goes into the existing per-model aggregates next to fallback and issue rates. If the rate climbs, that is a number, not a hunch. *This is a mitigation, not a solution* — the real check is grading a sample of declarations for truthfulness, which the census will do.

**Bump `EXTRACTION_VERSION`.** The contract's shape changes, so every existing episode was produced under different terms. This is precisely the signal that constant exists to carry, and it routes re-derivation through the Run console path that already exists. Contrast with the truncation fix, where bumping would have falsely claimed a contract change for what was a rendering bug.

## Risks / Trade-offs

- **The model over-uses the declaration** → Rate tracked per model from day one; declarations become gradeable by the census; the reason string makes lazy use legible to a reader. If it degrades, the retry path can be restored for declarations on packs above a size threshold.
- **Downstream code assumes every episode has ≥1 claim** → Audit rollups, graph building, and lifecycle before landing. A claimless episode must read as ordinary, not as an error or an empty-state bug. This is the most likely source of a real regression.
- **A claimless episode is thin retrieval material** → It is still honest, still carries a summary and citations-free context, and still advances the watermark. The alternative on offer is an extractive placeholder, which is strictly worse on every axis.
- **Re-derivation churns the whole archive** → Accepted and intended; episodes are a pure projection and the owner has confirmed re-running is fine. Worth doing before the groundedness census so the census grades final episodes.
- **The declaration could be gamed by a terse reason** ("nothing") → Acceptable initially; the census will surface it. Do not attempt to police reason quality with a heuristic — that recreates the anchoring-lint mistake of judging language mechanically.

## Migration Plan

1. Land the contract change: prompt, normalization, validation, retry, and the declaration's persistence.
2. Audit and fix downstream assumptions about non-empty claim sets.
3. Bump `EXTRACTION_VERSION`; every current episode becomes regenerable.
4. Re-derive through the Run console. Expect the 67 to resolve into claimless model episodes and the extractive backlog to reach zero for the first time.
5. Read the declaration rate per model; it is the baseline for every later comparison.

Rollback is reverting the constant and the commit; episodes remain re-derivable in both directions.

## Open Questions

- Should the declaration be a distinct top-level field, or a reserved claim kind? A top-level field keeps the claim vocabulary clean and avoids a "claim" that cites nothing, which is why it is the default here — but a reserved kind would flow through existing storage untouched.
- Should a declaration on a large pack (say ≥50 messages) be flagged as an `info` observation for review? It is cheap and targets the laziness risk precisely, but it is also a heuristic about a threshold nobody has measured yet.
- Does an empty claim set need an explicit marker in storage, or is `claims.length === 0` plus the recorded reason sufficient for downstream consumers to branch on?
