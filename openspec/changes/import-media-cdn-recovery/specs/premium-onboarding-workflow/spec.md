## MODIFIED Requirements

### Requirement: Media Ingestion Progress

The import wizard SHALL show a distinct media-ingestion phase with live progress — files processed, matched, copied, queued for recovery, unrecoverable, and warning counts — while media is being ingested, in the same privacy-safe style as the existing decryption and message phases, and the server terminal SHALL show equivalent progress. The media summary SHALL distinguish media archived from the folder, media queued for background recovery from the backup's descriptor, and media with no recoverable copy, so the user sees that most unmatched media is queued for recovery rather than lost.

#### Scenario: Media phase progress is visible

- **WHEN** the importer is ingesting a large media folder
- **THEN** the wizard shows the media phase with processed/matched/copied counts updating while the job runs

#### Scenario: Recovery breakdown is reported

- **WHEN** media ingestion completes with some media unmatched to a local file
- **THEN** the summary reports how many were archived from the folder, queued for background recovery, and genuinely unrecoverable

#### Scenario: Media warnings are summarized safely

- **WHEN** media files are missing, unreadable, or ambiguous during ingestion
- **THEN** the wizard shows warning counts and privacy-safe summaries without exposing private file paths
