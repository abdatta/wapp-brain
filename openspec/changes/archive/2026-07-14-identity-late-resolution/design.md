## Context

Names resolve over time — a contact saved after a new number messages first, Google Contacts sync, and future msgstore sources (`jid_map`, `lid_display_name`) — and resolution keeps improving for the life of the archive. The governing principle is *store references, render names*: every layer keyed on JID resolves display names at read time, so late resolution is free everywhere **except** LLM-generated prose, where a participant's number gets baked into `brain_episodes.summary` and `brain_claims.text` at commit.

`episode-contract-v2` already made that baked prose repairable. Its **Late-Binding Commit Stamps** record, per episode, `unresolved_participants_json` — the exact source JIDs whose evidence label fell through to a number token ([episodes.ts:745](../../../src/server/brain/episodes.ts), `computePackStamps` → `labeler.numberTokenJids`). The token itself is deterministic: `numberLabelFromJid` ([episodes.ts:80](../../../src/server/brain/episodes.ts)) bakes `+<E.164>` for a phone-form JID and `lid:<digits>` for a LID. And `demask-contact-labels` guarantees the `+E.164` form is the **full, clean** number, never WhatsApp's masked `+91∙∙∙∙∙∙∙∙86` placeholder — a full number is a distinctive, find-and-replaceable token; a masked placeholder is not. Together these make deterministic prose repair possible: saving a contact tomorrow can retroactively improve every episode written today, at zero LLM cost.

Two "identity improved" events already exist in the repository, with different amounts of derived-layer repair wired today:

- **A JID gains a name** — `upsertContacts` ([sqliteRepository.ts:2932](../../../src/server/db/sqliteRepository.ts)) fills `display_name` (import, live sync, contact-save), and `enrichContactsFromGoogle` ([:2994](../../../src/server/db/sqliteRepository.ts)) fills it from Google. Today this path updates DM chat titles via `propagateContactNamesToDmChats` and **nothing else** — no `resolved_text` recompute (search keeps showing the old number), no brain touch. This is the **rename-trigger gap**.
- **A JID merges into an identity** — `mergeIdentity` ([sqliteRepository.ts:2643](../../../src/server/db/sqliteRepository.ts), LID→PN) already moves episodes to the surviving `chat_source_id`, rekeys citations through the stable rowid anchor, merges watermarks, and recomputes `resolved_text` for the identity's messages and messages mentioning it (chunked, yielding). It does **not** substitute the `lid:<digits>` token already baked into old episode prose.

This change builds the missing repair machinery and unifies both events behind one entry point, so every current and future resolution source repairs the same way. The archive is already at real scale (thousands of contacts, ~913 unmapped LIDs, per the demask audit), so the repair must be non-blocking and chunked.

## Goals / Non-Goals

**Goals:**

- One internal repair entry point — "identity improved for JID X" — that both variants (name-gained, merge) and every future name source route through, so repair logic exists once.
- Deterministic prose repair with **zero model calls**: substitute the baked number token with the resolved name in stamped episodes' `summary` and `claims.text`, clear that JID from the stamp, re-project Markdown, recompute participants.
- Close the rename-trigger FTS gap: the name-gained path recomputes `resolved_text` for the identity's messages (and mentions), exactly as the merge path already does, so search by the new name immediately finds old messages.
- A resolution-debt surface in the Brain panel — episodes with unresolved participants, ranked by message volume — so contact-saving becomes a prioritized to-do list that shows which saves buy the most brain quality.
- Repair the existing archive without a re-run: an idempotent one-time pass repairs episodes whose participants already carry names (contacts saved before this change).

**Non-Goals:**

- Re-running extraction as the primary repair — the deterministic pass alone keeps the brain honest. Optional low-priority regeneration is a *quality upgrade* layered on top ([[semantic-rollups]] and the model connecting the named person to context), never the mechanism that clears the debt.
- Recovering names we don't have — resolving *which* name a JID should get is the concern of contact-save, Google enrichment ([[google-contacts-integration]]), and [[two-level-person-model]]; this change only propagates a name once known.
- New schema or a derived-data wipe — this change is a pure consumer of `episode-contract-v2`'s stamps; `brain_episodes`/`brain_claims`/`messages_fts` are repaired in place.
- Substituting non-verbatim references (a model paraphrase like "the +91 person") — only the exact baked token is deterministically repairable; the rest is what optional regeneration is for.
- Rewriting stored message content or citations — those are the raw checkable truth and stay byte-identical.

