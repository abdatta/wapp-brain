## REMOVED Requirements

### Requirement: Private Memory Store
**Reason**: Superseded by the brain. The private-workspace rule is carried forward and strengthened by `brain-assimilation` (Markdown Projection) and the privacy requirements across the new brain capabilities.
**Migration**: `.wapp-brain/memory/` is deleted; derived knowledge is rebuilt under `.wapp-brain/brain/` via the brain rebuild command.

### Requirement: Explicit Remote Model Opt-In
**Reason**: Re-specified stronger in `brain-model-provider` (Explicit Remote Opt-In), now per-provider and covering the Claude CLI as well as Codex.
**Migration**: Existing `provider.json` opt-in state is discarded; the user re-enables a provider explicitly.

### Requirement: Codex High Reasoning Adapter
**Reason**: Re-specified in `brain-model-provider` (Codex Adapter Parses Responses, Provider Interface); the old adapter discarded model output and had no formal interface.
**Migration**: Codex OAuth session material is reused if present; the adapter is rewritten behind the provider interface.

### Requirement: Consolidation Source Windows
**Reason**: Window-ledger coverage is replaced by per-chat watermarks and a durable task queue in `brain-assimilation` (Watermark Coverage Truth, Durable Task Queue), which are correct across crashes and downtime without window bookkeeping.
**Migration**: `memory_source_windows` is dropped; coverage restarts from watermarks during brain rebuild/backfill.

### Requirement: Resumable Memory Runs
**Reason**: The run-ledger resume model was never implemented; resumability is now structural via the task queue in `brain-assimilation` (Durable Task Queue, Offline Catch-Up).
**Migration**: `memory_runs`/`memory_evidence_packs` are dropped; `brain_runs` and `brain_tasks` replace them.

### Requirement: Cited Wiki Page Revisions
**Reason**: Carried forward and strengthened in `brain-assimilation` (Cited Episode Extraction, Quality Regression Guard): citation labels become stable message keys and revision commits gain claim-set regression guards.
**Migration**: Old pages and revisions are deleted with the memory store; equivalent cited documents regenerate from the archive.

### Requirement: Citation Resolution
**Reason**: Re-specified in `brain-retrieval` (Progressive Disclosure Layers) with media resolution added.
**Migration**: `memory_citations` is dropped; `brain_claims`/`brain_citations` replace it with message-key labels.

### Requirement: Evidence Pack Privacy
**Reason**: Carried forward in `brain-assimilation` (Evidence Selection Policy) and `brain-model-provider` (Provider Privacy).
**Migration**: None needed; the same no-logging rules apply to the new pipeline.

### Requirement: Scheduler-Ready REM Command
**Reason**: Replaced by an actual scheduler in `brain-assimilation` (Consolidation Lifecycle And Decay, Offline Catch-Up); manual CLI runs remain but are no longer the only trigger.
**Migration**: `memory:*` npm scripts are removed; `brain-*` commands replace them.

### Requirement: Memory Audit And Rebuild
**Reason**: Re-specified in `brain-assimilation` (Staleness Propagation, Markdown Projection) and the brain validate/rebuild commands.
**Migration**: `memory-validate` is replaced by brain validation; rebuild regenerates all derived data from the archive.
