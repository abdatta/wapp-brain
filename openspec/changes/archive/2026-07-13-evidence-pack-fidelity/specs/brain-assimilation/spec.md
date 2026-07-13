## MODIFIED Requirements

### Requirement: Evidence Selection Policy

Evidence packs SHALL contain only conversation messages per the visible-exchange definition, rendered in resolved identity text with interpretation labels for non-text content, bounded in size, split at long silence gaps, and bounded to a maximum time span; system, reaction, and encrypted-update rows SHALL never consume model budget. Reactions on a pack message SHALL render as non-citable annotations on that message's evidence line, resolving each reactor to the same identity text as senders. A quoted reply SHALL carry a compact referent: the quoted message's citation alias when that message is in the pack, otherwise a non-citable inline snippet. A forwarded message SHALL be labelled as forwarded, with a prompt rule to attribute its content as shared or forwarded rather than said. A sender without a resolved display name SHALL be labelled by its verbatim number rather than the literal text "Unknown", and the prompt SHALL instruct referring to that participant by exactly that number. When two participants in one pack resolve to the same display name, each colliding label SHALL receive a deterministic disambiguating suffix and the prompt SHALL instruct using exactly the labels shown. Aliases SHALL be assigned only to real messages present in the pack; no annotation (reaction, out-of-pack quoted referent) SHALL be citable.

#### Scenario: Noise excluded from evidence

- **WHEN** a window contains system events and reactions alongside conversation
- **THEN** only conversation messages enter the evidence pack while reactions still appear as annotations on their target messages

#### Scenario: Oversized window split

- **WHEN** a chat window exceeds the evidence size bound
- **THEN** it is split into sequenced packs at silence gaps and each pack is processed as its own task

#### Scenario: Reaction annotated on its target, cited through it

- **WHEN** a pack message has one or more reactions
- **THEN** the reactions render inline on that message's evidence line with each reactor resolved to identity text, the reactions consume no alias and no budget line, and a claim about the acknowledgment cites the target message's alias

#### Scenario: In-pack quoted reply resolves to the referent alias

- **WHEN** a reply's quoted message is present in the same pack
- **THEN** the reply line carries a referent that names the quoted message's citation alias and a truncated snippet of it, so a claim may cite the referent by that alias

#### Scenario: Out-of-pack quoted reply is a non-citable snippet

- **WHEN** a reply's quoted message is not present in the pack
- **THEN** the reply line carries an inline snippet of the quoted message with its sender label and no citation alias, and no claim can cite the quoted message

#### Scenario: Forwarded message attributed as shared

- **WHEN** a pack contains a message flagged as forwarded
- **THEN** its evidence line is labelled as forwarded and the prompt instructs attributing the content as shared or forwarded rather than as something the forwarder said

#### Scenario: Unresolved sender labelled by number

- **WHEN** a pack contains a message from a sender with no resolved display name
- **THEN** its evidence line labels the sender by its verbatim number, the prompt instructs referring to that participant by exactly that number, and two unresolved senders with different numbers are distinguishable

#### Scenario: Same-name participants disambiguated

- **WHEN** two participants in one pack resolve to the same display name
- **THEN** each colliding label receives a deterministic number-derived suffix that makes the labels distinct and the prompt instructs using exactly the labels shown

#### Scenario: Quiet chat produces span-bounded episodes

- **WHEN** a chat's unassimilated backlog spans more than the maximum episode span with no long silence gap
- **THEN** `buildEvidencePacks` splits it into multiple packs each within the span cap, and neither the segmentation nor the greedy merge produces a pack exceeding the cap
