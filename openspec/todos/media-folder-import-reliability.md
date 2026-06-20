# Media Folder Import Reliability

## Type

Bug / design follow-up

## Status

Needs investigation

## User Observation

Importing a media folder from the UI did not work reliably.

## Expected Behavior

Users should be able to provide WhatsApp media context through a local-only flow that is understandable, resilient for large folders, and does not expose private files outside the machine.

The UI should avoid fragile or misleading input modes. A user should choose media through an explicit file picker or supported archive picker, not by typing arbitrary paths into a text field.

## Candidate Product Direction

Consider one or both supported media input models:

- Local folder reference: the user selects a folder, and the app reads from that path directly during import or later enrichment.
- Zip archive input: the user provides a WhatsApp media export archive, and the app extracts or indexes it under the private workspace.

Both models should make clear whether media is copied, indexed in place, or only used as optional context.

## Behavior Questions

- Should media files be copied into `.wapp-brain/`, referenced in place, or selectable per import?
- Should missing media block message import, or should import continue with warnings?
- How should the app report unreadable, unsupported, or oversized media inputs without exposing private filenames unnecessarily?

## Privacy Notes

Media can be more sensitive than message text. The app should not upload media, log raw media paths by default, or commit generated media indexes.

## Acceptance Sketch

- **WHEN** the user selects a supported media source during import
- **THEN** the app either links usable media to imported messages or reports a clear local-only warning.

- **WHEN** the media source cannot be read
- **THEN** message import can still proceed, and the user gets a privacy-safe explanation of what was skipped.

