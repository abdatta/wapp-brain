## Context

Three prompt-path truncations slice archive text by UTF-16 code unit:

| Site | Bound | Malformed cuts observed | Population |
|---|---|---|---|
| `resolveQuotedReferents` / `packPromptLines` quoted snippet | 80 | 40 | 36,338 replies |
| `boundedSignalText` (link preview) | 160 | 7 | 3,500 previews |
| `boundedSignalText` (transcript) | 320 | 0 | 339 |

Plus 12 cuts that are well-formed UTF-8 but split a grapheme cluster (half an emoji, an orphaned Devanagari matra).

Two structural facts bound the blast radius and shape the fix. **Primary message text is never truncated** — `packPromptLines` renders `message.text` in full, and `buildEvidencePacks` *splits* oversized windows into multiple packs rather than dropping messages (0 episodes exceed the 150-message cap; the busiest 7-day window is 1,697 against a 10,000 selection cap). So only *annotations* — quoted-reply snippets, link previews, transcripts — can ever be damaged, and annotations are explicitly non-citable context. And **the stored archive is clean**: 0 lone surrogates across 327k messages, 3 replacement characters and 2 mojibake values across 291,745 message values. Nothing needs repairing at rest; this is purely a rendering defect.

The two providers fail differently on the same malformed prompt. Codex serializes the prompt into a JSON body, so a lone surrogate becomes a literal `\ud83d` escape and the backend rejects it — the failure is loud and the episode falls back to extractive. The claude-cli path writes the prompt to stdin, where Node's UTF-8 encoding silently substitutes `U+FFFD`; the call succeeds and the episode commits with a corrupted character. Two such episodes exist today. Loud-and-blocked is the better failure mode, but neither is acceptable.

## Goals / Non-Goals

**Goals:**

- No request carrying malformed Unicode can leave the process, whichever builder produced the text.
- Truncation preserves grapheme integrity, so a bounded annotation reads as truncated text rather than as mojibake.
- A pack the provider will deterministically reject stops taking the whole run down with it.
- The 38 stuck extractive episodes and 2 corrupted model episodes are re-derived.

**Non-Goals:**

- Repairing stored archive text. It is already well-formed; adding a normalization pass over `messages` would be work against a clean population.
- Changing what gets truncated or the bounds themselves. The 80/160/320 limits are a deliberate context budget; only *where* the cut lands changes.
- Reworking the `unanchored` lint or the dashboard's quality-flag aggregation — separate change, separate risk.
- Multimodal or transcript-content changes.

## Decisions

**Grapheme clusters, not code points.** `Intl.Segmenter` with `granularity: "grapheme"` is available on the Node baseline and is the only correct unit here. The cheaper `[...str].slice(0, n)` fixes lone surrogates but still splits ZWJ emoji sequences and Indic clusters — and on an archive that is predominantly Bengali/Hindi/Hinglish, an orphaned matra is exactly the kind of quiet garbling this change exists to remove. *Alternative considered:* code-point slicing alone, rejected as a half-fix that leaves 12 known-damaged annotations and would need revisiting. *Alternative considered:* a regex on surrogate pairs, rejected as re-implementing a solved problem worse.

**One shared helper, three call sites.** The three truncations become one exported helper taking `(text, limit, marker)`. Bounds stay per-site. This keeps the fix reviewable and gives the spec a single named behavior to require.

**A guard at the provider boundary, not only at the builders.** `generateStructured` normalizes with `String.prototype.toWellFormed()` before dispatch. Fixing three call sites fixes today's defect; the guard makes the class unrepresentable, which matters because rollup, lifecycle, and any future prompt builder reach the same seam. Node 20+ provides `toWellFormed`; the cost is one pass over a prompt already being serialized. *Alternative considered:* throwing on malformed input instead of substituting. Rejected — a lone surrogate is a rendering bug, not a reason to refuse an otherwise-valid episode, and the builders will be correct anyway. It is worth logging when the guard actually fires, since after this change that should be never.

