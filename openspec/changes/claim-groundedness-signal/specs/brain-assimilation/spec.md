## ADDED Requirements

### Requirement: Honest Operator Defect Count
Any operator-facing count presented as the archive's outstanding quality problems SHALL include only issues that are both actionable and attached to a `current` episode. Issues recorded against superseded episodes SHALL be excluded, because the episode they describe has already been replaced. Advisory observations and by-design notices SHALL be excluded from the headline figure. Excluded rows SHALL remain queryable and SHALL be reachable as a labelled breakdown, so nothing is hidden — only the headline is made to mean what it says. The distinction SHALL derive from the issue's recorded severity and its episode's status rather than from a hardcoded list of issue codes, so a newly added code cannot silently inflate the number.

#### Scenario: Superseded issues leave the headline
- **WHEN** most recorded issues belong to extractive episodes that regeneration has since superseded
- **THEN** the headline defect count excludes them and reflects only issues on current episodes, while the breakdown still shows the superseded total

#### Scenario: Advisory observations do not inflate the count
- **WHEN** an advisory lint records warnings across many current episodes
- **THEN** those rows do not enter the headline defect count, and the surface presents them under their own label with their own count

#### Scenario: A new advisory code cannot inflate the count
- **WHEN** a new advisory issue code begins being written at `info` severity
- **THEN** the headline count is unchanged without any edit to the counting logic

## MODIFIED Requirements

### Requirement: Lexical Anchoring Lint
After a model episode is accepted, each claim SHALL be checked for lexical anchoring: sharing at least one distinctive token with the concatenated text of its cited messages (claims citing only text-less media messages exempt). A failing claim SHALL be recorded as an `unanchored` row in the validation-issues table, keyed to its episode and claim sequence, at advisory (`info`) severity. The lint SHALL flag and never block: it consumes no model call and never rejects a commit. The lint is a lexical heuristic, not a groundedness verdict — on code-mixed archives a faithful cross-language paraphrase shares no token with its source — so its rows SHALL NOT be presented as defects and SHALL NOT enter the operator-facing defect count. Its rows SHALL instead prioritize the order in which claims are graded, so the cheap signal directs the expensive one. Whether the lint is retained, tuned, or removed SHALL be decided from its measured precision against grades rather than from assumption.

#### Scenario: Unanchored claim flagged, not blocked
- **WHEN** an accepted claim shares no distinctive token with its cited messages
- **THEN** the episode still commits and an `unanchored` advisory row is recorded for that claim

#### Scenario: Anchored claim passes silently
- **WHEN** a claim paraphrases its cited messages but shares a distinctive token with them
- **THEN** no issue row is written

#### Scenario: Cross-language paraphrase is not a defect
- **WHEN** a claim faithfully renders code-mixed source text into English and therefore shares no distinctive token with it
- **THEN** the advisory row is recorded, the claim's episode is prioritized for grading, and the operator-facing defect count is unaffected

#### Scenario: Lint precision is measured, not assumed
- **WHEN** grades exist for both flagged and unflagged claims
- **THEN** the system can report the flagged population's rate of non-`supported` grades against the unflagged population's, so the lint's value is a measured figure
