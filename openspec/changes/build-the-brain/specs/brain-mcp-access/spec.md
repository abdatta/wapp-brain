## ADDED Requirements

### Requirement: Disabled-By-Default Local MCP Server
The system SHALL provide an MCP server as a separate stdio-transport process that the user starts explicitly, which communicates only with the loopback HTTP API, never opens the archive database directly, never binds a network port, and never sends archive content anywhere itself.

#### Scenario: Server not running by default
- **WHEN** the app server starts
- **THEN** no MCP endpoint exists until the user runs the MCP command

#### Scenario: Single-writer safety
- **WHEN** the MCP process serves requests during live sync
- **THEN** all data access goes through the app's HTTP API and the SQLite file has no second writer

### Requirement: Scoped Access Grants
MCP tool access SHALL be filtered through user-managed grants scoped by chat, person, time window, or search, each with an expiry and a maximum disclosure layer; sessions without grants SHALL see only overview and page layers, and raw message access SHALL always require an explicit grant covering that scope.

#### Scenario: No grants
- **WHEN** an agent calls tools with no active grants
- **THEN** overview and page content is served, and episode or message requests return a needs-grant error naming the required scope

#### Scenario: Chat-scoped grant
- **WHEN** a grant covers one chat for a time window
- **THEN** message-layer tools serve only that chat's rows inside the window and search hits from ungranted scopes are filtered out

#### Scenario: Grant expiry
- **WHEN** a grant expires
- **THEN** subsequent calls behave as if it never existed

### Requirement: Brain Tool Surface
The MCP server SHALL expose tools for overview, search, page, entity resolution, episode, timeline, exact messages with context, and grant introspection, whose responses reuse the brain retrieval DTOs, always include citations and coverage metadata, and stay token-lean (bounded lists, snippets over full bodies unless the message layer is requested).

#### Scenario: Two-call decision lookup
- **WHEN** an agent asks what two people decided about a topic
- **THEN** a search call scoped to the person plus a citation-resolution call suffices to return cited exact messages

#### Scenario: Ambiguous entity
- **WHEN** an entity lookup matches several people
- **THEN** the tool returns candidates with distinguishing context instead of guessing

### Requirement: Access Audit Log
Every MCP tool call SHALL be recorded with tool name, parameters summary, matched grants, and returned item identifiers and counts — never message bodies — and the user SHALL be able to review the log per session.

#### Scenario: User reviews agent activity
- **WHEN** the user inspects the access log after an agent session
- **THEN** they can see which tools ran, under which grants, and which chats, documents, and message keys were returned
