## Why

Prompt builders truncate archive text with `String.prototype.slice`, which counts UTF-16 code units. When a cut lands inside an astral character's surrogate pair it leaves a lone surrogate (e.g. `U+D83D`); `JSON.stringify` emits a bare `\ud83d`, and the codex provider's strict UTF-8 validation rejects the request with `400 {"detail":"Bad Request"}`. This is deterministic, not transient: every one of the 38 windows that has ever 400'd fails on every retry, all 38 built prompts contain a lone surrogate, and 0 of 60 successful control windows do. Verified by single-variable isolation against the live endpoint — the same prompt with lone surrogates stripped returns 200, a minimal prompt plus one bare `\ud83d` returns 400, and a minimal prompt plus a well-formed pair returns 200.

The operational cost is that fallback sweeps no longer finish. Each poisoned pack burns **two** consecutive provider failures (the generation retry re-sends identical malformed text), so five poisoned packs reach the 10-failure degradation threshold exactly. As healthy episodes drain, poison density rises — 37 of the 133 remaining extractive episodes — so every sweep now halts within a handful of packs. Raising the threshold from 3 to 10 could not help and did not.

## What Changes

- Truncation of archive-derived text bound for a prompt becomes **grapheme-cluster safe** (`Intl.Segmenter`), not merely code-point safe: code-point slicing still splits ZWJ emoji sequences and Indic grapheme clusters, which matters on this predominantly Bengali/Hindi/Hinglish archive. The three prompt-path sites are the quoted-reply snippet (80), the link-preview/transcript bound (160/320), and the out-of-pack quoted referent snippet (80).
- The model-provider boundary gains a **well-formedness guard**: no request leaves the process carrying an unpaired surrogate, regardless of which builder produced the text. This is the backstop that makes the class of defect unrepresentable rather than fixed at three call sites.
- A provider rejection that is **deterministic in the request** (HTTP 400-class) stops burning a retry on byte-identical input and stops counting toward the consecutive-failure latch as if it were an outage. A pack that a provider will never accept is quarantined with a recorded reason; the run continues instead of halting the whole queue.
- Repair pass: the 38 extractive episodes stuck in the 400 loop, plus the 2 model episodes committed from a malformed prompt, are re-derived once the fix lands.

Not in scope: the `unanchored` lint's false-positive rate and the dashboard's quality-flag aggregation — separate change.

## Capabilities

### New Capabilities

None. This corrects behavior inside two existing capabilities.

### Modified Capabilities

- `brain-assimilation`: evidence rendering gains an explicit well-formedness and grapheme-integrity requirement on every bounded/truncated annotation, and deterministic per-pack provider rejections become a quarantine rather than a run-level halt.
- `brain-model-provider`: generation requests are required to be well-formed Unicode at the provider boundary, and provider failures are classified as deterministic-in-request vs. transient so the degradation guard latches only on the latter.

## Impact

- `src/server/brain/episodes.ts` — `boundedSignalText`, the in-pack quoted snippet in `packPromptLines`.
- `src/server/db/sqliteRepository.ts` — the out-of-pack snippet in `resolveQuotedReferents`.
- `src/server/brain/provider.ts` — well-formedness guard and failure classification in `generateStructured` / health tracking.
- `src/server/brain/scheduler.ts`, `src/server/brain/runJob.ts` — quarantine path so a deterministic pack failure does not halt a drain.
- Affected data: 38 extractive episodes awaiting re-derivation; 2 committed model episodes (`claude-sonnet-5`) whose prompt carried a lone surrogate in a quoted-reply snippet. No stored archive text is malformed — 0 lone surrogates across 327k messages — so this is a rendering fix, not a data repair.
- No dependency or API changes. The claude-cli path is unaffected in behavior (stdin encoding silently substitutes `U+FFFD`), but it benefits from the same guard.
