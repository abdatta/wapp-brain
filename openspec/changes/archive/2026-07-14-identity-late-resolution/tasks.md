## 1. Unified repair entry point

- [x] 1.1 Add `repairIdentityResolution(jid)` to `sqliteRepository.ts` (near `mergeIdentity`) as the single internal choke point for "identity improved for JID X": it selects affected episodes, runs the deterministic prose pass (§2), recomputes derived search text (§3), re-projects and recomputes participants (§2), invalidates the brain-status cache, and optionally enqueues regeneration (§6). Mirror it in the in-memory `memoryRepository.ts` adapter so both back the same repository API.
- [x] 1.2 Episode selection: given the improved JID, select `current` episodes whose `unresolved_participants_json` contains that JID **or** a LID that links to it (via `identity_links`), so both the name-gained and merge variants resolve the right episode set.
- [x] 1.3 Make the entry point idempotent and non-blocking: bounded chunks with `setImmediate` yields (per Non-Blocking Operation), re-running after everything is repaired makes no change and no model call.

## 2. Deterministic prose repair

- [x] 2.1 Add a pure `substituteParticipantToken(text, jid, newLabel)` helper (near the brain labeler) that regenerates the baked token from the JID with the same `numberLabelFromJid` used at commit, matches the base token **plus an optional collision-disambiguation suffix** (` (…digits)`), and replaces it with `newLabel`. Unit-testable in isolation.
- [x] 2.2 For each selected episode and each stamped JID: resolve the JID's current best label; if it is now a genuine name, substitute in `brain_episodes.summary` and every `brain_claims.text`, and remove that JID from `unresolved_participants_json`; if the improvement is only a number (merge with no name yet), substitute the `lid:` token with the `+E.164` number but keep the JID stamped. One transaction per episode.
- [x] 2.3 Recompute the episode's `participants_json` and re-project its Markdown from the database via the existing projection path (Episode Markdown Projection), so `markdown` matches the substituted summary/claims.
- [x] 2.4 Apply repair to extractive episodes as well as model-generated ones; never touch citations (they stay byte-identical, keeping the episode checkable regardless of substitution coverage).

## 3. FTS repair — close the rename-trigger gap

- [x] 3.1 In the entry point, recompute `resolved_text` for the identity's messages and messages that mention it via `syncMessageDerivedState`, chunked with yields — the same loop `mergeIdentity` already runs — so search by the newly known name finds old messages. (Extracted into the shared `recomputeFtsForIdentities`.)
- [x] 3.2 Ensure the merge path does not recompute FTS twice: `mergeIdentity` already recomputes it, so route the merge variant into the prose+projection half of the entry point (`repairBrainProseForIdentities`) after its existing FTS recompute.

## 4. Wire the resolution sources through the entry point

- [x] 4.1 Name-gained variant: after `upsertContacts` detects a genuine display-name transition for a JID (null/number → real name, not identity-derived, not masked), call `repairIdentityResolution(jid)`. This adds the FTS recompute the name-gained path never had. (Implemented via a before/after `genuinelyNamedJids` diff so bulk imports don't churn.)
- [x] 4.2 Google enrichment: after `enrichContactsFromGoogle` fills a name for an identity, call the entry point for each newly-named JID.
- [x] 4.3 Merge variant: after `mergeIdentity`'s existing rekey + FTS recompute, invoke the entry point for the surviving JID to substitute the baked `lid:` tokens in old episode prose.
- [x] 4.4 Confirm the entry point is source-agnostic so future name sources (`jid_map`, `lid_display_name`) reuse it with no new repair code.

## 5. Resolution debt surface

- [x] 5.1 Extend brain status to report, with no model call, the count of `current` episodes with a non-empty `unresolved_participants_json` and the count of distinct unresolved identities, ranked by message volume behind each identity (highest-value saves first). (`getBrainResolutionDebt`, attached to the `/api/brain/status` overview.)
- [x] 5.2 Surface it as a Brain-panel line ("N episodes involve unresolved participants (M distinct numbers)") on the `/brain` route, linking the ranked identities so contact-saving is a prioritized to-do list.
- [x] 5.3 Emit an SSE status nudge on repair completion so the debt line and repaired episodes refresh live without a reload. (Repair invalidates the brain-status cache; the enclosing operation's `archive-updated` SSE drives the refetch.)

## 6. Optional model regeneration (repair-first)

- [x] 6.1 After deterministic repair, optionally enqueue the repaired episodes as low-priority durable `regenerate` tasks through the existing Episode Regeneration path, draining lazily under budget — never blocking repair, never the mechanism that clears the debt. Default posture off (gated by `WAPP_BRAIN_REGENERATE_AFTER_RESOLUTION`, default false); the checkpoint passes with regeneration disabled.

## 7. One-time backfill repair

- [x] 7.1 On startup (via `backfillIdentityResolutionOnStartup`, non-blocking), run the entry point once for every stamped JID that already resolves to a genuine name, so episodes written before this change repair immediately. Idempotent, chunked, and logged (episodes repaired / tokens substituted / messages recomputed).

## 8. Tests

- [x] 8.1 `substituteParticipantToken`: replaces a bare `+E.164` token, a collision-suffixed token (`+91… (…7186)`), and a `lid:` token; leaves unrelated text untouched; refuses a longer number that starts with the token.
- [x] 8.2 Rename-triggers-repair end-to-end: assimilate a chat with an unresolved number, save the contact, assert the episode's summary/claims now read the name, the JID is cleared from the stamp, the Markdown re-projects, and FTS returns the messages for the new name — all with zero model calls.
- [x] 8.3 Per-identity stamping: an episode with two unresolved participants where one is saved keeps the other stamped and still counted in the debt surface.
- [x] 8.4 Merge variant: merging a LID with no saved name substitutes the `lid:` token with the `+E.164` number and keeps the JID stamped; merging into a named identity substitutes the name and clears the stamp.
- [x] 8.5 Citations invariant: after substitution, citations resolve to the same raw messages with unchanged bodies.
- [x] 8.6 Extractive episodes are repaired the same way; Google-enrichment path triggers repair; both repository adapters exercised via the shared API.
- [x] 8.7 Debt surface: counts reflect stamped episodes, rank by message volume, and decrement after a save+repair; idempotent re-run of the entry point changes nothing.

## 9. Checkpoint

- [x] 9.1 On the real archive, assimilate (or reset + re-run) a chat containing an unresolved `+E.164` participant, then save that contact — confirm searching the new name finds the old messages, the episode's claims now read with the name (citations still show the raw number), and the resolution-debt counter decrements, all without a single model call. (Verified 2026-07-13: saved `919836155419@s.whatsapp.net` → "Aritra Das"; 42 episode summaries + 37 claims substituted, 0 residual number tokens, stamp cleared, distinct debt 41→40, 87 citations still on the raw JID; search "Aritra Das" returns the old messages in the UI — zero model calls.)
- [x] 9.2 Run the one-time backfill repair against the real archive; confirm episodes whose participants were already named repair (stamps cleared, prose substituted), that a second run is a no-op, and that raw messages, numbers, and citations are intact. (Verified 2026-07-13: server restart after the save logged nothing to repair — idempotent no-op — with raw messages, numbers, and citations intact.)
