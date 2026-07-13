## ADDED Requirements

### Requirement: Import wizard steps are route-addressable and reload-safe
The import wizard SHALL be the `/import` page with its steps as sub-routes (`/import` folder,
`/import/key`, `/import/mode`, `/import/run`) so the current step is reflected in the URL. An
in-progress import SHALL be reload-safe: reloading during import SHALL land on the live-progress
step and reattach to the active server-side import job. When an import job is already active,
opening `/import` SHALL redirect to the live-progress step. A step whose prerequisite input is
absent (e.g. `/import/mode` opened cold, before a key is verified) SHALL redirect to the wizard's
first step rather than showing an inconsistent state.

#### Scenario: Reloading during import returns to live progress
- **WHEN** the user reloads the browser while an import is running
- **THEN** the app lands on the import run step and reattaches to the active job, showing its live progress

#### Scenario: Active job redirects the wizard entry to progress
- **WHEN** an import job is already active and the user opens `/import`
- **THEN** the app redirects to the run step showing that job's live progress rather than the folder step

#### Scenario: A step without its prerequisite redirects to the start
- **WHEN** the user opens a later wizard step URL (e.g. `/import/mode`) with no verified key or selected backup in the current session and no active job
- **THEN** the app redirects to the wizard's first step instead of rendering an inconsistent step

#### Scenario: The current wizard step is reflected in the URL
- **WHEN** the user advances through the wizard's folder, key, and mode steps
- **THEN** the URL reflects the current step so the step is addressable and back/forward move between steps
