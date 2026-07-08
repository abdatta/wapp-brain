## Purpose

Define the guided local setup workflow for import, archive readiness, live linking, and live sync status in the Wapp Brain UI.

## Requirements

### Requirement: Guided Setup State Machine
The UI SHALL derive and present a single guided setup state for the archive and live-sync lifecycle.

#### Scenario: Empty archive shows import as next action
- **WHEN** the app loads and no imported messages exist
- **THEN** the primary onboarding action is to import a WhatsApp backup

#### Scenario: Baseline ready shows live linking as next action
- **WHEN** an imported archive baseline exists and no live session is linked
- **THEN** the primary onboarding action is to link WhatsApp live sync

#### Scenario: Connected session shows sync status
- **WHEN** a live session is connected and the maintainer is running
- **THEN** the UI reports that live sync is active and shows pause/monitor actions

#### Scenario: Paused session shows resume action
- **WHEN** a live session exists but live sync is stopped
- **THEN** the UI reports the session as paused and shows resume and unlink actions

### Requirement: Premium Onboarding Presentation
The UI SHALL provide a polished onboarding surface with clear phase hierarchy, animated progress feedback, and responsive layout.

#### Scenario: First-run onboarding is visible
- **WHEN** the archive has not been imported
- **THEN** the first screen shows a premium guided setup area rather than raw import path fields

#### Scenario: Browsing remains primary after setup
- **WHEN** archive data exists and no setup action is blocking the user
- **THEN** chat browsing remains the main workspace and onboarding compresses into a status/action surface

#### Scenario: Reduced motion preference is respected
- **WHEN** the user or browser requests reduced motion
- **THEN** onboarding animations are disabled or reduced without hiding progress information

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

### Requirement: Local Key Verification
The system SHALL verify the provided backup key locally before allowing the user to start import.

#### Scenario: Key verification succeeds
- **WHEN** the user provides a valid key or key file for the selected crypt backup
- **THEN** the wizard marks the key as verified and advances to the import mode step

#### Scenario: Key verification fails
- **WHEN** the provided key cannot decrypt or verify the selected backup
- **THEN** the wizard shows a privacy-safe error and does not start import

#### Scenario: Key material is not persisted
- **WHEN** key verification completes
- **THEN** the system does not persist raw key material outside runtime/staging needed for the local operation

### Requirement: Merge Or Replace Confirmation
The import wizard SHALL require the user to choose merge with existing archive or clear-and-replace before importing when archive data already exists.

#### Scenario: First import skips replacement warning
- **WHEN** no archive messages exist
- **THEN** the wizard may default to creating the archive without a destructive replace confirmation

#### Scenario: Re-import requires mode choice
- **WHEN** archive messages already exist
- **THEN** the wizard requires selecting merge or replace before import starts

#### Scenario: Replace requires explicit confirmation
- **WHEN** the user chooses clear-and-replace
- **THEN** the wizard requires an explicit confirmation before existing archive records are removed

### Requirement: UI Import Progress
The UI SHALL show import progress with phase-specific progress bars and messages equivalent to the CLI import phases.

#### Scenario: Decryption progress is visible
- **WHEN** the importer is verifying or decrypting an encrypted backup
- **THEN** the wizard shows file progress with processed bytes and phase label

#### Scenario: Message import progress is visible
- **WHEN** the importer is writing messages
- **THEN** the wizard shows message progress with imported/persisted counts when totals are available

#### Scenario: Warnings are surfaced safely
- **WHEN** import warnings are recorded
- **THEN** the wizard shows warning count and privacy-safe warning summaries without message bodies

#### Scenario: Import completion advances setup
- **WHEN** import completes successfully
- **THEN** the wizard closes or shows completion and the onboarding state advances to live-link readiness

#### Scenario: Browser refresh reattaches to active import
- **WHEN** an import job is running in the local server and the browser refreshes
- **THEN** the UI reopens the import wizard on the progress step and continues polling the active job

