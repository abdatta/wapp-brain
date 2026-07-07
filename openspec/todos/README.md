# Behavior Backlog

This directory tracks bugs, investigations, and feature ideas before they are promoted into formal OpenSpec changes.

Keep entries behavior-focused:

- Describe the user-visible expectation, observed behavior, and privacy constraints.
- Avoid naming implementation files, functions, or database internals unless they are part of the behavior contract.
- Prefer synthetic or redacted evidence. Do not include real WhatsApp message bodies, keys, media, raw database rows, or private archive paths.
- When an item becomes ready to build, graduate it into `openspec/changes/<change-id>/` with proposal, design, tasks, and spec deltas.

## Items

| Item | Type | Status | Area |
| --- | --- | --- | --- |
| [Contact And Group Identity Integrity](./contact-and-group-identity-integrity.md) | Feature / bug cluster | Ready to propose | Contacts / identity |
| [Autonomous Laptop Operation](./autonomous-laptop-operation.md) | Feature | Ready to propose | Lifecycle / alerting |
| [Archive Full-Text And Semantic Search](./archive-full-text-and-semantic-search.md) | Feature | Needs specification | Search / retrieval |
| [Self-Updating Memory Schedule](./self-updating-memory-schedule.md) | Feature | Needs specification | Second brain |
| [Thread View Signal Vs Noise](./thread-view-signal-vs-noise.md) | Feature / behavior alignment | Needs specification | Thread view |
| [Interpret Unsupported Message Types](./interpret-unsupported-message-types.md) | Feature / investigation | Needs specification | Import / live message content |
| [MCP Chat Reader Server](./mcp-chat-reader-server.md) | Feature | Idea | AI access |
| [Media Folder Import Reliability](./media-folder-import-reliability.md) | Bug / design follow-up | Needs investigation | Import |

## Graduated / Absorbed

| Former item | Where it went |
| --- | --- |
| Deleted Messages Not Marked On Originals | Absorbed by change `make-live-sync-trustworthy` (delete tombstone requirements) |
| Live Sync Gap Count For Older Chats | Absorbed by change `make-live-sync-trustworthy` (evidence-based auditing, grouped uncertainty) |
| wa.db Contact Enrichment Not Reflected | Folded into [Contact And Group Identity Integrity](./contact-and-group-identity-integrity.md) |
| Inbox Sorting Includes System Updates | Implemented in change `make-live-sync-trustworthy` (WhatsApp-style conversation recency ordering) |
