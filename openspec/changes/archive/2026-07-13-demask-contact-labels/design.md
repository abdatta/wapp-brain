## Context

WhatsApp's Android backup (`wa_contacts.display_name`) stores a **masked** number for any contact not in your address book: `+91∙∙∙∙∙∙∙∙86` (country code + a run of bullet-mask characters + the last two digits). The importer reads that column directly ([parser.ts:372](../../../src/server/import/parser.ts)) and stores it as the contact's `display_name`. Identity is then resolved everywhere with the same SQL shape — `COALESCE(NULLIF(display_name,''), NULLIF(push_name,''), phone_number)` — which appears in ~9 places in `sqliteRepository.ts` (evidence sender, evidence reactor, quoted referent, search, thread view, nearby-context, …). Because `display_name` is the first COALESCE term, the masked placeholder wins the top preference tier and shadows better identifiers.

Real-archive audit (2026-07-12):

- 2,648 contacts have a masked `display_name`; 29 have a real self-set name.
- 1,735 are phone-form JIDs (`@s.whatsapp.net`) — the **full number is already present** in `phone_number` and encoded in the JID.
- 913 are unmapped LIDs (`@lid`) with **no** `phone_number` — only the masked hint exists.
- 1,738 DM chats are titled by the masked string (a DM's name derives from its contact).

The existing **Human-Readable Display Identity** requirement already prescribes *saved name → push name → formatted phone number → explicit unresolved*. This change closes the loophole where a masked placeholder is mistaken for the first tier.

**Constraints:** the raw archive layer (`contacts.phone_number`, JIDs, messages) must never be lost; the masked `display_name` is fully reconstructable and worthless, so nulling it loses nothing. Re-import is idempotent and reads from the backup, so the normalization must live at ingestion (not only as a one-off cleanup) or the masked value returns.

## Goals / Non-Goals

**Goals:**

- Never treat a masked-number string as a saved name; never let it shadow a real name or a fully-known number.
- Phone-form (and mapped-LID) identities render the complete, formatted `+E.164` number instead of the mask.
- Unmapped-LID identities read as the spec's explicit unresolved state (and count in identity health), not as a pseudo-name.
- Fix it at the write path so re-import and live sync can't reintroduce the mask, plus a one-time backfill for existing rows.
- Improve every read surface at once (brain, search, thread view) with no per-site special-casing of the mask.

**Non-Goals:**

- Recovering real names — that is enrichment/late-resolution ([[identity-late-resolution]]); this change only guarantees a clean, substitutable label in the meantime.
- Unmasking the 913 unmapped LIDs' numbers — we don't have them; honest unresolved is the correct outcome.
- Changing stored message content, `phone_number`, or JIDs.
- Reformatting/normalizing phone numbers globally beyond adding the `+E.164` display form at resolution.

## Decisions

### D1 — A shared `isMaskedNumberLabel` predicate

A single predicate (in the identity utilities, reused by parser, write path, backfill, and tests) recognizes WhatsApp's placeholder: a string that, ignoring spaces and a leading `+`, consists only of digits and mask characters **and contains at least one mask character**. Mask characters are the bullet/dot family WhatsApp uses (`∙` U+2219, `•` U+2022, `·` U+00B7, `‧` U+2027, and ASCII `.`), matched as a run so a real number with no mask never qualifies.

- **Why a positive phone-shape test, not just "contains a bullet"?** It avoids false positives on the rare real name containing a stray dot while reliably catching `+91∙∙∙∙∙∙∙∙86`. A label with any letter is never masked-number.
- **Why shared?** The same rule must gate ingestion, the write path, and the backfill, or they drift.

### D2 — Normalize at ingestion, not at every reader

The masked value is neutralized where it enters the system, so the ~9 read sites need no mask-awareness:

- **Parser**: when building a `ContactRecord`/chat from the backup, if the resolved display name is a masked-number label, treat it as absent (null) — the same as if WhatsApp had no name.
- **`upsertContacts` (and chat upsert) write-path guard**: reject an incoming masked `display_name` (coerce to empty) so live sync, Google enrichment, or any future writer can't store it either. This is the robust choke point.

- **Why not fix the 9 read COALESCEs?** Scattered, easy to miss one, and it would leave the mask festering in the column. Killing it at the source is one edit surface and self-consistent.

### D3 — The phone fallback is formatted `+E.164`

With `display_name` null for masked identities, resolution falls to `phone_number` (raw digits) or the JID. Today the COALESCE returns bare digits (`919051167186`); the spec says "formatted phone number." Resolution yields `+E.164` by deriving from the identity: prefer `phone_number` formatted with a leading `+`, else the number encoded in a phone-form JID (the existing `displayPhoneFromJid` helper). This is applied via a shared display-resolution helper / SQL expression so all sites agree, and phone-form identities always beat any residual mask.

- **Why derive from the JID too?** 913 pn-less contacts and many senders have the number only in the JID; the brain already uses `displayPhoneFromJid`. Generalizing it means the full number is available even when `phone_number` is null.

### D4 — One-time, idempotent backfill

A migration nulls `display_name` on `contacts` and `chats` wherever `isMaskedNumberLabel` holds (2,648 + 1,738 rows), so existing data benefits without re-import. It touches only `display_name`; `phone_number`, JIDs, and messages are untouched. Idempotent (re-running finds nothing) and safe to run with the server up or down since it's a bounded UPDATE.

- **Why a backfill and an ingestion guard?** The guard prevents future masks; the backfill cleans the past. Neither alone is sufficient.

### D5 — Unmapped LIDs become honestly unresolved

Nulling a masked LID contact with no number lets it resolve to the spec's explicit unresolved state, which identity health already counts and the UI already surfaces. This is a deliberate, spec-aligned improvement over a fake label — the 913 unmapped LIDs were never really identified, and they become repair targets for mapping/enrichment.

- **Trade-off:** those 913 lose the "country + last two digits" hint. Accepted — a masked hint is not a usable identifier, reads worse than an honest unresolved state, and can't be repaired by find-replace. Identity health makes them visible rather than hiding them behind a placeholder.

### D6 — A stored mask is "weak" for name enrichment (self-heal)

Name enrichment (`enrichContactsFromGoogle`) only overwrites a display name it considers *weak*: empty, a prior Google/display-cache fill, or an identity-derived restatement of the number. A masked-number placeholder was none of those, so it was treated as a **strong** saved name and enrichment skipped the contact — a phone-form number that was already in the user's Google Contacts kept rendering `+91∙∙∙∙∙∙∙∙86`. Real case (2026-07-13): the DM `+12136968563` sat nameless despite being saved in Google as "Me US (Mint)", because a Google sync had run while the mask was still stored and read it as a name. Adding `isMaskedNumberLabel(display_name)` to the weak set makes the mask rank as no-name here too, so a learned real name replaces it. The in-memory adapter's equivalent gets the same guard for parity.

- **Why this belongs in demask:** it is the last read site that still treated a mask as a saved name. D2 stopped *writing* masks; D4 *cleared* stored masks; D6 stops a stored mask from *shadowing* a real name during improvement. Same predicate, same thesis.
- **Why no new re-enrichment scheduler:** the sync already auto-runs on every brain run ([server.ts](../../../src/server/server.ts)), so with D6 the archive self-heals on the next run with no manual step. Proactively re-enriching *every* nameless contact (e.g. caching Google names locally to apply without a re-fetch) is broader identity repair and stays with `identity-late-resolution` (#4); demask deliberately scopes to the precedence fix.
- **Boundary:** a genuine saved name (`whatsapp_saved`, non-masked, non-identity-derived) stays strong and is never overwritten by enrichment — unit-tested.

## Risks / Trade-offs

- **False positive: a real name that looks masked** → D1 requires the whole string (minus `+`/spaces) to be digits + mask chars, so any letter disqualifies it; unit-tested against names, real numbers, and names containing digits.
- **Locale/version variance in the mask glyph** → the predicate matches a family of bullet/dot codepoints, not a single one; if a new glyph appears it's an additive change to one constant.
- **Unmapped LIDs now show unresolved** (D5) → intended; surfaced via identity health, not silently dropped.
- **Phone fallback formatting** touches multiple resolution sites → centralize in one helper/expression so they can't diverge; covered by tests.
- **Backfill runs against a large table** → a single indexed/whole-table UPDATE on `display_name` for ~4.4k rows is trivial; idempotent and re-runnable.

## Migration Plan

- Ship the predicate + ingestion/write-path guard + the `+E.164` fallback together, plus the backfill as a schema/data migration that runs once on startup (idempotent).
- No re-import required; no data wipe. Re-import remains safe because the ingestion guard drops masked values.
- **Rollback:** revert the code; the backfill is not reversed automatically, but nulled masked names carry no information loss (the full number remains derivable) — a re-import would repopulate `display_name` only if the guard is also reverted.

## Open Questions

- **Should the `+E.164` formatting be a SQL expression duplicated at each site, or a single post-query display helper?** Leaning: one shared helper (mirrors the brain's `displayPhoneFromJid`) to avoid 9 divergent SQL fragments; settle during implementation.
- **Do any real push names legitimately consist only of digits + a dot?** (e.g. a self-set name like "007."). The predicate treats a dot-containing all-digit string as masked; if such push names exist they'd be demoted to their number. Judged acceptable/rare; confirm against the push-name sample during implementation.