#### Scenario: UI progress keeps updating during message import
- **WHEN** the importer is writing a large message history in batches
- **THEN** the server yields between progress snapshots so the browser can poll and render current message progress while the job is still running

#### Scenario: User stops active import
- **WHEN** the user chooses to stop a running import and confirms the warning
- **THEN** the local server aborts the job, restores the archive snapshot captured before the job began, removes staged files, and reports the import as cancelled

#### Scenario: UI import progress is logged
- **WHEN** a UI import job is running in the local server
- **THEN** the server logs privacy-safe progress lines for lifecycle steps, file progress, message counts, warnings, completion, failure, and cancellation without logging local file paths, keys, message bodies, or raw rows

#### Scenario: UI import progress is visible in server terminal
- **WHEN** a UI import job is running from `npm run server` or `npm run dev`
- **THEN** the server terminal shows interactive import progress for file and message phases when terminal progress is enabled

### Requirement: Live Sync Action Clarity
The Live Sync UI SHALL show actions that match the current live-sync state and SHALL NOT show stop/unlink as primary actions when no live session is linked.

#### Scenario: Ready but unlinked
- **WHEN** the imported baseline is ready and no live session is linked
- **THEN** the Live Sync UI shows `Link WhatsApp` as the primary action and does not show `Stop Live Sync`

#### Scenario: No baseline
- **WHEN** no imported baseline exists
- **THEN** the Live Sync UI explains that backup import is required and routes the primary action to import

#### Scenario: Active sync
- **WHEN** the live session is connected and syncing
- **THEN** the Live Sync UI shows active state, last activity, gap health, and a pause action

#### Scenario: Paused sync
- **WHEN** the live session exists but syncing is stopped
- **THEN** the Live Sync UI shows resume and unlink actions with distinct explanations

#### Scenario: Unlink is explained
- **WHEN** the user opens the unlink action
- **THEN** the UI explains that unlink removes local live credentials and requires scanning/pairing again

### Requirement: UI Pairing Flow
The UI SHALL allow linking WhatsApp from the app when the archive baseline is ready.

#### Scenario: User starts linking
- **WHEN** the user activates `Link WhatsApp`
- **THEN** the UI opens a local pairing flow with QR or pairing code status

#### Scenario: Pairing completes
- **WHEN** the live client reports a connected linked-device session
- **THEN** the UI updates to connected/syncing or connected/paused state without requiring a manual refresh

#### Scenario: Pairing expires
- **WHEN** a QR or pairing code expires before linking completes
- **THEN** the UI offers a clear retry action

### Requirement: Privacy-Preserving Staging
The import wizard SHALL stage selected files only under the local private workspace and SHALL clean staged sensitive files after import or cancellation where safe.

#### Scenario: File is staged locally
- **WHEN** the user selects a backup file in the wizard
- **THEN** the server stores it under the private workspace rather than a public static directory

#### Scenario: User cancels import
- **WHEN** the user cancels before import starts
- **THEN** staged files for that wizard session are removed

#### Scenario: Doctor and cleanup account for staging
- **WHEN** the user runs cleanup or doctor checks
- **THEN** import staging is treated as sensitive local data

### Requirement: Media Ingestion Progress

The import wizard SHALL show a distinct media-ingestion phase with live progress — files processed, matched, copied, and warning counts — while media is being ingested, in the same privacy-safe style as the existing decryption and message phases, and the server terminal SHALL show equivalent progress.

#### Scenario: Media phase progress is visible

- **WHEN** the importer is ingesting a large media folder
- **THEN** the wizard shows the media phase with processed/matched/copied counts updating while the job runs

#### Scenario: Media warnings are summarized safely

- **WHEN** media files are missing, unreadable, or ambiguous during ingestion
- **THEN** the wizard shows warning counts and privacy-safe summaries without exposing private file paths
