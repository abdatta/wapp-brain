# client-navigation Delta Spec

## ADDED Requirements

### Requirement: Call audit surface is its own route
The call-audit read surface SHALL be a first-class client route (`/brain/calls`), not an in-page panel, consistent with the rule that new UI surfaces are added as routes. It SHALL be deep-linkable and reload-safe, lazily code-split like the other brain surfaces, and reachable from the brain run console via a link. A single call's detail SHALL be addressable so it can be opened and reloaded directly.

#### Scenario: Calls surface is reachable and reload-safe
- **WHEN** the owner navigates to `/brain/calls` or reloads it directly
- **THEN** the calls surface renders on its own URL without requiring navigation through another page, and the run console links to it

#### Scenario: A call is deep-linkable
- **WHEN** the owner opens a specific call's detail and reloads the page
- **THEN** the same call's detail is restored from its URL
