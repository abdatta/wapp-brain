# Memory Teardown And Docs

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Sonnet.**

## Why

The legacy `memory_*` subsystem was declared superseded when `build-the-brain` was proposed, and its model-generation path is already gone (consolidation is extractive-only; the codex opt-in only manages the shared OAuth session). Once the brain reaches read parity (`brain-retrieval-pipeline` replaces the memory panel's function), keeping the dead subsystem costs maintenance, schema surface, and confusion. This is the closeout: remove it wholesale, and bring the documentation set in line with what was actually built across the whole chain.

## What Changes

- **BREAKING**: `src/server/memory/` write paths, `/api/memory/*` routes, `memory:*` npm scripts removed; `memory_*` tables dropped; `.wapp-brain/memory/` deleted by cleanup; memory panel remnants removed from the client; `brain rebuild` is the sanctioned regeneration path.
- **Shared OAuth session management** relocated from the memory opt-in to the brain provider settings where it actually belongs.
- **Docs pass**: ARCHITECTURE.md (brain data flow, modules, final table list), SECURITY_AND_PRIVACY.md (provider opt-ins, `.wapp-brain/brain/`, grants/audit/spend), TESTING.md (eval methodology), LIMITATIONS.md (projection not writable, paraphrase-recall bounds, backfill pace), ROADMAP.md, README.md (brain + search + MCP sections replacing memory), AGENTS.md commands.
- **Backlog retirement**: absorbed todos (`archive-full-text-and-semantic-search`, `mcp-chat-reader-server`, `self-updating-memory-schedule`) retired with pointers; the evidence-selection position noted on `thread-view-signal-vs-noise`.
- **Full verification**: `npm test`, `npm run doctor`, `npm run build`, manual acceptance on the real archive.
- **Checkpoint**: no `memory_*` table, route, or script remains; docs describe the shipped system; the full suite passes on the real archive.

## Capabilities

### Modified Capabilities

- `self-updating-second-brain-memory`: removed (already superseded by `brain-assimilation` + `brain-model-provider`; this executes the removal).
- `cited-memory-query`: removed (already superseded by `brain-retrieval`).

## Impact

- **Removed code**: `src/server/memory/`, memory routes/scripts/panel, `memory_*` DDL and mirror methods, `tests/memory.test.ts` (replaced by brain suites).
- **Docs**: the six-document pass above.
- **Depends on**: `brain-retrieval-pipeline` (read parity), `mcp-agent-surface` (README/security docs describe the final surface). Backfill need not be complete — coverage honesty is the designed answer to partial assimilation.
