# Inbox Sorting Includes System Updates

## Type

Bug / behavior alignment

## Status

Needs specification

## User Observation

The inbox/chat list looks messy because system event updates appear to influence sorting. Chats can rise in the list because of edits, deletes, system events, or similar updates rather than because of newly sent messages.

## Expected Behavior

The default chat list should emulate WhatsApp-style recency. Chats should be sorted by the latest user-visible sent or received message that advances the conversation, not by every archived update or system event.

System events should remain available inside the chat where appropriate, but they should not make the inbox feel noisy or reorder quiet conversations unexpectedly.

## Behavior Questions

- Which message categories should count as conversation recency: text, media, calls, deleted placeholders, unknown content-bearing messages?
- Which categories should not count: edits, reactions, receipts, group metadata changes, encryption notices, sync events, unmatched deletion events?
- Should there be an advanced/debug sort mode that uses latest archived event instead of WhatsApp-style latest message?

## Privacy Notes

Sorting diagnostics should use counts, timestamps, and message categories rather than message bodies.

## Acceptance Sketch

- **WHEN** a chat receives only a system event after its latest user-visible message
- **THEN** the default chat list keeps the chat sorted by the latest user-visible message.

- **WHEN** a chat receives a new incoming or outgoing message
- **THEN** the chat moves according to that message's timestamp.

