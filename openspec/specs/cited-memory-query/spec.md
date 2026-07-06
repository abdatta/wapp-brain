## Purpose

Define retrieval and citation behavior for memory queries that combine committed long-term wiki memory with recent unconsolidated WhatsApp archive context.

## Requirements

### Requirement: Layered Memory Retrieval
The system SHALL retrieve from committed long-term memory and unconsolidated short-term archive messages for memory read queries.

#### Scenario: Query includes recent unconsolidated messages
- **WHEN** the user asks a memory question after new current-day messages have been archived but before REM consolidation runs
- **THEN** the system considers those recent messages as short-term evidence along with committed long-term memory

#### Scenario: Query includes committed memory
- **WHEN** the user asks a broad memory question whose evidence exists in committed wiki pages
- **THEN** the system retrieves relevant long-term memory pages and their citation maps

### Requirement: Answer Citations
The system SHALL cite every factual answer claim with exact source messages or cited memory claims that resolve to exact source messages.

#### Scenario: Answer cites long-term memory
- **WHEN** an answer uses a committed memory page as evidence
- **THEN** the answer includes citations that can resolve through that page to the exact archive messages supporting the claim

#### Scenario: Answer cites short-term messages
- **WHEN** an answer uses unconsolidated archive messages as evidence
- **THEN** the answer cites the exact chat, message, sender, and timestamp metadata for those messages

#### Scenario: Evidence is insufficient
- **WHEN** no retrieved memory page or archive message supports an answer
- **THEN** the system states that the archive does not contain enough evidence instead of inventing an unsupported answer

### Requirement: Source Layer Labels
The system SHALL label whether retrieved evidence and answer citations came from committed long-term memory or short-term archive context.

#### Scenario: Mixed evidence answer
- **WHEN** an answer uses both committed memory and current-day messages
- **THEN** the response distinguishes long-term memory citations from short-term message citations

### Requirement: Follow-Up Inspection Paths
The system SHALL provide enough citation data for local UI, CLI, MCP servers, or search APIs to reopen cited chats and nearby messages.

#### Scenario: User opens citation
- **WHEN** a user or tool follows a citation from a memory answer
- **THEN** the system can locate the original chat and message and provide surrounding context from the local archive

#### Scenario: Citation target is stale
- **WHEN** a citation points to a message that no longer exists in the archive
- **THEN** the system reports the citation as stale and identifies the affected memory page or answer segment

### Requirement: Query Privacy Defaults
The system SHALL keep memory query execution local by default and SHALL require explicit opt-in before sending query context or message evidence to a remote model provider.

#### Scenario: Remote answering disabled
- **WHEN** the user asks a query that would require remote model synthesis and remote answering is not enabled
- **THEN** the system returns local retrieval results or refuses synthesis with a privacy-safe setup message

#### Scenario: Remote answering enabled
- **WHEN** remote answering is enabled and the user asks a memory query
- **THEN** the system sends only selected retrieved snippets and citation labels to the provider and does not log query prompts or message bodies by default

### Requirement: Short-Term Cutoff Awareness
The system SHALL use the memory consolidation ledger to identify which archive messages are committed to long-term memory and which remain short-term context.

#### Scenario: Message is after committed cutoff
- **WHEN** a message timestamp is newer than the latest committed consolidation window for its chat
- **THEN** the query layer treats that message as short-term context

#### Scenario: Message is committed
- **WHEN** a message belongs to a committed source window
- **THEN** the query layer can prefer the corresponding long-term memory page while still resolving citations to the raw message
