## REMOVED Requirements

### Requirement: Layered Memory Retrieval
**Reason**: Superseded by `brain-retrieval` (Progressive Disclosure Layers, Fast Query Path): two layers (long-term pages, short-term messages) become four (overview, pages, episodes, messages) with indexed ranking instead of LIKE scans.
**Migration**: `/api/memory/query` is removed; consumers use the brain query API.

### Requirement: Answer Citations
**Reason**: Carried forward and strengthened in `brain-retrieval` (Progressive Disclosure Layers) and `brain-assimilation` (Cited Episode Extraction).
**Migration**: Citation shapes move to the brain DTOs with stable message-key labels.

### Requirement: Source Layer Labels
**Reason**: Carried forward in `brain-retrieval` (Fast Query Path — layer labels on every hit), extended from two layers to four.
**Migration**: Consumers read the `layer` field on brain query hits.

### Requirement: Follow-Up Inspection Paths
**Reason**: Carried forward in `brain-retrieval` (Progressive Disclosure Layers) and `brain-mcp-access` (Brain Tool Surface): every hop resolves one layer deeper down to exact messages with context.
**Migration**: Deep links now target thread-view positioning from any citation.

### Requirement: Query Privacy Defaults
**Reason**: Carried forward in `brain-retrieval` (Query Privacy Defaults) with the fast/deep split making the local-only default structural.
**Migration**: None needed; fast path is local by construction, deep path inherits provider opt-in.

### Requirement: Short-Term Cutoff Awareness
**Reason**: Superseded by coverage qualification in `brain-retrieval` (Coverage-Qualified Answers): per-chat watermark coverage replaces the single consolidation-cutoff notion.
**Migration**: Consumers read `coverage`/`freshness` metadata on every response.
