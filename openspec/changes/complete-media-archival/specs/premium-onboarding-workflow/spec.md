## MODIFIED Requirements

### Requirement: File Picker Import Wizard
The system SHALL provide an import/re-import wizard that allows users to select local backup inputs with file pickers instead of typing paths. The wizard SHALL include an optional media-folder selection so users can supply their WhatsApp media for archival, and selecting, omitting, or mis-specifying the media folder MUST NOT block the user from proceeding with the import.

#### Scenario: User selects crypt backup
- **WHEN** the user opens the import wizard
- **THEN** the wizard allows selecting a `msgstore.db.crypt15` file with a native file picker

#### Scenario: User selects optional contact database
- **WHEN** the user is on the backup file selection step
- **THEN** the wizard allows selecting an optional `wa.db` file

#### Scenario: User selects a media folder
- **WHEN** the user is on the import input selection step
- **THEN** the wizard allows selecting an optional WhatsApp media folder whose contents will be archived during import

#### Scenario: Large media folders use a direct local path
- **WHEN** the user's media folder is too large to upload comfortably through the browser
- **THEN** the wizard offers a first-class local-path input for the media folder that the server ingests directly from disk, presented as the recommended route for large folders rather than a buried fallback

#### Scenario: Media selection is optional and non-blocking
- **WHEN** the user omits the media folder or the selected media folder cannot be read
- **THEN** the wizard still lets the user start the import, which proceeds without media rather than being blocked

#### Scenario: Manual path fallback is available
- **WHEN** browser file picking cannot provide a required input
- **THEN** the wizard exposes an advanced manual path fallback without making it the default path

## ADDED Requirements

### Requirement: Media Ingestion Progress

The import wizard SHALL show a distinct media-ingestion phase with live progress — files processed, matched, copied, and warning counts — while media is being ingested, in the same privacy-safe style as the existing decryption and message phases, and the server terminal SHALL show equivalent progress.

#### Scenario: Media phase progress is visible

- **WHEN** the importer is ingesting a large media folder
- **THEN** the wizard shows the media phase with processed/matched/copied counts updating while the job runs

#### Scenario: Media warnings are summarized safely

- **WHEN** media files are missing, unreadable, or ambiguous during ingestion
- **THEN** the wizard shows warning counts and privacy-safe summaries without exposing private file paths
