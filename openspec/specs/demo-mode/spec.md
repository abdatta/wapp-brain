# demo-mode Specification

## Purpose
Let the app be demonstrated, screenshotted, and explored with zero real WhatsApp data and zero external side effects: an isolated synthetic demo workspace, one-command deterministic provisioning, server-enforced guards on every external connection, and unmistakable demo presentation in the shell.
## Requirements
### Requirement: Demo workspace isolation
When started in demo mode (`WAPP_DEMO=1` or the `demo` CLI command), the system SHALL derive every path it reads or writes — archive database, media store, live-sync credentials, brain data, memory/vault output, traces, and Google credentials — from a dedicated demo workspace directory (default `.wapp-brain-demo`), and SHALL ignore explicit path-override environment variables (`WAPP_WORK_DIR`, `ARCHIVE_DB_PATH`, `WAPP_MEMORY_DIR`, `WAPP_MEMORY_CODEX_SESSION_PATH`) so a demo process cannot be pointed at the real workspace. A demo-specific `WAPP_DEMO_DIR` MAY relocate the demo workspace (tests, alternate disks) but SHALL be refused when it resolves to the real workspace (the env-configured one or the default). The demo workspace SHALL be excluded from version control.

#### Scenario: Path overrides cannot escape the demo workspace
- **WHEN** the server starts in demo mode with `WAPP_WORK_DIR` or `ARCHIVE_DB_PATH` set to the real workspace
- **THEN** every configured path still resolves under the demo workspace and the real workspace is neither read nor written

#### Scenario: Real mode is unaffected
- **WHEN** the server starts without the demo flag
- **THEN** path resolution behaves exactly as before, honoring `WAPP_WORK_DIR` and `ARCHIVE_DB_PATH`

### Requirement: One-command deterministic provisioning
The system SHALL provide a `demo` command that, when the demo archive is missing or empty, provisions the demo workspace end-to-end — generates a curated synthetic WhatsApp backup, imports it through the real importer, runs a zero-model extractive brain pass, and builds the search index — and then serves the app. Provisioning SHALL be deterministic (fixed content, fixed timestamps, no randomness), SHALL show step-by-step progress, and SHALL be skipped when a populated demo archive already exists. A `demo-reset` command SHALL delete only the demo workspace, after confirmation.

#### Scenario: Fresh provisioning populates the app
- **WHEN** the user runs the demo command with no existing demo workspace
- **THEN** the command generates the synthetic backup, imports it, runs the extractive brain pass, builds the search index, and starts a server whose chat, search, contacts, and brain-episode surfaces show the synthetic data

#### Scenario: Re-running skips provisioning
- **WHEN** the user runs the demo command and a populated demo archive already exists
- **THEN** provisioning is skipped and the server starts against the existing demo archive

#### Scenario: Reset removes only the demo workspace
- **WHEN** the user runs demo-reset and confirms
- **THEN** the demo workspace directory is deleted and no other path — in particular the real workspace — is touched

#### Scenario: Provisioning is deterministic
- **WHEN** the demo workspace is reset and provisioned again on the same code version
- **THEN** the demo archive contains the same chats, contacts, and message content as before

### Requirement: Demo mode makes no external calls
In demo mode the system SHALL NOT initiate external side effects: live-sync auto-resume SHALL be disabled and live link/pair/resume endpoints SHALL refuse; Google Contacts OAuth endpoints SHALL refuse; model-backed brain and memory providers SHALL be refused so only the extractive/local paths run. Each refusal SHALL be a clear, privacy-safe response identifying demo mode as the reason.

#### Scenario: Live pairing is refused
- **WHEN** a client calls the live link/pair or resume endpoints in demo mode
- **THEN** the server refuses with a response that names demo mode and no live-sync connection is attempted

#### Scenario: Google OAuth is refused
- **WHEN** a client calls a Google Contacts OAuth endpoint in demo mode
- **THEN** the server refuses with a response that names demo mode and no OAuth flow is started

#### Scenario: Model-backed providers cannot be enabled
- **WHEN** a client or CLI attempts to enable or select a model-backed brain provider in demo mode
- **THEN** the attempt is refused, the effective provider remains extractive, and no model call is made

### Requirement: Demo mode is visibly indicated
The server status API SHALL report whether the instance runs in demo mode, and the client shell SHALL make demo mode unmistakable: a persistent demo badge in the topbar, a document title that names demo mode, demo-appropriate onboarding copy instead of the real-data setup ladder, and guarded actions (live pairing, Google connect, model-provider enablement) rendered disabled with an explanation rather than failing on activation.

#### Scenario: Status reports demo
- **WHEN** a client fetches server status from a demo instance
- **THEN** the response identifies the instance as demo mode

#### Scenario: Shell shows the demo badge and title
- **WHEN** the UI loads against a demo instance
- **THEN** the topbar shows a persistent demo badge and the document title identifies the demo instance

#### Scenario: Guarded actions explain instead of failing
- **WHEN** the user views a guarded action (link WhatsApp, connect Google, enable a model provider) in demo mode
- **THEN** the action is disabled with a visible explanation that this is a demo instance, rather than producing an error on click

#### Scenario: Real-data onboarding is not shown in demo
- **WHEN** the UI loads against a demo instance
- **THEN** the import → link → resume guided-setup banner is not shown

### Requirement: Demo instance coexists with the real instance
The demo server's default port SHALL differ from the real server's default port so both can run simultaneously on one machine, and the demo startup output SHALL name the port and the demo workspace path. The real instance's default behavior SHALL be unchanged.

#### Scenario: Both instances run side by side
- **WHEN** the real server is running on its default port and the user starts the demo command with no port override
- **THEN** the demo server starts on its own distinct default port and both instances serve independently
