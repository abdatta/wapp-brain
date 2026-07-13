## ADDED Requirements

### Requirement: Chat list is the route-addressable `/chats` page
The chat list SHALL be the `/chats` page surface. Selecting a chat SHALL be a route change to
`/chats/:id` (the list remaining visible as the master pane), and the currently open chat SHALL be
derivable from the URL so the selection survives a reload. The list's own view state (search text,
type filter, event-only toggle, pagination) SHALL be page-local and MUST NOT require a shared
mega-component.

#### Scenario: Selection is a route change
- **WHEN** the user clicks a chat in the list
- **THEN** the URL changes to `/chats/:id` and that chat's thread opens while the list stays visible

#### Scenario: Open chat is derived from the URL
- **WHEN** the page loads at `/chats/:id`
- **THEN** the corresponding chat is shown as selected in the list and its thread is open, without first selecting a different chat

#### Scenario: List filters remain page-local
- **WHEN** the user sets the chat search, type filter, or event-only toggle and then navigates away and back to `/chats`
- **THEN** the list behaves as before (filters are page state), with no dependency on a shared mega-component
