# chat-brain-muting Specification

## Purpose
Let the user stop the brain from reading chats they do not care about — reversibly, from any past date, through arbitrary mute → unmute → re-mute sequences — without touching ingestion. Muting suppresses every brain producer and hides every muted-derived artifact behind one server-side predicate, while the chat keeps archiving every message and media blob; artifacts are hidden, never deleted, and return intact on unmute.
## Requirements
### Requirement: Mute Interval Model
The system SHALL store per-chat mute state as a set of independent date ranges `[start, until)` per chat, where an open range (no until) means currently muted. Muting from a date SHALL insert an open range; unmuting from a date SHALL truncate or remove every range at and beyond that date; both operations SHALL keep the stored set canonical — non-overlapping, merged where adjacent or overlapping — so a chat can pass through arbitrary mute → unmute → re-mute sequences (muted from A, unmuted from B, re-muted from C) and any timestamp in the chat's history evaluates unambiguously as muted or not. Chat identity SHALL use canonical JIDs like every other chat-keyed table. Mute and unmute dates MAY lie in the past.

#### Scenario: Arbitrary sequences evaluate correctly
- **WHEN** a chat is muted from date A, unmuted from date B (B after A), then re-muted from date C (C after B)
- **THEN** timestamps in [A,B) and at/after C evaluate as muted, timestamps before A and in [B,C) evaluate as not muted

#### Scenario: Backdated unmute erases what it covers
- **WHEN** a chat muted from A is unmuted from a date before A
- **THEN** no muted range remains and the chat's entire history evaluates as not muted

#### Scenario: Overlapping mutes merge
- **WHEN** a chat already muted from A receives another mute from an earlier date
- **THEN** the stored set remains one canonical range starting at the earlier date, not two overlapping ranges

### Requirement: Channels Are Born Muted
Any chat whose JID is channel-shaped (`@newsletter`, chat type `community`) SHALL default to muted for its entire history as a standing rule — applying to already-known channels and to any channel first seen in the future, with no seeding step. An explicit unmute on a specific channel SHALL override the default for that channel per the normal interval model.

#### Scenario: Future channel subscription arrives muted
- **WHEN** a newly subscribed channel's chat is first observed after this change ships
- **THEN** it is muted for its entire history without any user action, generates no brain output, and appears in the muted-items view

#### Scenario: Explicit unmute overrides the channel default
- **WHEN** the user unmutes one channel from a chosen date
- **THEN** that channel's content from that date onward is processed and surfaced like any normal chat while other channels stay muted

### Requirement: Muting Never Touches Ingestion
Muting SHALL affect only brain-side processing and presentation. A muted chat SHALL keep archiving every message, media blob, receipt, and metadata update identically to an unmuted chat — ingestion, media download, FTS indexing, the chats UI, and message search are all unaffected by mute state.

#### Scenario: Muted chat keeps archiving
- **WHEN** messages with media arrive in a muted chat
- **THEN** they are stored, their media downloaded, and they are visible in the chat thread and message search exactly as for an unmuted chat, while no brain artifact derives from them

