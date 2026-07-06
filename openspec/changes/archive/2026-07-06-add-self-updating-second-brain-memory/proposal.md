## Why

Wapp Brain already has the archive and live-store foundation needed to become a private second brain, but it does not yet have a durable long-term memory layer that can update itself from new WhatsApp activity. The next step is to turn chats into a cited Karpathy-style second-brain wiki that can be rebuilt on demand or incrementally consolidated on a schedule while preserving exact links back to source messages.

## What Changes

- Add a local-only memory consolidation pipeline that reads archived WhatsApp messages, groups recent deltas into evidence packs, and asks a high-reasoning Codex-backed model to update a private wiki-style long-term memory store.
- Add a REM-sleep style daily consolidation mode that commits completed windows of chat history into long-term memory while leaving current-day messages available as short-term context.
- Add manual CLI controls for running, previewing, resuming, and inspecting consolidation jobs, with a scheduler-ready job model for later interval-based execution.
- Store generated memory pages, summaries, indexes, run ledgers, prompts, and citation maps under the private workspace by default.
- Require every durable memory claim to carry citations to exact archive message IDs, chat IDs, sender metadata, and timestamps so the UI, CLI, MCP servers, and future search APIs can reopen the original context.
- Add a local Codex LLM adapter that uses the sibling `gpt-oauth-client`/Codex OAuth flow as an explicit opt-in dependency, stores Codex session material locally, refreshes tokens locally, and avoids logging prompts or message bodies by default.
- Add read/query behavior that combines committed long-term memory with short-term uncommitted archive messages so answers can use both stable memory and today's latest chats.
- Add privacy and safety checks that refuse remote model consolidation unless the user explicitly opts in and acknowledges that selected WhatsApp-derived content will be sent to the configured model provider.

## Capabilities

### New Capabilities
- `self-updating-second-brain-memory`: Defines local memory consolidation, durable cited wiki artifacts, run tracking, scheduler-ready REM consolidation, and Codex-backed generation controls.
- `cited-memory-query`: Defines retrieval and answer behavior across committed long-term memory plus short-term current archive messages, including citation requirements and fallback inspection paths.

### Modified Capabilities
- None.

## Impact

- Affected CLI/API code: new memory consolidation commands, job status endpoints, and query endpoints.
- Affected storage: new archive tables or sidecar files for memory runs, memory source windows, page metadata, citation maps, and short-term checkpoint state.
- Affected private files: generated wiki pages, summaries, indexes, prompts, model outputs, and Codex OAuth session files under `.wapp-brain/memory/` by default.
- Affected dependencies: optional local dependency on the sibling `gpt-oauth-client` package or a narrow adapter around it.
- Affected docs: security/privacy guidance, roadmap, architecture, and operator instructions for manual and scheduled consolidation.
- Test impact: synthetic archive fixtures for consolidation, citation validation, idempotent reruns, privacy-safe logging, and query behavior across long-term plus short-term stores.
