## MODIFIED Requirements

### Requirement: Open selected chats at the newest messages
The UI SHALL address the thread view as the route `/chats/:id` and load the newest message window
for that chat, positioning the message pane at the bottom after the first page renders. Selecting a
chat from the list SHALL navigate to `/chats/:id` rather than switching an in-component panel. A
specific message SHALL be addressable as `/chats/:id?at=<messageId>`, which loads a window centered
on that message and scrolls it into view instead of anchoring at the bottom.

#### Scenario: Selecting a chat scrolls to bottom
- **WHEN** the user selects a chat with more messages than the first page size
- **THEN** the app navigates to `/chats/:id`, the newest available messages are displayed, and the scroll position is anchored near the bottom of the thread

#### Scenario: Message search resets to newest matching results
- **WHEN** the user changes the message search query for a selected chat
- **THEN** the loaded message window resets to the newest matching results and the scroll position moves near the bottom

#### Scenario: Anchored deep link centers on a message
- **WHEN** the thread is opened at `/chats/:id?at=<messageId>` (by a search hit or a direct/reloaded link)
- **THEN** the UI loads a window centered on that message and scrolls it into view, and exiting the window ("Latest messages") returns to `/chats/:id` at the newest messages
