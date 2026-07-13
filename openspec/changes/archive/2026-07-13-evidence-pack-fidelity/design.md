## Context

The evidence pack is the model's entire world during episodic extraction. `buildEvidencePacks` (in `src/server/brain/episodes.ts`) segments a chat's unassimilated window into packs; `packPromptLines` renders each pack message as one budget-consuming line prefixed with a citation alias (`m1`, `m2`, …), and `validateModelEpisode` rejects any claim citing an alias not in the pack. That alias↔message map is the system's integrity spine: a claim is trustworthy only because it points at a message the model was actually shown.

Five fidelity gaps sit inside that spine today:

1. **Reactions are dropped.** `isEvidenceMessage` excludes `message_type = 'reaction'`, and the pack builder never consults `live_message_updates` (`update_type = 'reaction'`). The existing spec's "Noise excluded from evidence" scenario already *promises* reactions "still appear as annotations on their target messages" — but nothing implements it. In real WhatsApp a "👍" or "done ✅" is how a commitment gets acknowledged; that closure signal is invisible to extraction.
2. **Quoted replies lose their referent.** `quoted_source_message_id` is populated on the row but never rendered, so a reply reads as a naked line with no anchor to what it answers.
3. **Forwarded content is mis-attributed.** `is_forwarded` exists on the row but is unused, so the model reads a forward as something the forwarder *said*.
4. **Unresolved senders collapse to `"Unknown"`.** `senderLabel` returns the literal string `"Unknown"` for any sender lacking a display name, so two distinct unresolved participants are indistinguishable and every claim about them is permanently vague and unrepairable.
5. **Nothing bounds a pack's time span.** Segmentation splits only on a 90-minute silence gap or the size cap. A quiet chat with a year of sparse messages and no long gap produces a single "episode" spanning that entire year.

The archive already captures the raw material for all five: `is_forwarded` and `quoted_source_message_id` are columns on `messages`; reactions are stored (imported reaction rows and/or `live_message_updates` reaction events with `{emoji, reactorJid}` metadata keyed by target `source_message_key`); `sender_source_jid` and `contacts.phone_number` carry the number. This change is almost entirely a **read-path** change — the evidence query and the pack/prompt builder — plus a config knob and (only if an audit finds a capture gap) importer work.

