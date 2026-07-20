# client-navigation Specification

## Purpose
TBD - created by archiving change client-route-architecture. Update Purpose after archive.
## Requirements
### Requirement: Each surface has its own URL
The client SHALL adopt a client-side router in which every browsable surface is reachable at its
own path. The route map SHALL be: `/chats` (chat list), `/chats/:id` (thread view), `/search`
(global archive search), `/import` (import wizard, with step sub-routes), `/contacts` (Google
Contacts and the wa.db viewer), `/brain` (brain status/runs/coverage and memory), and `/settings`
(archive status, live-sync management, theme). Visiting `/` SHALL redirect to `/chats`. Switching
surfaces SHALL change the URL rather than toggling in-component panel state.

#### Scenario: Navigating changes the URL
- **WHEN** the user activates a navigation item for a surface (e.g. Search, Brain, Contacts)
- **THEN** the browser URL changes to that surface's path and the surface's page renders

#### Scenario: Root redirects to chats
- **WHEN** the user opens `/`
- **THEN** the app redirects to `/chats` and shows the chat list

#### Scenario: Unknown path is handled, not blank
- **WHEN** the user opens a path that maps to no surface
- **THEN** the app shows a not-found route rather than a blank page, with a way back to `/chats`

### Requirement: Surfaces are deep-linkable and reload-safe
The client SHALL render the correct surface directly from its URL on a cold load or reload, without
first passing through another surface. A specific chat SHALL be addressable as `/chats/:id`, and a
specific message within it SHALL be addressable as `/chats/:id?at=<messageId>`, which opens the
thread centered on that message. The production server's SPA fallback SHALL serve the app for any
non-API path so a deep-linked reload is not a 404.

#### Scenario: Reloading a surface stays on that surface
- **WHEN** the user is on `/brain` (or any surface) and reloads the browser
- **THEN** the app loads directly into `/brain` and renders the brain surface

#### Scenario: A chat is directly linkable
- **WHEN** the user opens `/chats/:id` for an existing chat
- **THEN** the thread for that chat loads at its newest messages without first showing another chat

#### Scenario: A message is directly linkable
- **WHEN** the user opens `/chats/:id?at=<messageId>`
- **THEN** the thread loads a window centered on that message and scrolls it into view

### Requirement: Search results deep-link into threads by route
The client SHALL make a global search result open its message via a route navigation to
`/chats/:id?at=<messageId>`, replacing in-component panel switching. The opened thread SHALL be
centered on the matched message.

#### Scenario: Opening a search hit navigates by URL
- **WHEN** the user activates a result on the `/search` page
- **THEN** the app navigates to `/chats/:id?at=<messageId>` and the thread opens centered on the matched message

#### Scenario: Deep-linked hit is shareable and reload-safe
- **WHEN** the user reloads (or opens directly) a `/chats/:id?at=<messageId>` URL produced by a search hit
- **THEN** the same centered thread window is shown

### Requirement: Browser back and forward navigate surfaces
The client SHALL integrate with browser history so back and forward move between visited surfaces
and states, including returning from an opened thread to the search or chat-list surface that led
to it.

#### Scenario: Back returns to the previous surface
- **WHEN** the user navigates from `/search` into `/chats/:id?at=<messageId>` and presses browser Back
- **THEN** the app returns to `/search` with the prior surface shown

#### Scenario: Forward re-enters a surface
- **WHEN** the user presses Back and then Forward
- **THEN** the app re-enters the surface it left, consistent with browser history

### Requirement: Shell holds cross-cutting state; pages hold local state
The client SHALL separate a persistent app shell from swappable page surfaces. The shell SHALL own
cross-cutting concerns — navigation, connection/archive/brain status indicators, a single toast
host, a per-route error boundary, and the single Server-Sent-Events subscription to
`/api/archive/events` plus status/brain/live polling — exposed to pages through shared
contexts/hooks. Page-local state (thread scroll and anchor, chat-list pagination, search filters,
wizard form fields) SHALL live in the page components, not in the shell or a shared mega-component.

#### Scenario: Status and toasts persist across navigation
- **WHEN** the user navigates between surfaces
- **THEN** the shell's status indicators and any active toast remain, and the SSE subscription is not torn down and re-created per navigation

#### Scenario: An in-progress background job stays visible across surfaces
- **WHEN** a brain run or search index build is in progress and the user changes surfaces
- **THEN** its progress and any completion/failure toast remain visible because that state lives in the shell, not a single page

#### Scenario: A page render error is contained
- **WHEN** one page throws during render
- **THEN** the per-route error boundary shows a readable error for that surface while the shell (nav, status) stays usable, and the error is logged to the console

### Requirement: New UI surfaces are added as routes, not panels
New client UI features SHALL be added as new routes/pages, or as sections of an owning page, and
SHALL NOT be added as new sections of a single shared mega-component. Routes reserved for later
changes (`/people`, `/brain/query`, `/brain/eval`, and grants under `/settings`) SHALL be built as
their own pages/sections when their owning change lands.

#### Scenario: A future surface is born as a page
- **WHEN** a later change adds a substantial new surface (e.g. people management, brain query, eval grading, grants, backfill dashboard)
- **THEN** it is implemented as its own route/page (or a section of an owning page), not appended to a shared mega-component

### Requirement: Route surfaces are lazily code-split
The client SHALL load page surfaces via route-level lazy code splitting so each surface is a
separately loaded chunk, with a loading indicator shown while a surface's code is fetched.

#### Scenario: A surface's code loads on demand
- **WHEN** the user first navigates to a surface
- **THEN** that surface's code chunk is loaded on demand and a loading indicator is shown until it renders

#### Scenario: Async work shows progress and never fails silently
- **WHEN** any surface performs an operation that takes longer than roughly a second (search, index build, brain run, import)
- **THEN** progress is shown while it runs and any failure surfaces as a visible toast and a console log rather than failing silently

### Requirement: Graph explorer is reachable and deep-linkable
The client SHALL add a `/graph` surface as its own route, loaded as a lazy code-split chunk with a loading indicator, and reachable from the primary navigation. The graph surface SHALL be deep-linkable and reload-safe: a URL that names an anchor (by node id, else JID, else name) SHALL open the explorer anchored on that node directly from a cold load. Person, entity, and episode surfaces SHALL offer a "view in graph" affordance that navigates to the graph anchored on the relevant node (an episode anchoring on its chat node). Adding this surface SHALL follow the routes-not-panels rule — a new page, not a section of a shared mega-component.

#### Scenario: Graph is a navigable, lazily-loaded route
- **WHEN** the user activates the Graph navigation item
- **THEN** the URL changes to `/graph`, the graph surface's code chunk loads on demand with a loading indicator, and the explorer renders

#### Scenario: An anchored graph URL is reload-safe
- **WHEN** the user opens or reloads a `/graph` URL that names an anchor
- **THEN** the app loads directly into the graph explorer anchored on that node without first passing through another surface

#### Scenario: View in graph from another surface
- **WHEN** the user activates "view in graph" from a person, entity, or episode surface
- **THEN** the app navigates to `/graph` anchored on the corresponding node (the chat node for an episode) and the explorer opens on that neighborhood

#### Scenario: Back returns from the graph to the originating surface
- **WHEN** the user navigates into `/graph` from another surface and presses browser Back
- **THEN** the app returns to the originating surface, consistent with browser history

