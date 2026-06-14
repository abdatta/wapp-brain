## Why

Wapp Brain currently creates a trustworthy archive from a point-in-time Android backup, but the archive starts drifting as soon as new WhatsApp messages arrive. We need a local live maintenance engine that can keep the archive current, recover after downtime, and clearly flag the rare cases where WhatsApp Web history limits make full reconciliation uncertain.

## What Changes

- Add an opt-in live WhatsApp maintainer that links as a WhatsApp companion device and ingests new messages into the existing local archive.
- Prefer Baileys as the initial code-level WhatsApp Web client because it uses the WebSocket protocol directly rather than browser automation.
- Store live session/auth state, sync checkpoints, raw protocol metadata, run state, warnings, and recovery evidence under the local `.wapp-brain/` boundary.
- Normalize live events into the existing contacts, chats, participants, and messages model while preserving idempotency with source-derived keys.
- Add a reconciliation planner that compares per-chat archive watermarks with live/history sync evidence, backfills missing windows within configured limits, and marks chats as healthy, catching up, uncertain, or needs-user-action.
- Add local API/CLI surfaces to start pairing, run/stop the maintainer, inspect sync health, review gaps, and retry recovery.
- Document WhatsApp Web client tradeoffs, privacy boundaries, reliability limits, and the non-goal of hosted/cloud sync.

## Capabilities

### New Capabilities

- `live-whatsapp-maintainer`: Covers pairing a code-level WhatsApp Web client, ingesting live events, detecting per-chat gaps, bounded backfill, recovery after downtime, and surfacing sync health.

### Modified Capabilities

- None.

## Impact

- Adds a new optional runtime dependency on a WhatsApp Web protocol client, initially Baileys.
- Extends SQLite schema/repository behavior for live sync runs, checkpoints, gap tracking, client auth/session state, and sync diagnostics.
- Adds server/CLI commands for local-only pairing, maintainer lifecycle, health inspection, and recovery retries.
- Adds UI indicators for live sync state, suspected gaps, and user-action-required alerts.
- Keeps existing backup import behavior unchanged and treats backup import plus live maintainer as separate, idempotent sources feeding the same archive.
