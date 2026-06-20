# Deleted Messages Not Marked On Originals

## Type

Bug

## Status

Needs investigation

## User Observation

Deleted messages do not appear to be marked as deleted on the original message. Instead, the UI shows a separate "Deleted Message" system event.

## Expected Behavior

The archive should represent WhatsApp delete behavior in a way that matches what users expect from WhatsApp: the affected message should be recognizable as deleted, rather than only appearing as a separate event detached from the original conversation item.

If the original message is available, the UI should show that message in its deleted state while preserving useful metadata such as chat placement and source identity.

If the original message is not available, a standalone deletion event may remain useful as evidence, but it should be clear that the target message could not be matched.

## Behavior Questions

- Should deleted content be hidden, replaced with a WhatsApp-style deleted placeholder, or shown only if the user explicitly enables forensic detail?
- How should the UI display a delete event whose original message has not been imported yet?
- Should delete state affect chat previews and search results?

## Privacy Notes

Deleted message handling should avoid re-exposing deleted content in normal views. Any forensic or debug view should be explicit and local-only.

## Acceptance Sketch

- **WHEN** a delete update can be matched to an archived message
- **THEN** the original conversation item is marked deleted in the chat view.

- **WHEN** a delete update cannot be matched
- **THEN** the archive preserves a clear unmatched deletion event without pretending the original message is known.