### Requirement: No Brain Output From Muted Ranges
No brain or brain-subchild artifact SHALL be derived from messages inside a muted range. This SHALL hold across every producer: episode/backlog selection, evidence pack assembly, task enqueueing (queued tasks for a newly muted chat are dropped), the deterministic graph signal sync (no chat/person nodes or membership edges materialized from a muted chat's raw signals), person co-citation suggestions, topic vocabulary offered to other chats' prompts, doc rollup claim scoping, and memory (REM) consolidation. A muted chat's watermark SHALL freeze rather than advance past unprocessed muted messages while the mute is open.

#### Scenario: Muted chat produces nothing during a sweep
- **WHEN** a brain run, auto pass, or backfill audit executes while a chat is muted
- **THEN** the chat is not selected, no episode/claim/graph/doc/person/memory artifact derives from its muted range, and any previously queued tasks for it are dropped rather than executed

#### Scenario: Bypass producers respect mute
- **WHEN** the graph signal sync and person-suggestion detectors run with a muted chat present
- **THEN** they materialize no nodes, edges, or suggestions from that chat's muted range, and the muted chat's topics are not offered as vocabulary to other chats' prompts

### Requirement: Piled-Up Accounting For Muted Chats
For every currently muted chat the system SHALL report, derived (never stored as counters): muted-since, and the number of messages and media items accumulated since the brain's frozen watermark. Coverage and backfill statistics SHALL exclude muted-range messages from their denominators so overall coverage can reach 100% and ETA math stays truthful while chats are muted.

#### Scenario: Piled-up counts are visible
- **WHEN** a muted chat receives 40 messages and 5 media items after its watermark froze
- **THEN** the muted-items view reports 40 messages and 5 media items piled up for that chat, derived from the watermark and message store

#### Scenario: Coverage ignores muted ranges
- **WHEN** overall brain coverage is computed while chats are muted with unprocessed backlogs
- **THEN** muted-range messages are excluded from the denominator, coverage can report 100%, and the muted backlog is not presented as pending debt

### Requirement: Muted Artifacts Hide, Never Delete
Brain artifacts sourced from muted ranges SHALL be hidden from all normal brain surfaces — episode lists, commitments/lifecycle, graph queries and neighborhood traversals, doc/page lists, brain status samples, and the vault projection — while remaining fully stored. Muted-ness SHALL be evaluated from the interval set at query time through a single shared predicate (an artifact is muted when its source chat and time span fall inside a muted range; an episode overlapping a mute boundary counts as muted), so hiding is instantly reversible and can never drift stale. The vault projection SHALL exclude muted artifacts; because the vault is a pure projection, unmuting plus reprojection restores their files. Server-side enforcement SHALL be the single point of truth so every consumer (UI, CLI, future MCP/retrieval surfaces) inherits the same hiding.

#### Scenario: Hidden everywhere, deleted nowhere
- **WHEN** a chat with existing episodes, commitments, and graph contributions is muted for the range containing them
- **THEN** those artifacts disappear from episode lists, commitment lists, graph reads, docs, status samples, and the projected vault, while their rows remain intact in storage

#### Scenario: Boundary-straddling episode hides
- **WHEN** an existing episode's time span overlaps a muted range at either edge
- **THEN** the episode (and artifacts derived from it) is treated as muted and hidden, remaining reachable only through the muted-items view

### Requirement: Hybrid Pages Keep Showing With Redirected Links
A page fed by both muted and non-muted sources SHALL keep rendering on normal surfaces. Its source links SHALL discriminate per source: links to non-muted material behave normally, links to muted-source material route into the muted-items view instead of the normal artifact page. A page fed exclusively from muted sources SHALL hide from normal surfaces and be reachable only through the muted-items view. Future rollups SHALL exclude muted claims from a page's scope, and a mute state change SHALL mark affected pages due so the normal dueness-driven rollup cadence drains muted-derived prose over time — no forced immediate re-roll. Page muted/hybrid classification MAY be materialized per page for cheap list rendering but SHALL be refreshed on every mute state change and rollup.

#### Scenario: Hybrid page renders with discriminated links
- **WHEN** a page was rolled up from claims of a muted chat and a non-muted chat
- **THEN** the page renders normally, its non-muted source links resolve normally, and its muted source links route into the muted-items view

#### Scenario: Exclusively muted page hides
- **WHEN** every claim feeding a page traces to muted ranges
- **THEN** the page disappears from normal doc lists and its detail route, and is browsable only from the muted-items view

#### Scenario: Muting marks affected pages due
- **WHEN** a chat is muted and pages exist that were fed by its claims
- **THEN** those pages are marked due for rollup, and their next dueness-driven rollup excludes the muted claims from scope

### Requirement: Muted-Items View
The system SHALL provide a distinct muted-items surface (`/brain/muted`) listing every currently muted chat with: display name, muted-since, and piled-up message/media counts since the frozen watermark; drill-in to that chat's hidden artifacts (episodes, commitments, pages, graph entities); one-click unmute (with date selection); and a control to mute additional chats. Hybrid pages' muted-source links SHALL land here. The main brain surface SHALL summarize muted state (count of muted chats and total piled-up volume) so accumulation is noticeable without visiting the view.

#### Scenario: Muted view shows the full muted estate
- **WHEN** the user opens the muted-items view with three muted chats
- **THEN** each row shows name, muted-since, and piled-up counts, and expanding a chat reveals its hidden episodes, commitments, and pages

#### Scenario: Muting a new chat from the view
- **WHEN** the user adds a mute for another chat from the muted-items view
- **THEN** the chat joins the list with its chosen mute-from date and brain processing stops selecting it immediately

### Requirement: Mute Controls In Chat Surfaces
Mute and unmute SHALL be operable from the chat surfaces the user already visits: a mute control in the chat thread header and mute state visible in the chat list. The mute control SHALL default to muting from now, and SHALL offer a backdate picker and an entire-history preset. Unmute SHALL likewise accept a from-date, defaulting to now.

#### Scenario: Mute from the thread header
- **WHEN** the user opens a noisy group's thread and hits mute, accepting the default
- **THEN** an open mute range starting now is recorded, and the chat is skipped by the next brain sweep

#### Scenario: Entire-history mute
- **WHEN** the user chooses the entire-history preset on a chat with years of processed history
- **THEN** the chat's full timeline evaluates as muted, all its existing brain artifacts hide, and affected hybrid pages are marked due

### Requirement: Unmute Restores And Resumes
Unmuting a range SHALL make previously hidden artifacts inside that range reappear on all normal surfaces (including the vault after reprojection) and become usable as sources for further processing, and SHALL resume forward processing: the chat re-enters backlog selection from its frozen watermark, evidence selection skips any still-muted holes between the watermark and the unmute date, and the watermark advances through skipped holes without fabricating coverage claims about them.

#### Scenario: Hidden artifacts reappear
- **WHEN** a range whose episodes and commitments were hidden is unmuted
- **THEN** they reappear in episode lists, commitments, graph reads, docs candidacy, and the vault after reprojection, with no regeneration required

#### Scenario: Resume skips still-muted holes
- **WHEN** a chat muted from A is unmuted from B (later than A) and processing resumes
- **THEN** messages in [A,B) are never selected as evidence, packs form from B onward, and the watermark advances past the hole so the muted backlog does not linger as pending debt
