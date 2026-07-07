# Autonomous Laptop Operation

## Type

Feature

## Status

Ready to propose

## User Goal

The archive maintains itself around the laptop's on/off rhythm. When the laptop turns on, the app starts, connects to WhatsApp, catches up on everything missed, and stays in sync — with zero manual steps. The user is alerted only when something genuinely needs them.

## Expected Behavior

- The local server starts automatically at user login (opt-in, user-controlled), without a terminal window the user must remember to open.
- If linked-device credentials exist, live sync resumes automatically when the server starts — no "Resume" button required.
- Startup triggers the downtime catch-up flow (auditing and recovery are covered by the `make-live-sync-trustworthy` change; this item covers invoking it automatically on boot).
- Real problems reach the user outside the app UI (for example a Windows notification): device unlinked and re-pairing needed, sync failing repeatedly, archive not writable. Routine states (connected, caught up, transient reconnects) stay quiet.
- Long offline periods do not dead-end the system: if the archive baseline is older than the live recovery window, the app either resumes with honestly-marked uncertain windows or clearly tells the user a fresh backup import is the fix — it never silently refuses to sync.
- Sleep/wake behaves like a short disconnect: reconnect and catch up without user action.

## Behavior Questions

- What is the startup mechanism on Windows — login task, tray application, or both? Should there be a visible tray/status affordance at all?
- Which events deserve an OS notification vs a badge inside the app? What is the escalation ladder for repeated failures?
- Should auto-resume be default-on once credentials exist, or an explicit setting the user flips once?
- After very long downtime (weeks), should the app auto-resume with uncertainty markers, or require an explicit user decision because backfill limits make completeness unprovable?

## Privacy Notes

Autostart must not weaken the local-only posture: server still binds to localhost, no telemetry, and notifications must not include message content — only sync-state information.

## Acceptance Sketch

- **WHEN** the user logs into the machine with autostart enabled and valid linked credentials present
- **THEN** the server starts, live sync resumes, and downtime catch-up begins without any user interaction.

- **WHEN** the linked device has been logged out remotely
- **THEN** the user receives a local OS notification that re-pairing is required.

- **WHEN** sync is healthy
- **THEN** the user receives no notifications.
