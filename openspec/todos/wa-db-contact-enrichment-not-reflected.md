# wa.db Contact Enrichment Not Reflected

## Type

Bug

## Status

Needs reproduction

## User Observation

Providing `wa.db` did not appear to improve contact names, even after exporting it from the UI.

## Expected Behavior

When the user provides a valid `wa.db`, the archive should use it as optional local contact context so chats and messages display the best available contact names.

Contact enrichment should be visible enough that the user can tell whether `wa.db` was accepted, ignored, incomplete, or unable to improve the current archive.

## Behavior Questions

- Should `wa.db` enrichment update existing imported chats after the message database has already been imported?
- How should the UI distinguish "no matching contacts found" from "contact database was not processed"?
- Should the import summary show counts for contacts read, contacts matched, and display names improved?

## Privacy Notes

Contact names and phone numbers are private metadata. Diagnostics should summarize counts and status without dumping contact rows.

## Acceptance Sketch

- **WHEN** a valid `wa.db` with matching contacts is included in import
- **THEN** matching chats show enriched names where WhatsApp backup data provides them.

- **WHEN** `wa.db` does not improve any display names
- **THEN** the user sees a clear local-only explanation rather than a silent no-op.

