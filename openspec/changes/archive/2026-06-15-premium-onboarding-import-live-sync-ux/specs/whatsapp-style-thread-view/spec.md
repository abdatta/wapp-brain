## MODIFIED Requirements

### Requirement: Collapse import controls after archive data exists
The UI SHALL render import and re-import as a guided action entry point rather than inline raw path fields. When archive data exists, the archive browser remains the primary workspace and import/re-import opens the guided import wizard.

#### Scenario: Archive with data opens in browse mode
- **WHEN** the app loads and `/api/status` reports existing archive data or a previous import run
- **THEN** the import fields are hidden behind an explicit import/re-import action that opens the guided import wizard

#### Scenario: Empty archive shows onboarding import action
- **WHEN** the app loads and `/api/status` reports no archive data and no previous import run
- **THEN** the app shows a first-run onboarding surface with import backup as the primary action rather than raw path fields

#### Scenario: User opens import wizard
- **WHEN** the user activates the import/re-import action
- **THEN** the guided import wizard opens without clearing any already selected wizard state for the current session

#### Scenario: Successful import returns to browse mode
- **WHEN** an import completes successfully
- **THEN** the wizard completes, archive browsing controls remain available, and onboarding advances to the next setup action
