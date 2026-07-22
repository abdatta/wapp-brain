# client-navigation — Delta Spec (semantic-rollups)

## ADDED Requirements

### Requirement: Brain pages are reachable and deep-linkable
The client SHALL provide routed brain-page surfaces: `/brain/pages` (docs list with dueness and issue chips) and `/brain/pages/:docId` (rendered page with citation click-through to threads, revision history, and rollback), loaded as lazily code-split route chunks per the routing conventions. Graph explorer nodes that have docs SHALL offer an "open page" navigation to the doc route, and doc pages SHALL offer a "view in graph" navigation to the explorer anchored on their node — completing the reciprocal deep-link loop. A doc whose node has merged SHALL resolve its route through the redirect to the survivor's doc.

#### Scenario: Doc page is directly linkable
- **WHEN** the user opens `/brain/pages/:docId` for an existing doc (cold load or reload)
- **THEN** the rendered page loads directly with history and citation click-through working

#### Scenario: Graph and pages link both ways
- **WHEN** the user opens a page from a graph node, or the graph from a page
- **THEN** navigation lands on the corresponding doc route or the explorer anchored on the doc's node

#### Scenario: Page reaches its own run history
- **WHEN** the user opens a doc page
- **THEN** it offers a run-history navigation to `/brain/runs?doc=:docId`, which lists only that page's runs and links back to the page — with an escape to the unscoped history

#### Scenario: Merged doc route redirects
- **WHEN** the user opens a doc route whose node has merged into a survivor
- **THEN** the survivor's doc renders (with the redirect indicated), never a dangling or blank page
