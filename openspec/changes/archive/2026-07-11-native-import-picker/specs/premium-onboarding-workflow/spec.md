## MODIFIED Requirements

### Requirement: File Picker Import Wizard
The system SHALL provide an import/re-import wizard whose primary action is selecting a single WhatsApp backup folder, from which the server auto-detects the backup contents, rather than requiring the user to select each input or type paths. The wizard SHALL let the user pick the backup folder with a native OS folder dialog whose returned absolute path the server reads in place, and SHALL show which inputs were detected — messages, contacts, media, and recognized auxiliary files — before import. All inputs SHALL be read in place from disk and no file bytes SHALL be uploaded to the app. Providing the backup folder SHALL be sufficient to import; the media within it is optional, and a missing or unreadable media folder MUST NOT block import. When native path detection is unavailable, the wizard SHALL let the user type the backup folder path, and MAY offer an advanced typed per-input path override for non-standard layouts.

#### Scenario: User picks the backup folder
- **WHEN** the user activates "Browse…" for the backup folder and native path detection is available
- **THEN** the local server opens a native OS folder dialog and, on selection, fills the backup-folder path and auto-detects its contents

#### Scenario: Detection summary is shown before import
- **WHEN** a backup folder has been selected
- **THEN** the wizard shows which core inputs were detected (messages, optional contacts, optional media) and how many recognized auxiliary files were found, before the user enters the key

#### Scenario: Everything is read in place with no upload
- **WHEN** an import runs from a detected backup folder
- **THEN** the server reads the messages database, contacts database, and media directly from disk using the detected absolute paths, uploading no file bytes regardless of size

#### Scenario: Media is optional and non-blocking
- **WHEN** the backup folder has no media folder or its media cannot be read
- **THEN** the wizard still lets the user start the import, which proceeds without media rather than being blocked

#### Scenario: Typed backup-folder fallback
- **WHEN** native path detection is unavailable
- **THEN** the wizard lets the user type the backup folder path, which the server auto-detects the same way and reads in place

#### Scenario: Advanced per-input override is available
- **WHEN** auto-detection cannot resolve a required input from the selected folder
- **THEN** the wizard exposes an advanced typed per-input override that is also read in place, without making it the default route and without uploading file bytes

### Requirement: Local Key Verification
The system SHALL verify the provided backup key locally before allowing the user to start import. The key SHALL be provided as text, and the system SHALL NOT accept a key file. The same key SHALL decrypt the encrypted databases detected in the backup folder.

#### Scenario: Key verification succeeds
- **WHEN** the user provides a valid key in the text field for the detected `msgstore`
- **THEN** the wizard marks the key as verified and advances to the import mode step

#### Scenario: Key verification fails
- **WHEN** the provided key cannot decrypt or verify the detected backup
- **THEN** the wizard shows a privacy-safe error and does not start import

#### Scenario: Key material is not persisted
- **WHEN** key verification completes
- **THEN** the system does not persist raw key material outside the runtime need for the local operation

#### Scenario: Key files are not accepted
- **WHEN** the user is providing the backup key
- **THEN** the wizard offers only a text field for the key and provides no key-file picker or key-file path input

### Requirement: Privacy-Preserving Staging
The import wizard SHALL read user-provided backup files in place from their original location and SHALL NOT copy or upload them into the app. Any decrypted intermediate artifacts the importer produces SHALL be written only under the local private workspace and cleaned after import or cancellation where safe.

#### Scenario: User files are read in place
- **WHEN** the user selects a backup folder and starts import
- **THEN** the server reads the backup files from their original location and does not copy or upload them into an app staging area

#### Scenario: Decrypted intermediates are private
- **WHEN** the importer decrypts an encrypted database to read it
- **THEN** the decrypted output is written under the local private workspace rather than a public static directory

#### Scenario: Cancellation cleans intermediates
- **WHEN** the user cancels an import
- **THEN** decrypted intermediate artifacts produced for that job are removed

#### Scenario: Doctor and cleanup account for intermediates
- **WHEN** the user runs cleanup or doctor checks
- **THEN** import intermediates are treated as sensitive local data

## ADDED Requirements

### Requirement: Native Local Path Detection
The system SHALL provide a localhost-only capability that opens a native OS file or folder dialog on the machine running the server and returns the absolute path the user selects, so the import wizard can detect an input's path without uploading its bytes. The capability SHALL treat dialog cancellation as a non-error no-op, SHALL report when it is unavailable so callers can fall back, and MUST NOT interpolate any client-supplied string into the command that launches the dialog.

