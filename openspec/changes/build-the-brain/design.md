## Context

The archive layer is done and trustworthy: canonical `(chat, key_id)` message identity with LID merges, complete media archival, typed message interpretation (`{label, reason}` server-side), live sync with evidence-based gap recovery, ~325k messages / ~3.7k chats and growing. The memory layer above it is scaffolding: `memory_*` tables and a REM run exist, but generation is extractive-only (the Codex adapter discards the model response), citation labels are ambiguous positional `m1..mN`, retrieval is an unranked `LIKE` scan, there is no global search index, no scheduler, no graph, and no agent access.

This design was produced by a multi-agent study: six parallel deep-readers over the codebase, three independent architecture proposals (assimilation-first, retrieval-first, graph-first), and a two-persona judge panel (skeptical operator, MCP agent consumer). The judges split on winners but converged on the same hybrid, which this document specifies.

Constraints: i9/16GB laptop, no GPU; $0/month target ($10 hard cap); no embedding APIs; Markdown-file substrate preferred; local-first absolute by default with per-feature remote opt-in; exact citations non-negotiable; better-sqlite3 is synchronous on the event loop (batch + `setImmediate` yields are the house mitigation); any op ≥1s reports progress; no backward-compat constraints.

## Goals / Non-Goals

**Goals:**

- A brain that keeps itself current for months without babysitting: coverage truth from per-chat watermarks, catch-up on boot, honest degraded states, visible status.
- Progressive disclosure as a contract, not a folder convention: overview → pages → episodes → exact cited messages, each layer resolvable from the one above in one hop.
- Semantic-quality search without embeddings: FTS5 + resolved identity text + LLM query expansion + graph traversal, with a pure-SQL fast path (<2s) and a job-based deep path.
- Every durable claim cites exact archive rows; agents can always check answers.
- Token spend bounded by construction (per-call budgets, per-day ledger, hard block states), not by hope.
- All meaning server-side; UI, CLI, and MCP consume identical DTOs.
- **Observability as a contract** (gate feedback, 2026-07-09): every operation ≥1s shows async progress in the UI wherever the user currently is; every failure/interruption surfaces with a privacy-safe reason and a retry path, survives page reloads and server restarts, and is mirrored to the server console (counts/durations only). A job that fails and quietly returns its UI to the idle state is a defect.

**Non-Goals:**

- No embeddings/vector index in this change (a local CPU rerank is a data-gated follow-up, decided after deep-search recall is measured).
- No hosted services, no cloud sync, no writes to WhatsApp.
- No user-editable vault semantics: `.wapp-brain/brain/` Markdown is a *projection*; Obsidian edits to it are not read back (documented limitation).
- No migration of existing `memory_*` data; the brain rebuilds from the archive.
- Media content understanding (image captioning, transcription) is out of scope; media messages contribute their interpretation labels only.

## Decisions

### D1. One brain, three tiers, SQLite-authoritative with Markdown projection

- **Hot tier** = the archive itself + `messages_fts` + `message_mentions`. Zero LLM. Searchable instantly.
- **Episodic tier** = `brain_episodes` + cited digest documents: per-chat conversation segments generated nightly/on-volume by the LLM.
- **Semantic tier** = knowledge graph (`brain_nodes`/`brain_edges`) + entity/topic/chat pages + `overview.md`, consolidated weekly from episodes (never from raw messages — this is what bounds cost at 325k-message scale).

Claims, citations, nodes, and edges live in SQLite (source of truth, transactional, joinable to `messages`). The Obsidian-compatible vault under `.wapp-brain/brain/` (YAML frontmatter, `[[wikilinks]]`, `^claim-N` anchors) is regenerated deterministically from SQLite after each run. *Why*: the judge panel's strongest finding — after 100 LLM rewrite cycles, free-floating MD files rot invisibly; a deterministic projection cannot rot independently, and a bad generation is detectable as a claim-set diff (D8). *Alternative rejected*: MD-as-source-of-truth (retrieval-first design) — keeps files human-editable but makes coherence unverifiable and graph queries expensive.

