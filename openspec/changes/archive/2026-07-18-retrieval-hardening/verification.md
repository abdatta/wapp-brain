# Retrieval Hardening — Real-Archive Verification (2026-07-17)

Environment: isolated copy of the real archive (326,877 messages, `better-sqlite3` online backup of `archive-signal-real-check-20260714-162607.sqlite`), served by a sandboxed server (`APP_PORT=3641`, scratch `WAPP_WORK_DIR`, empty Baileys auth dir so live sync stayed off). The user's working DB and WhatsApp session were never touched. All checks ran via the HTTP API and the served client UI (in-app browser); output captured as counts/tiers only, never message content.

## 6.1 Boot migration + automatic rebuild

- Boot on the pre-change copy detected the legacy 3-column FTS structurally, recreated the 5-column table + triggers + `messages_fts_vocab`, added `messages.resolved_sender`/`resolved_context`, seeded `brain_term_aliases`, stamped `needs_rebuild`, and **auto-started the background rebuild** (`[search] index needs a rebuild (326,877 messages) — starting the background build automatically`).
- Rebuild: **326,877 messages in 86.2s**, chunked with event-loop yields — `/api/search/status` answered instantly mid-build (`running`, 166k/327k observed) and searches refused honestly (`SEARCH_INDEX_NOT_BUILT`) until `ready`.
- Restart after completion: index came up `ready` immediately, no re-migration, no second rebuild (idempotent).

## 6.2 Checkpoint gates

- **Typo'd multi-word queries** (previously zero rows, endorsed by `totalMatches: 0`):
  - `dinner tomorow plan` → `partial` tier 4, 2,696 matches, top hits covering 2/3 terms with coverage chips.
  - `birthday partyy plan` → `partial` tier 2 (dropped `plan`), 1 match ("partyy" exists in the archive — df-guided drop chose correctly).
  - UI banner renders ("No exact matches — showing the best results…"), per-hit `2/3 terms` chips, highlighted snippets, zero console errors, all API calls 200.
- **"nhi" finds "nahi"**: `nhi` → **4,659** matches, `exact` tier; `nahi` → **4,659** (identical union — bidirectional alias expansion live on the real archive); variant terms highlight in snippets.
- **Rename** (user path `POST /api/persons/rename` on a contact with 9,342 sent messages):
  - Before: old first name sender-scoped 9,039 matches; new token `zzverify` 0.
  - Rename returned in 4.4s (chunked in-server repair, zero model calls — no provider configured in the sandbox).
  - After: `zzverify` → **9,100** matches `exact` (sender + mention recompute), hits from the renamed sender flagged `senderOnlyMatch`; old name sender-scoped dropped to 12 (body-content mentions of the old name, correctly retained).
- **Ranked-OR ordering fix found and applied during verification**: raw BM25 let a rare-term single-match outrank rows covering more query terms (observed top hit at 1/3 coverage). Fixed: partial-OR tier sorts by term coverage first, then score, in both repositories; regression test added; re-verified on the real archive (top hits 2/3).

## 6.3 Eval recall delta (golden set v1, hash 2e789432, 15 queries — model-free recall run)

Baseline `7ca7c08a` (2026-07-16, pre-change) → post-change run `17df8254`:

| Class | recall@5 | recall@10 | recall@20 |
|---|---|---|---|
| code-mixed | 66.7 → **100** | 66.7 → **100** | 66.7 → **100** |
| commitment | 66.7 → **83.3** | 66.7 → **83.3** | 66.7 → **100** |
| paraphrase | 0 → **16.7** | 0 → **16.7** | 0 → **16.7** |
| person | 100 → 100 | 100 → 100 | 100 → 100 |
| temporal | 66.7 → 66.7 | 66.7 → 66.7 | 66.7 → 66.7 |
| **Overall** | **60 → 73.3** | **60 → 73.3** | **60 → 76.7** |

Zero-hit queries halved (6 → 3); the remaining misses are pure-semantic paraphrase/temporal gaps with no term overlap — explicitly the deep path's territory (`brain-retrieval-pipeline`, #12), out of scope here by design.

## Suite

`npm test` 42 files / 430 tests green (including the new `tests/retrieval-hardening.test.ts` and the intentionally-updated assertions in `tests/search.test.ts` and `tests/demask-contact-labels.test.ts`); `tsc` + `vite build` clean.
