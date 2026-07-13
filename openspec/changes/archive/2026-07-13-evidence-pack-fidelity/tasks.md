## 1. Audit archive capture (do first — decides scope)

- [x] 1.1 Determine where reactions actually live: query the real archive for `messages` rows with `message_type = 'reaction'` and for `live_message_updates` rows with `update_type = 'reaction'`; record which sources are populated, how each references its target message, and the shape of the reactor/emoji metadata. → **only `live_message_updates` (42,283, all applied); 0 reaction message rows; metadata `{emoji, reactorJid}` keyed by target `source_message_key`.**
- [x] 1.2 Verify the importer (not just live sync) populates `is_forwarded` and `quoted_source_message_id` on `messages`; sample real forwarded and reply rows. If a column is unpopulated for imported/historical rows, note it and add its capture to the relevant scope group below (label/stitch only when known, never guess). → **importer already captures both (`parser.ts`); forwards/quotes are sparse but real; no importer work needed.**
- [x] 1.3 Decide against real data: the primary number-label format (D3), the reaction-aggregation format for many identical emoji, and the per-line reaction cap (D1). Write the decisions into `design.md`'s Open Questions resolution. → **full verbatim number token; `[emoji reactorLabel]`; cap 8 + `[+K more]`. Also corrected: quote key is `source_message_id`, not `source_message_key`.**

## 2. Config: episode span cap

- [x] 2.1 Add `WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS` (coerced positive int, default 7) to the env schema in `src/server/config.ts` and expose `config.brain.maxEpisodeSpanDays` (and/or a derived `maxEpisodeSpanMs`).

## 3. Evidence query: surface reactions, quoted refs, forward flag, number

- [x] 3.1 Extend `MemoryEvidenceMessage` (in `src/shared/types.ts`) with the fields the pack builder needs: `isForwarded: boolean`, `quotedSourceMessageId: string | null`, and `reactions`. → **refined: reactions carry `{emoji, reactorJid, reactorDisplayName}` (new `MemoryEvidenceReaction`) so the final reactor label uses the one owner/number policy in episodes.ts, not a policy duplicated in the repo.**
- [x] 3.2 In `listMemoryEvidenceMessages` (`src/server/db/sqliteRepository.ts`), select `m.is_forwarded` and `m.quoted_source_message_id`, and gather reactions per message from `live_message_updates` (the only source per Task 1), resolving each reactor JID via the same contact-join path used for senders. → **added `attachReactions` (chunked IN query, applied+non-empty emoji); `rowToMemoryEvidence` sets the new fields tolerantly (the nearby-context query omits them).**
- [x] 3.3 Add a bounded repository lookup `resolveQuotedReferents(chatSourceId, ids[]) → Map<id,{senderLabel, snippet}>` keyed on `source_message_id` (Task 1 correction), owner-aware, body/caption truncated to 80 chars, absent when the quoted message is not archived. Declared on `ArchiveRepository`; implemented in both the SQLite and in-memory repos.

## 4. Pack builder: number labels, collisions, forward label, span cap

- [x] 4.1 Rewrite sender labelling (`src/server/brain/episodes.ts`) so an unresolved sender returns a deterministic verbatim number label from `senderSourceJid` (`numberLabelFromJid`: `+digits` / `lid:digits` / `participant-<shorthash>`), keeping `${owner} (me)`; no label is ever the literal `"Unknown"`.
- [x] 4.2 Add per-pack same-name collision disambiguation via `buildPackLabeler` (D4): distinct sender JIDs sharing a display name each get a number-tail suffix extended until unique. Used by `participants`, `packPromptLines`, and `extractiveEpisode` (which uses the clean owner name — no `(me)` — for prose).
- [x] 4.3 Enforce the episode span cap in `buildEvidencePacks` (D5): new segment when `nextTs - segmentStartTs >= maxEpisodeSpanMs`; greedy merge refused when combined span would reach the cap.

## 5. Prompt assembly: annotations and prompt rules

- [x] 5.1 In `packPromptLines`, render reactions inline as non-citable annotations via `renderReactions` (cap 8, `[emoji reactorLabel] … [+K more]`); reactions get no alias and no `keyByAlias` entry.
- [x] 5.2 Render the quoted-reply referent (D2): citable `↳ replying to <alias> (<sender>): "…"` in-pack (matched by `sourceMessageId`), non-citable `↳ replying to (<sender>): "…"` out-of-pack, `↳ replying to an earlier message` when unresolved.
- [x] 5.3 Label forwarded messages `<sender> (forwarded):` and add the prompt legend + rules (attribute forwarded as shared; use number/`lid:`/`participant-` tokens verbatim; keep same-name disambiguating suffixes).
- [x] 5.4 Citation integrity preserved (D6): `validateModelEpisode` unchanged; `keyByAlias` still maps only real pack messages; reactions and out-of-pack referents carry no alias. Verified by typecheck + existing tests green.

## 6. Tests

- [x] 6.1 Reaction annotation rendering: covered by "surfaces reactions, quoted replies, forwards, and number labels in the model prompt" — reaction attached to its target (not a pack message), `[👍 Rohit]` in the prompt, and a claim citing the target's alias `m1` validates as a model episode.
- [x] 6.2 Quoted-reply referents: same test asserts in-pack `↳ replying to m1 (Riya):`, out-of-pack archived snippet `↳ replying to (Riya): "…"` (no alias → non-citable), and unarchived `↳ replying to an earlier message`.
- [x] 6.3 Forwarded labelling: same test asserts `(forwarded)` on the row and the shared/forwarded rule in the prompt.
- [x] 6.4 Number labels and collisions: "number-labels unresolved senders and disambiguates same-name participants" — `lid:55999`, two distinct `Rohit (…tail)` labels, never `"Unknown"`.
- [x] 6.5 Span cap: "bounds a quiet chat's episode span independent of silence gaps" — causal (1 pack wide-cap → >1 pack at 3-day cap), each pack under the cap, no message lost.

## 7. Checkpoint

- [x] 7.1 **(verified 2026-07-12 on "Party @ Kelton" `120363418904222042@g.us`, gpt-5.6-terra)** 5 committed episodes, all model-generated. **Reactions**: the committed 2025-07-26 window is reaction-dense (👍 on the "$34.75" expense split, 😂🥊, ❤️❤️❤️) — annotations rendered and the model cited the reacted message. **Attribution/number-labels**: unresolved senders used consistently as `+1…12` / `+1…07`; **zero literal "Unknown"** in any episode. **Reply-stitching + forwarded**: not field-observed — this chat's 5 replies are all recent (2026-07-09, in un-assimilated windows) and forwards are near-absent archive-wide (6 total); both paths are covered by unit tests, and reply-stitching can be field-checked cheaply on a tiny chat whose reply is in its oldest window (e.g. `919874424546@s.whatsapp.net`).
- [x] 7.2 **(verified 2026-07-12 on "Vaibhav Kumar Agarwal" `919680751869@s.whatsapp.net`, gpt-5.6-terra)** The ~10-year backlog produced **2 correctly time-bounded episodes** (a 3-day cluster 2016-07-23..26 and a single-message 2016-10-05), split at the silence gap, each well within the 7-day cap — not one multi-year blob. The busy Party windows are each ≤7 days (the span cap engaging on a dense chat).