### D2. Coverage truth = per-chat watermarks, advanced only on commit

`brain_chat_watermarks(chat_source_id PK, assimilated_through_ms, pending_visible_count, last_episode_at)`. Every episode commit advances its chat's watermark in the same transaction. Nothing depends on a schedule having fired: on startup, a catch-up audit enqueues episode tasks for every uncovered (chat, window) between watermark and the last completed UTC-anchored day. Laptop asleep for two weeks → the backlog drains rate-limited (default 30 LLM calls/hour, 200/day) with live progress. *Why*: schedule-based coverage (retrieval-first design) silently lies after downtime; watermarks make "what has the brain seen" a queryable fact that retrieval can attach to every answer (D7). Windows are UTC-anchored with the run's IANA timezone recorded in `brain_runs` — local-day bucketing across DST/timezone changes was a shared flaw all three designs missed.

### D3. Durable task queue cloned from `media_download_queue`

`brain_tasks(id, kind, payload_json, dedupe_key UNIQUE, status, attempts, next_attempt_at_ms, priority)` with kinds `episode`, `rollup`, `overview`, `merge_adjudicate`, `reindex`, `project_pages`. `dedupe_key` = sha256(chat + window bounds + first/last message key) makes packs idempotent; claim-due/backoff (30s→1h, 8 attempts)/priority semantics copied from the proven media queue. A crashed run needs no resume logic — the next tick re-claims pending tasks. *Why*: the media queue is the repo's most battle-tested pattern; the old `memory_source_windows` single-shot model had ledger tables but no actual resumability.

### D4. Scheduling: a brain pass appended to the recovery tick, plus triggers

The `BrainScheduler` runs as the last pass in the existing recovery-tick pipeline (after media, preserving documented starvation order), gated by a `brain` job lock. Triggers: **nightly** (default 03:00 local, env `WAPP_BRAIN_CUTOFF_HOUR`) for all chats with pending visible messages; **volume** (a chat crossing 50 pending visible messages *and* quiet ≥30min) for intra-day episodes on busy chats; **significance gate** — chats with <5 pending visible messages accumulate into a weekly mini-episode instead of burning a nightly call (essential at 3.7k chats). Weekly (Sunday 04:00): rollups, overview, merge detection, salience recompute, projection GC. Monthly: episode compression. Runs are job objects (import-jobs template: status lifecycle, typed progress events, cancellation) surfaced over `/api/brain/runs/:id` and SSE. *Position taken*: `visibleExchangePredicate` (the chat-list "conversation only" definition) governs **evidence selection**; system/reaction/encrypted-update rows are FTS-indexed and citable but never enter LLM evidence packs.

### D5. Episode extraction contract

Evidence packs: ≤150 visible-exchange messages / ~6k input tokens per call, split at ≥90-minute silence gaps; text is the *resolved* form (display-name chain, `@mentions` substituted, interpretation labels for media, quoted-message stitching) while citations carry raw keys — the derived-vs-raw split the identity-aware-inference decision mandates. The LLM returns strict JSON: `{summary, claims:[{text, kind: fact|decision|commitment|question|event, citations:[source_message_key], entities:[{kind, name, jid?}]}], topics:[...]}` with the prompt offering the 50 nearest existing topic titles to converge vocabulary. Citation labels are prompt-local aliases resolved to `source_message_key`s before commit — the ambiguous global `m1..mN` scheme dies here. Validation: every claim cites ≥1 key present in the pack; unknown key → one retry with the error appended → task `failed` + validation issue + extractive fallback digest (coverage never blocks on model quality). Commit is one transaction: document revision + claims + citations + graph node/edge upserts + FTS + watermark advance.

### D6. Knowledge graph: typed but lean

