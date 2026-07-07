# Thread View Signal Vs Noise

## Type

Feature / behavior alignment

## Status

Needs specification

## User Goal

Inside a chat, important content (real messages from people) should stand out from unimportant noise (system events, encryption notices, group housekeeping, reactions, unrecognized event types). The user should be able to read a thread as a conversation, not as a raw event log.

## Expected Behavior

- System-style events render as compact, visually secondary items — never as message bubbles — including event types the app does not fully recognize yet (unrecognized types should degrade to a quiet generic event, not a loud "Unsupported message" bubble).
- The user can toggle event visibility per thread (for example: conversation only / conversation + events), with a sensible default that favors conversation.
- Reactions decorate the message they belong to rather than occupying their own row (storage-side handling is covered by the `make-live-sync-trustworthy` change; this item covers the reading experience).
- Related: the chat list ordering half of this problem is already implemented (WhatsApp-style conversation recency in `make-live-sync-trustworthy`); the in-thread experience here should share that same "visible exchange" definition of which message categories count as conversation.

## Behavior Questions

- What is the default: hide system events entirely, or show them collapsed/dimmed?
- Should calls count as conversation (they carry social meaning) or as events?
- Should there be a per-category control (e.g., show membership changes but hide encryption notices), or a single events toggle?
- Does the "conversation only" definition also drive search results and memory evidence selection, or is it purely a display concern?

## Privacy Notes

Purely local display behavior; no additional data handling. Any category diagnostics should use counts and types, not message bodies.

## Acceptance Sketch

- **WHEN** a thread contains messages and system events with the default view
- **THEN** the user sees the conversation prominently, with events hidden or visually secondary per the chosen default.

- **WHEN** an event of an unrecognized type is displayed
- **THEN** it renders as a quiet generic event item rather than a prominent message bubble.

- **WHEN** the user toggles events on
- **THEN** system events appear inline in chronological order without reflowing the conversation messages confusingly.
