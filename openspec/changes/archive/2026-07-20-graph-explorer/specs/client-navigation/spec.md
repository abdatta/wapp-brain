## ADDED Requirements

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