Node kinds: `person`, `chat`, `topic`, `event`, `commitment`, `fact` (with `payload_json` for commitment holder/due/status, event dates, person canonical JID) — the graph-first design's insight that decisions/promises must be first-class queryables, without its 11-kind sprawl. Edge kinds: `participates_in`, `mentions`, `about`, `involves`, `derived_from`, `related_to`, `alias_of` with weight + first/last-seen. Identity is `node_id` + immutable slug; titles are display metadata; merged nodes become redirect stubs (`status='merged', merged_into=...`) so wikilinks and MCP-held ids never dangle. Person nodes key on canonical JID and **auto-merge deterministically** when `mergeIdentity` collapses identities (repository hook). Non-deterministic duplicates (alias collision, >60% episode co-citation) become capped weekly `merge_adjudicate` LLM tasks (~1.5k tokens each). Salience = `log(1+citations) × log(1+evidence_days) × exp(-days_since_evidence/90)`, recomputed weekly; below threshold → `dormant` (hidden from overview/L1, still searchable). Decay hides, never deletes; episodes and citations are permanent.

### D7. Retrieval: four layers, fast/deep split, coverage-qualified

Layers: **L0** overview (top-salience people/topics, open commitments, freshness + coverage stats) → **L1** node cards / pages → **L2** episode digests with claims → **L3** exact messages ±context via citation resolution (media resolves through `media_assets`). One server-side pipeline returns structured `BrainQueryResult` DTOs; UI, CLI, and MCP render the same shapes.

**Fast path** (every query, target <300ms, no LLM): FTS5 BM25 over `brain_docs_fts` (title=4, summary=2, body=1) and `messages_fts` (resolved_text=3, body=2, caption=1), merged with recency decay (half-life 90d, docs exempt), entity boosts via `message_mentions`/sender match, graph-proximity boosts, layer labels on every hit. **Deep path** (explicit `mode:'deep'` or auto-suggested when fast results are weak): returns fast results immediately plus a `deepJobId`; the job runs LLM query expansion (~500 tokens, cached 30 days in `brain_query_cache`) → re-query FTS with expanded terms → spreading activation ≤2 hops over `brain_edges` (damped, capped at 200 nodes, pure SQL) → optional synthesis call whose every sentence must cite gathered keys (validated like episode output; uncited sentences dropped). Every result set carries `coverage` (watermark % for the queried scope) and `freshness` (FTS watermark, last episodic/semantic run) so an agent never presents an assimilation gap as an absence of evidence.

### D8. Quality-regression detection (the anti-rot invariant)

Semantic pages are whole-document LLM rewrites — the highest-rot vector. Before committing any rollup revision: claims are diffed against the prior revision's claim set; a commit is rejected (task `failed`, alert raised) if citation count or claim count drops >30% without a matching compression/merge job, if the document shrinks >50%, or if any required section disappears. Prior revisions are retained; `brain rollback <doc>` restores one mechanically. *Why*: judges flagged that citation validation checks existence, not sanity — one bad-but-cited generation would otherwise propagate up tiers silently.

### D9. Provider boundary with health contract

```ts
interface BrainModelProvider {
  name: "claude-cli" | "codex" | "extractive";
  generateStructured(req: { system: string; user: string; schema: object;
    maxOutputTokens: number }): Promise<{ json: unknown; usage: TokenUsage }>;
}
```

