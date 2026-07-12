# MCP Agent Surface

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The north-star criterion — a weak model extracts real value, a strong model does magic — is decided at this surface, and the original Phase 5 plan missed it on both ends: all eight planned tools are noun-shaped (browse), so weak consumers must orchestrate multi-hop assembly they will fail at; deep mode hands agents a `deepJobId` no tool can redeem; strong models get no bulk claim access; MCP sessions can spend the shared model budget with no spend authority; and the acceptance gate tests only strong clients. This change ships the MCP server with an answer-shaped primary tool, redeemable deep mode, honest spend controls, and a weak-model verification gate.

## What Changes

- **`brain_ask`** (the headline): question in, bounded cited answer kit out — a deterministic zero-LLM pipeline: resolve person/chat/time filters via entity lookup (returning disambiguation candidates on ambiguity), run the scoped fast query, pull claims from top-K episodes, dedupe, group by kind, sort by recency, return grouped cited claims plus the coverage verdict and gaps. Composition of existing machinery, no new intelligence.
- **Core tools**: `brain_overview`, `brain_search`, `brain_page`, `brain_entity`, `brain_episode`, `brain_messages`, `brain_timeline`, `brain_claims`, `brain_grants_list` — all thin wrappers over the loopback HTTP routes, passing through the pagination/detail parameters the routes already have; tool descriptions instruct keyword-style queries (2–4 terms), the one prompt we control on every consumer.
- **Deep mode redeemable**: synchronous deep on expansion-cache hit, else `brain_deep_result(jobId, waitMs)` long-polling the query job — no more unredeemable handles.
- **Grants + spend authority**: grant kinds (chat/person/time-window/search/all) with `max_layer` and expiry as planned, *plus* deep mode gated behind a `deep` capability with a per-grant call allowance; default sessions are fast-path-only and L0–L2; `purpose='mcp-deep'` ledger rows and a per-purpose usage breakdown in the Brain panel so agent spend is attributed, not just visible.
- **Audit**: every tool-backed request logged (tool, scope, ids/counts — never bodies), reviewable; person-scope values are node ids or canonical JIDs, congruent with query scoping — free-text person scoping rejected with the needs-entity-resolution shape.
- **Weak-model gate**: acceptance requires a Haiku-class client to answer "what did X and I decide about Y" with citations in ≤2 tool calls via `brain_ask`, alongside the strong-client pass.
- **Checkpoint**: connect Claude Code with a chat-scoped grant — cited answer in ~2 calls; connect a Haiku-class client — same question succeeds through `brain_ask`; review the audit log and the attributed deep spend; a grant-less session hitting deep mode gets the needs-grant error, not silent budget drain.

## Capabilities

### Modified Capabilities

- `brain-mcp-access`: rewritten — `brain_ask` as the primary tool, `brain_claims`/`brain_timeline`/`brain_deep_result` added, spend-authority grants, per-purpose ledger attribution, pagination passthrough, weak-model acceptance scenario.

## Impact

- **Schema**: `brain_grants`, `brain_access_log`, deep-allowance fields; ledger purpose conventions.
- **Code**: `src/server/mcp/server.ts` (stdio, `@modelcontextprotocol/sdk`, loopback HTTP client), grant enforcement middleware on `/api/brain/*`, grant CLI + minimal UI list, Brain panel per-purpose usage line.
- **Docs**: SECURITY_AND_PRIVACY.md (grants, audit, spend), README MCP section.
- **Tests**: default-session scoping, grant boundaries + expiry, deep gating + attribution, ambiguous-entity candidates, audit completeness, token-lean response shapes, privacy canary on audit rows.
- **Depends on**: `brain-retrieval-pipeline` (routes to wrap), `two-level-person-model` (person disambiguation shapes). `people-management-ui` is a soft dependency (grants list UI can share surface).