## Decisions

### D1 — One unified "identity improved" repair entry point

A single internal method — `repairIdentityResolution(jid)` (working name), in `sqliteRepository.ts` near `mergeIdentity` — is the choke point every resolution source calls. It selects the episodes to repair (those whose `unresolved_participants_json` contains the affected JID or a LID that links to it), runs the deterministic prose pass (D2), recomputes FTS (D4), re-projects (D5), invalidates the brain-status cache, and optionally enqueues regeneration (D7). Both variants route through it: the name-gained path calls it after `upsertContacts`/`enrichContactsFromGoogle` detect a genuine name transition; `mergeIdentity` calls it for the survivor after its existing rekey. Future sources (`jid_map`, `lid_display_name`) call the same method.

- **Why one entry point?** Repair correctness (substitution + FTS + projection + cache invalidation, all chunked and transactional) is subtle; three copies would drift. The merge path proves the pattern — it already does the FTS half; this generalizes it.
- **Why keyed on JID, not on a name diff?** The stamp records JIDs, the baked token is a pure function of the JID, and the current best label is resolvable from the JID at call time. Keying on JID makes the hook idempotent and source-agnostic: it never needs the caller to tell it the old or new string.

### D2 — Deterministic prose substitution, driven by the stamp

For each selected episode, for each JID in its `unresolved_participants_json`: recompute the **old baked token** deterministically from the JID (`numberLabelFromJid`), resolve the JID's **current best label**, and if that label is now a genuine name (D3), replace occurrences of the token in `summary` and every `claims.text`, then remove that JID from the stamp. The whole episode set is repaired in one transaction per chunk.

- The old token is regenerated from the JID by the *same* function that baked it, so the search string always matches what was written — no need to have stored the token.
- **Collision suffixes**: the labeler disambiguates same-numbered participants as `+919051167186 (…7186)` ([episodes.ts:184](../../../src/server/brain/episodes.ts)). Substitution matches the base token optionally followed by the ` (…digits)` suffix and replaces the whole thing, so no dangling suffix is left behind.
- **Per-JID stamp clearing** (not whole-stamp): an episode with two unresolved participants where only one is saved keeps the other stamped and still counts in the debt surface.

### D3 — Substitute only toward a genuinely better label

Substitution fires only when the JID's resolved label is a real name (not itself a number token — reusing `baseParticipant`'s `isNumberToken` test). Two cases:

- **Name-gained**: `+919051167186` → `Rohit`. Clear the stamp for that JID.
- **Merge, name known**: `lid:12345678` → `Rohit`. Clear the stamp.
- **Merge, still no name**: `lid:12345678` → `+919051167186` (the number is now known even though the name isn't). This is a real improvement — a LID token is opaque, a full number is a usable, later-substitutable identifier — so we substitute the token **but keep the JID stamped** (still unresolved, now as a number). This lets a future name-save repair it again.

- **Why keep the stamp when only the number improved?** The debt surface must still count it as unresolved; and the next repair (name saved) must be able to find and replace the number token it just wrote.

### D4 — FTS repair closes the rename-trigger gap

The entry point recomputes `resolved_text` for the identity's messages and messages that mention it, via the existing `syncMessageDerivedState` ([sqliteRepository.ts:1387](../../../src/server/db/sqliteRepository.ts)), chunked under `SQLITE_IN_QUERY_BATCH_SIZE` with `setImmediate` yields — the exact loop `mergeIdentity` already runs ([:2780](../../../src/server/db/sqliteRepository.ts)). The name-gained path gains this recompute (it had none); the merge path already does it and is left as-is. This is the same generalization the demask backfill ([:1117](../../../src/server/db/sqliteRepository.ts)) and [[retrieval-hardening]] converge on.

- **Why reuse `syncMessageDerivedState`?** It already rebuilds `resolved_text` (sender label + mentions) and drives the FTS triggers; the search index needs no mask-awareness or rename-awareness of its own.

### D5 — Re-projection and participants recompute are deterministic

Repaired episodes re-project their Markdown from the database (the existing projection path — **Episode Markdown Projection**, regenerated deterministically, hand-edits overwritten) and recompute `participants_json`. Chat/sender display names are confirmed render-time at every read site (already true post-demask); no stored display copy is load-bearing.

- **Why re-project rather than string-patch the markdown column?** Projection is already defined as a pure function of DB state; patching would risk divergence from the summary/claims we just edited.

### D6 — Citations are never touched; substitution is best-effort and independently safe

Citations keep pointing at raw messages (via the stable rowid anchor the merge path maintains); the number in a cited message body stays byte-identical. So substitution coverage is a *display-quality* concern, never a correctness one: if a token is missed (paraphrased, unusual formatting), the episode is still fully checkable against its evidence, and regeneration (D7) can later improve it. This is what makes a zero-model deterministic pass safe to ship.

### D7 — Repair-first; regeneration is an optional quality upgrade

The deterministic pass is the repair. Additionally, repaired episodes **may** be enqueued as low-priority `regenerate` tasks (the model can weave the now-named person into context) that drain lazily under budget through the existing **Episode Regeneration** path — never blocking, never the thing that clears the debt. Default posture: off or lowest-priority, settled in implementation; the checkpoint must pass with regeneration disabled.

### D8 — Resolution-debt surface from the stamp

Brain status gains a line — "N episodes involve unresolved participants (M distinct numbers)" — computed from `current`-status episodes with a non-empty `unresolved_participants_json`, with the distinct JIDs ranked by message volume so the highest-value saves surface first. It decrements as identities resolve, with no model call, and a repair completion emits an SSE nudge so the UI updates live.

- **Why rank by message volume?** Saving the contact behind 2,000 messages repairs far more prose and search than one behind three; the surface should say so.

### D9 — One-time idempotent backfill repair

On startup (mirroring `backfillMaskedContactLabels`), run the repair entry point once for every stamped JID that already resolves to a name — so episodes written before this change, whose participants were saved earlier, repair immediately. Idempotent: a second run finds cleared stamps and no matching tokens, and does nothing.

## Risks / Trade-offs

- **Over-substitution: the token appears in unrelated prose** (a claim quoting the participant's own number verbatim, e.g. "call +9190…") → substitution rewrites it to the name. Almost always correct or benign (it *is* that person's number); the optional provenance form `Rohit (then +91 90…)` preserves the number when it matters. Scoped per-episode to the stamped JIDs, so an unrelated number is never a candidate.
- **Collision-suffix drift** → substitution regex matches the base token plus the optional ` (…digits)` suffix; unit-tested against suffixed and un-suffixed forms.
- **Non-verbatim mentions can't be repaired deterministically** → accepted; the prompt already instructs the model to refer to unresolved participants "by exactly that number" (**Evidence Selection Policy**), so verbatim tokens dominate; regeneration (D7) covers the residue.
- **Repair over a high-volume identity is heavy** (thousands of messages + many episodes) → chunked with event-loop yields per the **Non-Blocking Operation** requirement; runs as durable, progress-reported work, never on the socket path.
- **Merge-variant double work** → `mergeIdentity` already recomputes FTS; the unified entry point must not recompute it twice. Resolve by having the merge path call the *prose+projection* half after its existing FTS recompute, or by making the entry point idempotent on already-recomputed messages.

## Migration Plan

- Ship the entry point + both call sites + the debt surface together; no schema change, no data wipe (pure consumer of `episode-contract-v2` stamps).
- Run the one-time backfill repair (D9) on startup, idempotent, chunked; log episodes repaired / tokens substituted / messages recomputed, like the demask backfill.
- **Rollback**: revert the code. Already-substituted prose stays substituted (a strict improvement — the name is correct and citations are untouched); no reverse migration is needed because no information is lost.

## Open Questions

- **Provenance rendering default** — plain name in claims (`Rohit`) vs. inline provenance (`Rohit (then +91 90…)`)? Leaning plain name in prose with the number available via citations/hover; settle during implementation.
- **Should a merge that yields only a number (no name) substitute the `lid:` token now, or wait for a name?** Leaning substitute-now (D3) — a full number beats an opaque LID token and is itself later-repairable — but confirm it reads well in a real merged episode.
- **Regeneration default** — off, or lowest-priority-under-budget on by default? Leaning off for the checkpoint; a Brain-panel toggle can enable the quality drain.
- **Backfill scope on first run at archive scale** — repair-all-eligible at once vs. enqueue as durable repair tasks that drain like catch-up? Leaning durable/chunked if the eligible set is large; measure on the real archive.