`claude-cli` spawns the Claude Code CLI as a child process in non-interactive single-turn JSON mode (`claude -p --output-format json --max-turns 1 --tools ""`), never blocking the event loop; cwd pinned to an empty sandbox; $0 marginal on the user's subscription; treated as a remote provider → same explicit opt-in gate as Codex. The invocation command is configurable (`WAPP_BRAIN_CLAUDE_CMD`): on this machine the CLI lives only inside WSL2, so the default Windows invocation is a WSL bridge — `wsl.exe -e bash -lc "claude -p …"` — with the prompt written to stdin and JSON read from stdout. Stdin delivery is mandatory regardless of bridge (evidence packs exceed Windows command-line length limits) and sidesteps Windows↔WSL path translation entirely since no file paths cross the boundary; the sandbox cwd is a WSL-side temp dir. A future native-Windows CLI install needs only a config change. `bash -lc` (login shell) is required so nvm/npm-installed CLI paths resolve; the provider health probe (below) runs this exact invocation end-to-end at startup so a broken bridge is a visible degraded state, not a mystery. `codex` wraps the existing `gpt-oauth-client` and actually parses the response. `extractive` is the always-available fallback. **Health**: consecutive-failure counter per provider; after 3 failures the brain enters `degraded` (extractive-only) with a `degraded_since` timestamp visible in `brain_overview`, doctor, and the UI badge, and raises an alert through the autonomous-operation channel — never a silent quality drop. `brain_llm_ledger(day, purpose, calls, input_tokens, output_tokens)` enforces daily caps; exceeding them is a named `BUDGET_EXCEEDED` block, not degradation. Prompts/bodies/model outputs are never logged (existing privacy rules).

### D10. FTS maintenance at ingest, measured

`messages_fts` is a **content-storing** FTS5 table (`unicode61 remove_diacritics 2`, prefix 2,3) kept in sync by **rowid-keyed** triggers on a stored `messages.resolved_text` column, so every write path — imports, live ingest, edits, tombstones, merges, collapses — maintains the index without call-site code; `resolved_text` is recomputed on identity merges (chunked, yielding) and by the reindex job. Backfill is a fully chunked (2k rows, `setImmediate` yields) progress-reporting job that starts from a dropped-and-recreated table. *Why ingest-time*: the search todo's open question is answered by the hot-tier contract — L3 must be searchable the instant a message lands.

**Design revision (Phase 1 gate feedback, 2026-07-09)**: the first build used external-content FTS5. On the real archive it corrupted itself immediately — external-content deletes must replay the exact previously-indexed values, and rows that predate the index (325k of them) violate that by construction ("database disk image is malformed" on the first reindex chunk, plus silent UI failure). Content-storing FTS with rowid-keyed deletes makes triggers safe in every index state (deleting a missing rowid is a no-op), removes the blocking atomic `rebuild` finalize, and lets the rebuild heal any prior corruption by recreating the table. Cost: message text duplicated inside the private archive file (~+15% file size). Measured on the real archive: full rebuild of 325,564 messages in 31s (~10k msg/s, ~200ms per chunk), search 25ms.

**Benchmark result (Phase 1, task 1.6, 2026-07-09, this laptop)**: 50k synthetic messages in 500-row chunks — 3,697 msg/s with full search maintenance vs 7,932 msg/s without (≈2.1× on the message-upsert step alone). Decision: **keep ingest-time maintenance**. Absolute throughput remains ~40× above the heaviest observed history-sync burst rates, chunked yields keep the event loop responsive, and the win is structural (no dirty-queue drift states). Search latency at 50k rows: 19–88ms per query (candidate pool 240); full reindex of 50k rows: 0.76s (extrapolated well under a minute for 325k including derived-text recompute). The dirty-rowid fallback stays documented but unimplemented.

### D11. MCP as a separate stdio process over loopback HTTP

`src/server/mcp/` runs `wapp brain mcp` (stdio transport, `@modelcontextprotocol/sdk`), disabled by default, talking only to `127.0.0.1` HTTP routes — it never opens the SQLite file (single-writer safety) and inherits `publicErrorMessage` hygiene and identity resolution. Tools: `brain_overview`, `brain_search`, `brain_page`, `brain_entity`, `brain_episode`, `brain_messages`, `brain_timeline`, `brain_grants_list`. Default session scope: L0–L2 only; L3 raw messages require an explicit grant. `brain_grants(grant_id, kind: chat|person|time_window|search|all, value, max_layer, expires_at)` managed via CLI/UI; every call filtered through active grants and recorded in `brain_access_log` (tool, scope, ids/counts — never bodies) so the user can review exactly what an agent saw.

