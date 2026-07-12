# Evidence Pack Fidelity

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The evidence pack is the model's entire world during extraction; anything missing or ambiguous there is baked into episodes forever. Today packs drop reactions entirely (though the spec promises them as annotations — and in real WhatsApp, "👍" and "done ✅" are how commitments get acknowledged), render quoted replies without their referent, attribute forwarded content to the forwarder, label unresolved senders as literally `Unknown` (making two unresolved participants indistinguishable and claims permanently vague), and let quiet chats produce single "episodes" spanning months or years because nothing bounds a pack's time span. All of these must be fixed before the final extraction contract lands and the real assimilation spend begins.

## What Changes

- **Reaction annotations**: reactions render inline on their target evidence line (`m12 | … | Rohit: I'll send it tomorrow  [👍 Abhishek]`), citing through the target message, never consuming their own budget line — implementing the spec scenario that is currently unimplemented, and providing the closure evidence the future commitment lifecycle depends on.
- **Quoted-reply stitching**: a reply line carries a compact referent (`↳ replying to m7 (Rohit): "first 80 chars…"`), resolved to the quoted message's alias when it is in the pack, or an inline non-citable snippet when it is not.
- **Forwarded attribution**: forwarded messages are labelled (`Rohit (forwarded):`) with a prompt rule to attribute as "shared/forwarded", never "said" — if the archive captures the forwarded flag; if it does not, capture lands here.
- **Unresolved senders labelled by number, never "Unknown"**: evidence lines for senders without a display name carry the E.164 number verbatim, with a prompt rule to refer to them exactly by that number — making claims attributable, multiple unresolved senders distinguishable, and prose deterministically repairable when the name arrives later.
- **Same-name collision suffixes**: when two participants in one pack share a display name, both labels get a deterministic disambiguator (`Rohit (+91 98…)` / `Rohit (+91 99…)`) and the prompt instructs using exactly the labels shown.
- **Max episode span**: `WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS` (default 7) enforced inside `buildEvidencePacks` — the tiny-sitting glue-forward and the greedy merge both refuse to cross the span cap, so quiet-chat first assimilation produces week-bounded episodes instead of multi-year ones.
- **Checkpoint**: assimilate one real group chat containing reactions, replies, a forward, and an unresolved number — the projected episode shows reaction acknowledgments, reply context, correct attribution, number-labelled claims; a quiet chat's backlog produces multiple week-bounded episodes.

## Capabilities

### Modified Capabilities

- `brain-assimilation`: Evidence Selection Policy extended — reaction annotations on target lines, quoted-referent stitching, forwarded attribution, number-labelling of unresolved senders, pack-local label collision disambiguation, and a hard episode span bound independent of the scheduler.

## Impact

- **Code**: `src/server/brain/episodes.ts` (pack builder, prompt lines), `src/server/db/sqliteRepository.ts` (evidence query gains reactions/quote-referents/forward flags), possibly `src/server/live/normalize.ts` + importer if the forwarded flag is not yet captured.
- **Config**: `WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS`.
- **Tests**: reaction annotation rendering, in-pack and out-of-pack quote referents, forward labelling, collision suffixes, span-bounded packs for a quiet chat.
- **No schema wipe**: additive evidence-query changes only; episodes produced before this change are regenerated later under `episode-contract-v2`'s reset anyway.