#### Scenario: Backup folder opens a native folder dialog
- **WHEN** the client requests a pick for the backup-root (or media) folder input
- **THEN** the server opens a native OS folder-selection dialog and returns the selected absolute directory path

#### Scenario: File override opens a native file dialog
- **WHEN** the client requests a pick for a file input (`msgstore` or `wa`) in the advanced override
- **THEN** the server opens a native OS file-selection dialog with a filter hint appropriate to that kind and returns the selected absolute file path

#### Scenario: Cancelling the dialog is a no-op
- **WHEN** the user dismisses the native dialog without choosing anything
- **THEN** the server returns an explicit cancelled result with no path and no error, and the wizard leaves the corresponding input unchanged

#### Scenario: Picker unavailable falls back gracefully
- **WHEN** the server cannot open a native dialog (the platform has no picker implementation, or there is no interactive desktop session)
- **THEN** the server reports the picker as unavailable and the wizard continues to offer the typed backup-folder path and per-input override, so the web viewer keeps working unchanged

#### Scenario: Only the machine running the server is prompted
- **WHEN** a pick is requested
- **THEN** the dialog appears on the machine hosting the loopback server in the user's own desktop session, and the endpoint is not exposed beyond the app's localhost surface

#### Scenario: Client input cannot inject a command
- **WHEN** a pick request is handled
- **THEN** the only client-controlled value that influences the dialog is a validated input-kind enum selecting a fixed server-authored command, and no client-supplied string is concatenated into the launched command

### Requirement: Backup Layout Auto-Detection
Given a selected backup folder, the system SHALL scan it and produce a manifest identifying the core import inputs — the encrypted or plain `msgstore` database (required), the `wa.db` contacts database (optional), and the media folder (optional) — searching the folder and its standard subfolders, and SHALL recognize the auxiliary WhatsApp backup files that are present without ingesting them. The scan SHALL be shallow, inspecting only the entries needed to build the manifest rather than walking the full media tree. A backup folder with no `msgstore` SHALL be reported as invalid; missing optional inputs SHALL NOT block import.

#### Scenario: Core inputs are detected
- **WHEN** the selected folder contains a `msgstore` database (`.crypt15` or plain `.db`), a `wa.db`, and a media folder, whether at the root or in the standard `Databases`/`Media` subfolders
- **THEN** the manifest lists all three with their resolved absolute paths

#### Scenario: Missing messages database is invalid
- **WHEN** no `msgstore` database is found in the folder or its standard subfolders
- **THEN** the manifest is reported as invalid and import is not offered

#### Scenario: Missing optional inputs still allow import
- **WHEN** the `wa.db` or the media folder is absent
- **THEN** the manifest omits that input and import still proceeds

#### Scenario: Auxiliary files are recognized and reserved
- **WHEN** the folder contains auxiliary backup files such as `chatsettingsbackup`, `status_backup`, `offloaded-media`, `backup_settings.json`, `commerce_backup`, or `stickers_db`
- **THEN** the manifest lists them as detected and reserved for a future ingestion, and this import does not ingest them

#### Scenario: Multiple dated message databases resolve deterministically
- **WHEN** only dated `msgstore` rotations exist rather than a canonical `msgstore.db.crypt15`
- **THEN** detection selects the most recent one and reports which file was chosen

#### Scenario: Detection does not walk the full media tree
- **WHEN** the selected folder contains a very large media subfolder
- **THEN** detection confirms the media folder's presence without enumerating its full contents, deferring the full media walk to the import job

### Requirement: Non-Blocking Setup Progress
Any import-setup operation that can take more than about a second — opening the native picker, scanning the backup folder, and verifying the key — SHALL show a progress or busy indicator in the wizard and SHALL run without blocking the server from handling other requests.

#### Scenario: Waiting on the native dialog does not block the server
- **WHEN** a native pick is in progress and the user has not yet chosen
- **THEN** the wizard shows a waiting indicator and the server continues handling other API requests

#### Scenario: Folder scan shows a busy indicator
- **WHEN** the server is scanning a selected backup folder
- **THEN** the wizard shows a busy indicator until the detection manifest is ready

#### Scenario: Key verification shows progress
- **WHEN** the key is being verified against the detected backup
- **THEN** the wizard shows a busy indicator and re-enables input when verification resolves

#### Scenario: Import progress updates asynchronously
- **WHEN** an import job is running
- **THEN** the wizard shows phase progress that updates while the job runs, and the server yields between progress snapshots so the browser can poll without the job blocking