### D12. Backfill honesty

Historical assimilation of 325k messages ≈ 3–4k chat-day packs. Default drain (20 packs/day, idle) takes months; that is stated up front, and it is fine — search (hot tier) works from day one, and coverage metadata keeps answers honest meanwhile. `brain backfill --turbo` runs attended sessions (user-set call rate, progress bar, resumable, priority newest-first so recent history assimilates first). The judges' "querying a partially-built graph" concern is handled by D7's coverage qualification rather than by pretending backfill is fast.

## Risks / Trade-offs

- **[`claude -p` is an unversioned, load-bearing seam — doubly so through the WSL2 bridge (wsl.exe availability, WSL boot latency on first call, login-shell PATH resolution)]** → health contract (D9): startup end-to-end probe of the exact invocation, degraded-state visibility, extractive fallback, consecutive-failure alerts; provider adapter isolated in one file; Codex as a second remote option; command fully configurable for a future native install.
- **[Paraphrase recall without embeddings is structurally weaker]** → deep path (expansion + graph traversal + synthesis) covers most cases at 2 LLM calls per novel query; recall measured in Phase 4 acceptance ("renting in Lisbon" class queries); local CPU embedding rerank remains a data-gated follow-up decision, deliberately out of scope.
- **[Hyperactive group chats starving the nightly budget]** → per-chat call caps within the nightly budget + significance gate + volume trigger draining busy chats intra-day; ledger makes starvation visible (`skipped_for_budget` counts in run summaries).
- **[Episode segmentation mis-splitting interleaved group topics]** → accepted heuristic (silence gaps + size caps); digests are per-chat and cited, so mis-splits degrade elegance, not truth; rollups re-aggregate by topic above episodes.
- **[Entity aliasing beyond JID (same human, two spellings)]** → deterministic JID merges + alias-collision and co-citation detectors + capped LLM adjudication; imperfect by design — unresolved duplicates are visible as candidates, never auto-merged.
- **[FTS write amplification on the hot ingest path]** → Phase 1 benchmark + dirty-queue fallback (D10).
- **[Whole-page rewrites degrading accumulated pages]** → claim-set diff guard + retained revisions + mechanical rollback (D8).
- **[16GB RAM ceiling]** → no resident model, no vector index; FTS5 and graph queries are disk-backed; LLM work is out-of-process; batches bounded.
- **[Windows sleep mid-run]** → task queue + watermarks make interruption free; expired job locks self-clear; startup sweep marks orphaned runs `interrupted`.

## Migration Plan

1. Additive schema first: all `brain_*` tables + FTS land while `memory_*` still exists (schema additivity tests pass on real archives).
2. Brain reaches feature parity (episodes + retrieval), validated on synthetic fixtures and the real archive.
3. Remove `memory_*` write paths, routes, CLI, and tables; delete `.wapp-brain/memory/`; `npm run brain -- rebuild` regenerates everything from the archive. No data migration — derived data is rebuilt, per the `identity_version` precedent.
4. Rollback strategy: phases are independently shippable; Phase 1 (search) has value alone and nothing depends on later phases until they land.

## Open Questions

- Should the volume trigger's thresholds (50 pending / 30min quiet) be adaptive per chat (e.g., percentile of that chat's historical rate) instead of global constants? Start global, revisit with ledger data.
- Does the deep path's synthesis call belong in v1, or should deep mode ship as expansion + traversal only and add synthesis after recall is measured? (Leaning: ship without synthesis first; it is the most token-hungry and least verified step.)
- Grant granularity for MCP search: does a `search` grant expose snippets from otherwise-ungranted chats? (Leaning: no — search results are filtered to granted scopes; a global-search grant is its own explicit kind.)
