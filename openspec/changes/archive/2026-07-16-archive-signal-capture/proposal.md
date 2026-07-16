# Archive Signal Capture

> Proposal seed created 2026-07-13; expanded 2026-07-14 after real thread review. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

A modern Android backup contains deterministic message details and history that the archive previously dropped or reduced to generic labels. The first implementation captured the canonical facts, but real-thread review exposed a second gap: the owner-facing UI still hides useful local data (coordinates, raw vCards, transcript text, edit/delete provenance), and some system events incorrectly attribute an affected participant's action to “You.”

Wapp Brain is a private, loopback-only archive for its owner. Privacy therefore means keeping data local and out of logs or unapproved remote-model calls—not withholding captured message details from the owner. Backup import and live sync must converge on the same facts, preserve complementary observations, and render only identities and actions the source actually proves.

## What Changes

- **Owner-visible message details**: add a focused local message-detail read surface for complete structured data while keeping the high-volume thread list compact. Full coordinates, raw vCards, source transcriptions/accessibility labels, exact mention identities, edit/delete timestamps, and verified system-event fields are allowed on this owner-facing surface.
- **Lossless vCards and download**: show every captured vCard property and card in message order. Offer a `.vcf` download using the source card when available, or a clearly labelled locally constructed card only when enough trustworthy fields exist.
- **Structured location cards**: render ordinary and live locations as visually distinct compact cards rather than text-like annotations. Show every available source field, including coordinates, name/address, accuracy, URL/comment/caption, speed/heading, live sequence/offset/duration/final time, observation time, and embedded-thumbnail availability; never fetch a map or link target automatically.
- **Mentions without redundant count**: retain authoritative JID capture, identity resolution, inline blue mention formatting, evidence behavior, and search behavior, but remove the extra “N structured mentions” footer from message bubbles.
- **Unified edit history**: show original send time and each available edit time for backup and live messages. Live-held revisions retain their text; metadata-only backup history shows an explicit “Original text unavailable” entry rather than hiding the history control or fabricating content.
- **Deletion detail**: keep captured content in place and add a detail panel showing original send time, deletion/revoke time, actor/admin when known, source/provenance, deletion kind, and whether original content was retained or never captured.
- **Expandable source interpretation**: replace “transcript captured”/“accessibility label captured” footers with compact controls that reveal the full source-provided text, provenance, and ordered transcript segments with start/end times.
- **Link-preview regression protection**: retain the current offline title, description, canonical URL, and embedded-thumbnail presentation unchanged while message details evolve.
- **Role-correct system events**: model actor, affected participant, old identity, new identity, and chat as distinct roles. “You” is permitted only when that exact role canonicalizes to the archive owner. Human-readable identity follows `name → full phone number → Unknown`; LIDs, group IDs, and other internal identifiers never count as a visible identity. A system row, chat JID, or `is_me_joined` flag must never be used as evidence that the owner performed the action.
- **Polished message-state controls**: render detail dialogs on an opaque top-level surface, suppress WhatsApp's generated “N contacts” and “Location”/“Live location” labels when their structured cards replace them, and reuse the existing Deleted state chip as the deletion-detail trigger instead of adding a second control.
- **Broader verified system decoding**: consume installed Baileys numeric/named stubs and structured parameter objects for number changes, membership, promotion/demotion, and group metadata/settings. Preserve raw type/parameters in local details for unsupported events while keeping their thread summary generic rather than guessing.
- **Cross-source convergence**: separate canonical facts from backup/live observations, define stable semantic keys and per-field precedence, and merge complementary data without duplicating a system event or live-location observation. A later backup anchor may replace a synthetic live timeline anchor without creating a second visible event.
- **Checkpoint**: synthetic and private real-chat verification must cover a downloadable multi-card vCard, static and live location details, inline mentions without the count footer, backup metadata-only edit history, live revision history, deletion details, transcript expansion, unchanged link previews, and system actions whose actor/participant are known, self, and unresolved.

## Capabilities

### New Capabilities

None. This revision deepens the existing interpretation and thread-view contracts rather than introducing a separate product surface.

### Modified Capabilities

- `message-interpretation`: canonical signal capture and merge rules now retain full owner-visible detail, multiple source observations, richer location/system fields, downloadable vCards, edit/delete timelines, and role-correct system identities.
- `whatsapp-style-thread-view`: the local thread gains structured location/vCard cards, expandable source details, metadata-only edit history, deletion details, non-redundant mentions, and correct system-event attribution.
- `brain-assimilation`: evidence remains bounded and provenance-labelled even though the owner-facing local UI can reveal complete source content; cross-source enrichment continues to invalidate only dependent episodes.

## Impact

- **Types and storage**: extend signal records with richer location fields, lossless vCard detail/download metadata, explicit system-event roles, edit/delete detail, and source-observation provenance. Add a canonical observation/fingerprint layer where one current row cannot faithfully merge backup and live history.
- **Backup import**: inspect and retain all verified optional columns without turning `message_system_group.is_me_joined` into an unsupported participant claim. Continue isolating malformed optional families.
- **Live normalization**: retain Baileys `author`/affected-participant roles; accept numeric and named stub types; decode JSON participant parameters; capture subject/description/settings, promotion/demotion, number-change variants, and richer location fields.
- **Repository/API**: add focused loopback-only message-detail and vCard-download routes. General thread DTOs remain compact for performance; status, diagnostics, warnings, and logs remain content-free.
- **Client**: add compact structured cards and accessible detail dialogs/expanders without changing stored link-preview behavior or citation ownership.
- **Merge behavior**: canonical facts use message identity when available and semantic fingerprints otherwise; source observations remain independently auditable. Non-null complementary fields enrich, older observations do not erase newer state, and distinct live-location samples remain ordered rather than collapsed.
- **Testing**: cover SQLite/in-memory parity, backup/live convergence in both arrival orders, anchor replacement, identity-role correctness, vCard downloads, rich location fields, metadata-only edit placeholders, deletion/transcript dialogs, link-preview regressions, accessibility, and privacy canaries proving full details stay local.
- **Dependencies/order**: remains downstream of `episode-contract-v2`, before `historical-backfill`, and before person-model, retrieval, and knowledge-graph consumers that depend on these facts.
