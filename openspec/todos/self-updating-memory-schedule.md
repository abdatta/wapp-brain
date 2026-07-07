# Self-Updating Memory Schedule

## Type

Feature

## Status

Needs specification

## User Goal

The second-brain memory layer should live up to "self-updating": memory consolidation (REM) runs happen automatically on a schedule while the app is running, so wiki pages stay current without the user remembering to press "Run REM".

## Expected Behavior

- While the local server runs, memory consolidation triggers itself on a sensible cadence (for example daily after a cutoff hour, or after enough new messages accumulate), using the same completed-window and citation rules as manual runs.
- Scheduled runs never overlap manual runs (existing job-lock behavior holds) and skip cleanly when there is nothing new to consolidate.
- The user can see when the last automatic run happened, when the next is expected, and pause automatic runs.
- Failures of scheduled runs surface as visible status (and integrate with whatever alerting `autonomous-laptop-operation` establishes), not silent skips.
- Remote/Codex-backed generation remains explicit opt-in; scheduling never silently switches providers.

## Behavior Questions

- What is the right default cadence — time-based (daily at cutoff), volume-based (every N new messages), or both?
- Should scheduled runs process only fully completed windows (yesterday and earlier), matching the current REM semantics?
- Should a missed schedule (laptop was off) run immediately on next startup or wait for the next scheduled slot?

## Privacy Notes

Scheduled generation must follow the same local-first rules as manual runs: local provider by default, all artifacts under the private workspace, no data leaves the machine without explicit provider opt-in.

## Acceptance Sketch

- **WHEN** the server has been running past the configured cutoff with new completed-window messages present
- **THEN** a memory run executes automatically and updates pages with citations.

- **WHEN** the laptop was off during the scheduled time
- **THEN** the missed consolidation is handled according to the chosen catch-up policy and the user can see what happened.

- **WHEN** a scheduled run fails
- **THEN** the failure is visible in memory status rather than silently dropped.