**Classify deterministic rejections separately from outages.** The degradation guard exists to stop a run when the provider is *gone*. A 400-class rejection means the provider is healthy and refusing *this request*, which is the opposite signal — the current design reads it as an outage, retries identical bytes, and counts both attempts toward the latch. So: a 400-class failure skips the retry (byte-identical input cannot succeed), does not increment the consecutive-failure counter, and quarantines the pack with its reason recorded. The run continues. *Alternative considered:* leaving retry/latch behavior alone on the theory that the truncation fix removes the trigger. Rejected — the trigger was one instance of a general shape, and the failure mode it produces (a full run halted by a handful of bad packs, with a message blaming a provider outage) is severe and will recur with the next content-dependent rejection.

**Re-derive rather than patch.** The 38 + 2 affected episodes are regenerated through the existing sweep, not edited in place. Episodes are a pure projection; regeneration is the sanctioned repair path and re-validates the whole episode rather than a character.

**Repair scope stays small because the damage is small.** With re-derivation now cheap, a wider sweep is affordable — but it would not buy anything. Only 50 current episodes ever saw a damaged annotation, and an annotation that was never cut mid-cluster renders byte-identically before and after the fix. Re-deriving the archive to change nothing is spend without a result. The exception worth taking is the 9 split-cluster episodes: they are cheap, and their annotations genuinely improve.

**Prefer strict sweeps now that placeholders are avoidable.** `generateEpisodeForPack` already supports a strict mode that refuses to commit an extractive placeholder and leaves the watermark unchanged. Placeholders existed as a hedge against expensive re-runs — coverage now rather than nothing. That trade-off has inverted: re-running is cheap, so a pack that cannot be generated should stay pending rather than commit a degraded episode that pollutes coverage and needs sweeping later. Combined with per-pack quarantine, this removes the placeholder-then-sweep cycle that produced the poisoned backlog in the first place. Left as a task to evaluate rather than a silent default, because it changes what a run's coverage number means. *Alternative considered:* keep committing placeholders and rely on the sweep. Rejected — the sweep is exactly the loop this change exists to unblock.

## Risks / Trade-offs

- **`Intl.Segmenter` is slower than `slice`** → It runs on at most a few hundred short annotations per pack, against a network call measured in seconds. Bound the segmentation to the first `limit + small margin` characters rather than the full string so cost is independent of input length.
- **`toWellFormed` requires Node 20+** → Already the project baseline; if it must run lower, a small polyfill covers it. Verify at the same time as the guard lands.
- **Substituting `U+FFFD` at the boundary could mask a future builder bug** → Log every occurrence with the call's purpose. After this change the correct rate is zero, so a non-zero rate is itself the alarm.
- **Quarantining packs could hide a real, widespread provider problem behind "a few bad packs"** → Quarantine is per-pack and recorded; a run that quarantines above a threshold should still end in a named, visible state rather than reporting success.
- **Regenerating the 2 corrupted episodes changes committed summaries** → They are corrupt in a single character inside non-citable context, so the practical delta is near zero; regeneration is still correct and cheap at this volume.

## Migration Plan

1. Land the helper, the three call sites, and the provider guard together; unit-test with a pack whose annotation ends mid-pair.
2. Verify against the isolated environment (copied archive, scratch work dir, live codex session) that a previously-400ing window now returns 200 and commits a model episode.
3. Run the fallback sweep. Expect it to drain past the point where it has been halting, since the poison set is the thing that was halting it.
4. Confirm the 2 `claude-sonnet-5` episodes are re-derived and the extractive backlog falls to 0.

Rollback is reverting the commit; no schema or data migration is involved, and episodes remain re-derivable either way.

## Open Questions

- Should a quarantined pack be retryable on a later run (content could change via edits or a later regeneration), or stay quarantined until the extraction version bumps? Leaning retryable-on-next-run, since the quarantine reason is recorded and a repeat costs one call.
- Should the guard's firing count surface in provider status, or is a log line plus the eventual audit surface (`llm-call-audit`, #24) enough?
