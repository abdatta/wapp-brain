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
| [Media Folder Import Reliability](./media-folder-import-reliability.md) | Bug / design follow-up | Needs investigation | Import |
| [wa.db Contact Enrichment Not Reflected](./wa-db-contact-enrichment-not-reflected.md) | Bug | Needs reproduction | Import / contacts |
| [Deleted Messages Not Marked On Originals](./deleted-messages-not-marked-on-originals.md) | Bug | Needs investigation | Message state |
| [Inbox Sorting Includes System Updates](./inbox-sorting-includes-system-updates.md) | Bug / behavior alignment | Needs specification | Chat list |
| [Live Sync Gap Count For Older Chats](./live-sync-gap-count-for-older-chats.md) | Investigation | Needs diagnosis | Live maintainer |
| [MCP Chat Reader Server](./mcp-chat-reader-server.md) | Feature | Idea | AI access |