**Constraints:** No schema wipe (Roadmap standing sanction still allows one, but nothing here needs it). This change gates `episode-contract-v2` (#3) and `commitment-lifecycle` (#10), so the evidence rendering it defines must be the shape those later contracts inherit. Recommended model: Opus.

## Goals / Non-Goals

**Goals:**

- Render reactions as inline, non-citable annotations on their target evidence line, citing *through* the target, never consuming a budget line of their own.
- Stitch each quoted reply to a compact referent — the in-pack alias when the quoted message is in the pack, an inline non-citable snippet when it is not.
- Label forwarded messages distinctly and instruct the model to attribute them as "shared/forwarded", never "said".
- Replace the literal `"Unknown"` sender label with the sender's verbatim number, making unresolved participants distinguishable, claims attributable, and generated prose deterministically repairable when a name arrives later.
- Disambiguate two pack participants who share a display name with a deterministic, per-pack suffix.
- Enforce a hard maximum episode span (`WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS`, default 7) inside `buildEvidencePacks`, independent of the scheduler, so quiet-chat first assimilation produces week-bounded episodes.
- Preserve the citation-integrity invariant exactly: only real, in-pack messages get aliases; every annotation (reaction, out-of-pack referent) is non-citable.

**Non-Goals:**

- No change to the citation validation model, the commit transaction, or the extractive-fallback contract beyond passing the new labels/annotations through them.
- No commitment lifecycle logic — this change only makes the *evidence* (reaction acknowledgments) visible; closure detection is `commitment-lifecycle` (#10).
- No late-binding repair machinery — this change produces the substitutable number token and stamps nothing; the actual repair sweep is `identity-late-resolution` (#4). We only guarantee the token is deterministic and substitutable.
- No new episode schema fields, no versioning/coverage stamps — those belong to `episode-contract-v2` (#3).
- No two-source reaction reconciliation beyond what an audit shows is actually present.

## Decisions

### D1 — Reactions ride on the target message, never as pack messages

Reactions are attached to their target `MemoryEvidenceMessage` as a `reactions: Array<{ emoji, reactorLabel }>` field and rendered as a trailing annotation on the target's prompt line:

```
m12 | 2026-07-04 14:03 | Rohit: I'll send the deck tomorrow  [👍 Abhishek] [✅ Priya]
```

They are **never** appended to `pack.messages`, never assigned an alias, and never counted against `maxMessages`. A claim that a message was acknowledged cites the *target* alias (`m12`); the reaction is context that colours that citation. This is the only design that keeps the alias↔message invariant intact.

- **Why not give reactions their own alias?** It inflates the budget, lets a claim cite a reaction directly instead of the message it acknowledges (weakening exactly the closure signal we want), and forces reactor identity into the citation space.
- **Sourcing:** the evidence query gathers reactions targeting each pack message. Live reactions are in `live_message_updates` (`update_type = 'reaction'`, `source_message_key` = target, `metadata_json.emoji` / `.reactorJid`). Imported reactions may also exist as `message_type = 'reaction'` message rows — **Task 1 audits which sources are actually populated** and the query unions whatever exists. Reactor JIDs resolve to display names through the same identity path as senders (and to the number label under D3 when unresolved).
- **Per-line cap:** at most `N` reactions render per target line (default 8, newest first) to bound a viral message's annotation; the count is noted if truncated (`[👍 ×12]`-style aggregation for repeated emoji). Exact aggregation format decided in implementation.

### D2 — Quoted-reply referent resolves at prompt-assembly time

`packPromptLines` is where aliases are assigned, so referent resolution happens there. Each evidence message carries its `quotedSourceMessageId`. When assembling lines:

- Build the alias map first (as today).
- For a message with a quoted ref whose target **is in the pack**, prepend a citable referent using the target's alias:
  `↳ replying to m7 (Rohit): "first 80 chars…"`
- For a quoted ref **not in the pack**, fetch a bounded snippet (sender label + first 80 chars of the quoted body) via a new repository lookup keyed by `(chatSourceId, quotedSourceMessageId)`, and render it **without an alias** so the model cannot cite it:
  `↳ replying to (Rohit): "first 80 chars…"`

The referent is one prefixed sub-line on the replying message's entry, not its own budget line. If the out-of-pack quoted message can't be found (pruned/never archived), render `↳ replying to an earlier message` with no snippet — honest and still non-citable.

- **Why resolve at assembly, not in SQL?** In-pack-vs-out-of-pack is only knowable once the pack's message set is fixed, which is a builder concern, not a query concern. The out-of-pack snippet is the only extra DB read, and it's a single indexed lookup per unresolved reply.

### D3 — Number label replaces `"Unknown"`; self stays `(me)`

`senderLabel` changes from returning `"Unknown"` to returning a deterministic **number label** derived from `sender_source_jid` (strip `@s.whatsapp.net` / `@lid`, format as `+<cc> <national>` best-effort, else the raw digits). The prompt gains a rule: *refer to a participant shown as a number by exactly that number string.*

- This makes two unresolved senders distinguishable (different numbers), every claim attributable (the number is the subject), and the prose deterministically repairable later: `identity-late-resolution` can find-and-replace the exact number token once a name binds. The number is the substitutable anchor.
- `extractiveEpisode`'s `"Someone"` fallback is replaced by the same number label for consistency.
- Truly JID-less rows (should be near-impossible for a real message) fall back to a stable `participant-<shorthash>` so the label is still distinct and substitutable, never the ambiguous `"Unknown"`.
- **Trade-off:** raw numbers land in prompts and projected episode markdown until a name binds. Accepted — this is a private, local brain; `episode-contract-v2` regenerates these episodes anyway, and the number is precisely what makes repair deterministic.

### D4 — Same-name collision suffixes are computed per pack

At label-assembly time, group the pack's distinct sender JIDs by resolved display name. When one display name maps to more than one JID, every colliding label gets a deterministic disambiguator built from that JID's number — a suffix long enough to distinguish (`Rohit (+91 98…)` / `Rohit (+91 99…)`), extended until the colliding labels differ. The prompt rule instructs the model to use exactly the labels shown. Non-colliding names are untouched.

- **Why per-pack, not global?** The collision only matters inside the one window the model sees; a global disambiguator would clutter the common case where a name is unique in its chat. Per-pack keeps labels clean and the rule local to the evidence the model reads.

### D5 — Episode span cap enforced in both segmentation and merge

Add `config.brain.maxEpisodeSpanDays` (from `WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS`, default 7) → `maxEpisodeSpanMs`. Enforce in `buildEvidencePacks` in two places:

- **Segmentation loop:** start a new segment when appending the next message would make `nextTs - segmentStartTs >= maxEpisodeSpanMs`, in addition to the existing size-cap and silence-gap conditions.
- **Greedy merge:** refuse to merge two adjacent segments when the merged span (`lastTsOf(b) - firstTsOf(a)`) would exceed the cap.

The cap is independent of the scheduler's significance/volume gates: even a chat folded into a "weekly mini-episode" by the scheduler still produces span-bounded packs here. A dense burst genuinely spanning more than the cap splits mid-run; that's the intended bound.

- **Why inside `buildEvidencePacks`?** It's the single choke point every assimilation path (nightly, weekly, catch-up, backfill) flows through, so the bound holds everywhere without touching the scheduler.

### D6 — Citation integrity is the invariant everything else preserves

The one rule that must not break: **an alias exists if and only if it maps to a real message in `pack.messages`.** Reactions (D1) and out-of-pack referents (D2) are rendered text with no alias. `validateModelEpisode` is unchanged and continues to reject any claim citing an unknown alias — the annotations simply can't be cited, by construction.

## Risks / Trade-offs

- **Reaction source ambiguity (import vs live)** → Task 1 audits both `message_type='reaction'` rows and `live_message_updates` before the query is written; the query unions whatever is populated. If only one source exists, the other is a no-op join.
- **Forwarded / quoted-ref capture gaps in the importer** → Task 1 also verifies the importer populates `is_forwarded` and `quoted_source_message_id` (not just live sync). If a gap exists, capturing it is added to scope; if a flag is genuinely unavailable for historical rows, we label only when known and never guess (a missing forward flag degrades to today's behavior for that row, not a wrong label).
- **Phone numbers in prompts and projected markdown** → Accepted per D3; these episodes are regenerated under `episode-contract-v2`, the data is local, and the number is the repair anchor. The prompt rule requiring verbatim use is what keeps prose repairable.
- **Collision suffix could itself collide** (two JIDs sharing a number tail) → suffix length extends until the labels differ, falling back to the full number if needed.
- **Span cap interacts with silence-gap splitting and greedy merge** → both the split and the merge honor the cap, so no path can reassemble an over-span pack; unit tests cover a quiet multi-month chat producing multiple week-bounded packs.
- **Reaction annotation could still bloat a line** → per-line reaction cap (D1) bounds it; reactions never touch the message budget regardless.

## Migration Plan

- **No schema change, no data wipe.** `is_forwarded` and `quoted_source_message_id` already exist; reactions are already stored. Work is read-path (evidence query, pack/prompt builder), one new config var, and conditional importer capture only if Task 1 finds a gap.
- **Deploy:** ship behind the existing config; `WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS` defaults to 7 so behavior is well-defined without operator action.
- **Existing episodes:** episodes generated before this change keep their lower-fidelity text until `episode-contract-v2`'s reset regenerates everything; no backfill is triggered here.
- **Rollback:** revert the code change; the config var becomes inert. No forward-migration to undo.

## Open Questions — Resolved by the Task 1 audit (2026-07-12)

Ran read-only against the real archive (`.wapp-brain/archive.sqlite`, 325k imported + ~285 live messages):

- **Reaction source is single, not two.** Zero `messages` rows have `message_type='reaction'`; all reactions (42,283, every one `applied=1`) live in `live_message_updates` (`update_type='reaction'`, `source_message_key` = target, metadata `{emoji, reactorJid}`). 20,251 / 20,254 distinct targets match a real message row (orphans just don't render). The query therefore reads reactions **only** from `live_message_updates` — the `message_type='reaction'` union in D1 is a no-op here and is dropped. Reactor `'me'` (6,979) resolves to the owner label; reactions with empty emoji (a cleared reaction) are skipped.
- **Importer capture is fine; no importer work.** `parser.ts` already extracts `forwarded` and the quoted row id for both legacy and modern msgstore schemas ([parser.ts:706-710](../../../src/server/import/parser.ts), [:1293-1297](../../../src/server/import/parser.ts)). Forwards (6 total) and quotes (34 total) are genuinely sparse in this archive, not a capture gap — so Group 1.2's conditional importer scope is empty. We label/stitch when the flag/ref is present.
- **Quote referent key is `source_message_id`, not `source_message_key`.** `quoted_source_message_id` holds a surrogate *message id*; it resolves by matching another message's `source_message_id` **within the same chat** (23 of 34 resolve; the other 11 point at unarchived messages → the non-citable "not found" path). Tasks 3.3 and 5.2 key on `(chatSourceId, source_message_id)`, and in-pack resolution matches a replying message's `quotedSourceMessageId` against pack messages' `sourceMessageId`.

Decisions settled against the data:

- **Number-label format (D3):** the full, verbatim localpart of `sender_source_jid`, never truncated (the full token is what makes repair a deterministic find-replace): `+<digits>` for `@s.whatsapp.net`, `lid:<digits>` for `@lid`, the raw localpart for other/non-digit forms, and `participant-<shorthash>` when the JID is null. (Real archive: unresolved senders are rare — 6 distinct — but LID-heavy future archives make this load-bearing.)
- **Reaction annotation format (D1):** `[emoji reactorLabel]` per reaction, space-joined (`[👍 Rohit] [❤️ +919812345678]`).
- **Per-line reaction cap (D1):** show up to 8 `[emoji reactorLabel]` pairs, then `[+K more]` (max observed on one message: 120; avg 2.09; 680 messages exceed 8).
