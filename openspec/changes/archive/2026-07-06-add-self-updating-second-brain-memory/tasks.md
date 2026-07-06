## 1. Configuration And Storage

- [x] 1.1 Add memory configuration defaults for private memory root, Codex session path, provider enabled state, consolidation cutoff behavior, evidence pack limits, and query limits.
- [x] 1.2 Add SQLite schema and migrations for memory runs, source windows, evidence packs, page revisions, citations, validation issues, and job locks.
- [x] 1.3 Add generated memory paths to doctor and cleanup awareness without deleting committed memory by default.
- [x] 1.4 Add repository interfaces and SQLite implementations for memory run state, source-window lookup, citation resolution, page revision commits, and stale-page marking.

## 2. Evidence And Citation Pipeline

- [x] 2.1 Implement archive message selection for default REM windows, explicit manual windows, and per-chat source bounds.
- [x] 2.2 Implement evidence pack construction with stable citation labels, token/message limits, sender metadata, chat metadata, and no default body logging.
- [x] 2.3 Implement structured memory output schemas for page revisions, claims, citations, summaries, and validation issues.
- [x] 2.4 Implement citation validation that rejects unknown citation labels, citation-free durable claims, out-of-window references, and malformed page metadata.
- [x] 2.5 Implement atomic commit of Markdown page files, sidecar metadata, citation maps, and SQLite page revision records.

## 3. Codex Provider

- [x] 3.1 Add an optional model-client boundary for memory generation and query synthesis.
- [x] 3.2 Wire a Codex provider adapter around the sibling `gpt-oauth-client` package with local session storage under the private workspace.
- [x] 3.3 Add explicit CLI setup and status commands for enabling the Codex provider, authenticating, refreshing sessions, and disabling remote model use.
- [x] 3.4 Ensure Codex requests use `store: false`, high-reasoning options where supported, selected evidence only, and privacy-safe errors.
- [x] 3.5 Add doctor checks for optional provider availability and local session status without printing tokens, prompts, message bodies, or raw model output.

## 4. Consolidation Runner

- [x] 4.1 Implement `memory-rem` or equivalent CLI command for default completed-window consolidation.
- [x] 4.2 Implement manual consolidation CLI options for explicit start/end bounds, selected chats, dry-run evidence preview, resume, status, validate, and rebuild.
- [x] 4.3 Implement job locking so scheduled or repeated invocations cannot overlap.
- [x] 4.4 Implement resumable run behavior across evidence preparation, model generation, validation, and commit phases.
- [x] 4.5 Implement idempotent rerun behavior for already committed source windows.
- [x] 4.6 Record privacy-safe run totals, warnings, failure summaries, and validation issue counts.

## 5. Memory Query

- [x] 5.1 Add retrieval over committed memory pages, citation metadata, and page indexes.
- [x] 5.2 Add short-term archive retrieval for messages newer than the relevant committed consolidation cutoff.
- [x] 5.3 Implement query merge behavior that labels long-term memory evidence separately from short-term archive evidence.
- [x] 5.4 Implement answer citation formatting that resolves every factual claim to exact messages or memory claims with exact message citations.
- [x] 5.5 Add local refusal or retrieval-only behavior when remote answer synthesis is not enabled.
- [x] 5.6 Add citation inspection helpers for opening cited chats and nearby messages from CLI/API consumers.

## 6. API And UI Surfaces

- [x] 6.1 Add local API endpoints for memory status, run start/resume, run inspection, validation, query, and citation resolution.
- [x] 6.2 Add minimal UI status surfaces for memory readiness, latest REM run, provider setup state, and privacy warnings.
- [x] 6.3 Add local UI affordances for running memory consolidation manually and opening citation context from answers.
- [x] 6.4 Keep first implementation scheduler-ready by making REM commands idempotent and externally invocable without OS-specific scheduling.

## 7. Tests And Documentation

- [x] 7.1 Add synthetic archive fixtures covering multi-chat memory windows, current-day short-term messages, deleted/stale citations, and re-import replacement.
- [x] 7.2 Add unit tests for evidence pack construction, source-window selection, idempotent reruns, citation validation, and stale citation detection.
- [x] 7.3 Add integration tests for manual REM run, resume after interruption, provider-disabled refusal, and query across long-term plus short-term evidence.
- [x] 7.4 Add privacy tests proving default logs exclude message bodies, prompt bodies, raw model output, tokens, and raw rows.
- [x] 7.5 Update architecture, roadmap, importing/data model, security/privacy, and testing docs for the private memory store and Codex opt-in workflow.
- [x] 7.6 Run `npm test` and `npm run doctor`; run `npm run build` if API/UI or production serving behavior changes during implementation.
