## MODIFIED Requirements

### Requirement: Non-Blocking Operation
All brain work SHALL run in bounded batches with event-loop yields, report progress for any operation over one second via job objects and server-sent events, respect the recovery-tick pass ordering so live sync is never starved, and never touch the WhatsApp socket. The same discipline SHALL extend to brain READS: an endpoint polled by the application shell SHALL answer within a stated latency budget at real archive scale, and a derived aggregate that cannot meet that budget SHALL be served off the poll path rather than making every navigation pay for it. Read cost SHALL be measured against a realistic archive rather than assumed from a query's apparent simplicity.

#### Scenario: Nightly run during live sync
- **WHEN** a consolidation run executes while live messages are arriving
- **THEN** ingestion latency stays within normal bounds and the run reports progress until completion

#### Scenario: Failures are never silent
- **WHEN** any brain job fails, is interrupted, or is blocked
- **THEN** the state and a privacy-safe reason surface in the brain status UI, remain discoverable after page reloads and server restarts, and are mirrored as counts-and-durations-only lines in the server console

#### Scenario: A polled read stays within budget as the archive grows
- **WHEN** the shell polls brain status against an archive of hundreds of thousands of messages
- **THEN** the response arrives within its stated budget, and any aggregate that would exceed it is served by a separate, separately-cadenced endpoint instead
