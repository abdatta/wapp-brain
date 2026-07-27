## MODIFIED Requirements

### Requirement: Watermark Coverage Truth
The brain SHALL track per-chat assimilation watermarks as a compound cursor of timestamp and message rowid that advances only when an episode commits, and SHALL derive all coverage decisions (what to assimilate next, what coverage to report) from that cursor rather than from schedule execution. Coverage and backlog SHALL derive from a single pending predicate so that no visible message is ever both reported covered and never selected: a visible message is covered for its chat only when a watermark row exists and the message is at or before the cursor (its timestamp is before the cursor timestamp, or equal to it with a message rowid at or below the cursor rowid); every other visible message is pending, including any message in a chat with no watermark row. Because the cursor includes the rowid, a genuinely-new message sharing the watermark timestamp is pending regardless of whether the boundary message was cited. Assimilated coverage SHALL be reported as total visible messages minus pending, never from an independent `<=` timestamp predicate. Messages inside a muted range SHALL be excluded from the visible-message universe for coverage and backlog purposes: they are neither pending nor assimilated, a muted chat's frozen watermark does not read as permanent pending debt, and when processing resumes after an unmute the watermark MAY advance past never-assimilated muted holes without those messages ever being reported as covered evidence.

#### Scenario: Crash before commit
- **WHEN** a run is interrupted after generation but before an episode commits
- **THEN** the chat's watermark is unchanged and the next run re-covers the same window idempotently

#### Scenario: Coverage reported from watermarks
- **WHEN** brain status is requested
- **THEN** it reports assimilated-through timestamps and pending counts per chat derived from watermarks, with assimilated equal to total visible minus pending

#### Scenario: Message tied to the watermark stays visible
- **WHEN** a second visible message arrives with a timestamp exactly equal to a chat's watermark after that chat's episode has committed
- **THEN** it has a higher rowid than the cursor, appears in the backlog, is not counted as assimilated, and is selected into the next evidence pack

#### Scenario: Seen boundary message is not re-opened
- **WHEN** a committed episode's boundary message was not cited by any claim
- **THEN** it remains covered (its rowid is at or below the cursor) and is not re-selected into a new episode

#### Scenario: No phantom coverage without a watermark
- **WHEN** a chat has visible messages but no watermark row (including a message whose timestamp is zero)
- **THEN** every such message is counted pending and none is reported assimilated

#### Scenario: Muted messages are outside the coverage universe
- **WHEN** coverage and backlog are computed while a chat holds unprocessed messages inside a muted range
- **THEN** those messages count neither as pending nor as assimilated, overall coverage can reach 100%, and the muted chat does not appear in backlog samples or dueness decisions

#### Scenario: Watermark advances past a muted hole without claiming it
- **WHEN** a chat muted from A is unmuted from B and an episode for post-B evidence commits
- **THEN** the watermark advances beyond the [A,B) hole, the hole's messages are never selected or reported as assimilated evidence, and coverage arithmetic stays consistent because they are excluded from the universe
