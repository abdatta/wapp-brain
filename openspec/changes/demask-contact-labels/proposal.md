# Demask Contact Labels

## Why

WhatsApp stores a **masked** number as the `display_name` for contacts you have not saved — e.g. `+91∙∙∙∙∙∙∙∙86`. The importer copies that column verbatim ([parser.ts](../../../src/server/import/parser.ts) reads `display_name` straight from `wa_contacts`), and every read path resolves identity with `COALESCE(display_name, push_name, phone_number)` — so the masked string wins the *highest* preference tier, as if it were a saved name. It then shadows the better identifiers we already hold and leaks into episodes, search results, and the thread view as an unreadable, useless label.

This directly violates the existing **Human-Readable Display Identity** requirement, which mandates *saved name → push name → formatted phone number*: a masked placeholder is none of those, yet it is being treated as a saved name.

The real archive shows the scale and the opportunity:

- **2,648 contacts** carry a masked `display_name`; only **29** have any real self-set name.
- **1,735** of them are phone-form JIDs whose **full number we already have** (in `phone_number` and encoded in the JID itself) — we are showing `+91∙∙∙∙∙∙∙∙86` when we could show `+919051167186`. This is the case that surfaced in the `evidence-pack-fidelity` checkpoint (Party @ Kelton claims read `+1∙∙∙∙∙∙∙∙12`).
- **913** are unmapped LIDs with no number at all — the masked string is a stand-in for an identity we genuinely cannot resolve, and per the identity spec should read as an explicit unresolved state (and count in identity health), not as a pseudo-name.
- **1,738 DM chats** are titled by the same masked string.

A masked number is the one form that is bad for *both* reading and repair: it can't be find-and-replaced by late name-resolution the way a full number can. Fixing it at the identity layer improves every surface at once — brain summaries, search, and the thread view — and it is a prerequisite quality bar before more of the archive is assimilated.

## What Changes

- **Masked-number strings are no longer treated as names.** A shared predicate recognizes WhatsApp's masked-number placeholder (a phone-shaped string whose digits are obfuscated by bullet/dot mask characters), and ingestion (the parser and the `upsertContacts`/live write path) stores such a value as *no name* (null `display_name`) rather than as a saved name — so re-import and live sync can never reintroduce it.
- **Resolution falls through to the full, formatted number.** With the masked value gone, `COALESCE(display_name, push_name, phone_number)` and the JID-derived `+E.164` fallback yield the complete number for phone-form identities. The phone fallback is formatted (`+<E.164>`), satisfying the spec's "formatted phone number" tier, instead of bare digits.
- **Unmapped LIDs read as honestly unresolved.** For LID identities with no number and only a masked hint, nulling the masked name lets them surface as the explicit unresolved state already defined by the spec and counted in identity health — repairable later via mapping/enrichment ([[identity-late-resolution]]) rather than frozen behind a fake label.
- **One-time backfill + search recompute.** A migration nulls existing masked `display_name` values on both `contacts` (2,648) and `chats` (1,738) so already-imported data benefits without re-importing; raw `phone_number` and JIDs are untouched, so no number is lost. Because `resolved_text` (the FTS index) embeds the sender label, the backfill also recomputes the affected senders' derived search state, so search stops matching/showing the masked label — the same rename-recompute concern `retrieval-hardening` (#8) and `identity-late-resolution` (#4) later share via one hook.
- **No new masking, ever.** The system never generates a masked number; it either shows a real name, the full formatted number, or an explicit unresolved state.

## Capabilities

### Modified Capabilities

- `identity-and-naming-integrity`: the **Human-Readable Display Identity** requirement is tightened so a masked-number placeholder is explicitly excluded from the saved-name tier and demoted to (at best) the formatted-phone tier, and the phone fallback is a formatted `+E.164` number; ingestion normalizes masked values to no-name and a backfill cleans existing rows.

## Impact

- **Code**: `src/server/import/parser.ts` (normalize masked contact/chat display names at read), `src/server/db/sqliteRepository.ts` (`upsertContacts` write-path guard, the `+E.164` formatting of the phone fallback across the ~9 identity-resolution sites or via a shared helper, and the one-time backfill migration), a shared `isMaskedNumberLabel` predicate in the identity utilities.
- **Data**: one-time backfill nulls masked `display_name` on `contacts` and `chats`; `phone_number`, JIDs, and messages untouched. No archive data lost (the masked string is fully reconstructable and worthless).
- **Surfaces improved**: brain episodes, full-text search result labels, thread-view sender/chat names — all stop showing masked numbers.
- **Tests**: the predicate (masked vs. real name vs. real number vs. name-containing-digits), ingestion normalization, the `+E.164` phone fallback, backfill idempotency, and that an unmapped LID reads as unresolved rather than masked.
- **Relationship to the roadmap**: independent of the brain chain (like the archive-layer changes); complements `identity-late-resolution` (#4), which repairs identities when a real name arrives — this change guarantees the pre-repair label is a clean, substitutable number, not a masked dead end.
