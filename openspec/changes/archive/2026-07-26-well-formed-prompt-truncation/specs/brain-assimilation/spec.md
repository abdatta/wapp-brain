## ADDED Requirements

### Requirement: Grapheme-Safe Bounded Annotations
Every bounded annotation rendered into an evidence pack — quoted-reply snippets (in-pack and out-of-pack referents), link-preview title and description text, and source-provided transcript or accessibility text — SHALL be truncated on grapheme-cluster boundaries, never mid-cluster and never mid-surrogate-pair. Truncation SHALL be performed by one shared helper so the guarantee holds identically at every site; per-site character bounds are unchanged. A bound expressed in characters SHALL be treated as a maximum, so a cut that would split a cluster yields a shorter result rather than a broken one.

#### Scenario: Truncating an emoji at the bound
- **WHEN** a bounded annotation's character limit falls inside an astral emoji, an emoji ZWJ sequence, or a skin-tone modifier
- **THEN** the rendered annotation ends at the preceding grapheme boundary, contains no unpaired surrogate and no orphaned modifier, and stays within the bound

#### Scenario: Truncating an Indic grapheme cluster
- **WHEN** a bounded annotation's character limit falls between a base consonant and its combining matra
- **THEN** the cut moves back to the cluster boundary so the annotation contains no orphaned combining mark

#### Scenario: Primary message text is never truncated
- **WHEN** an evidence pack renders its messages
- **THEN** each message's own text is rendered in full, and only annotations are subject to bounds

### Requirement: Deterministic Provider Rejection Quarantines One Pack
When a provider rejects a specific pack's prompt deterministically — a non-retryable, deterministic-in-request failure rather than an outage — the run SHALL quarantine that pack alone: record the rejection reason against the episode, leave the remaining queue claimable, and continue. Such a rejection SHALL NOT be retried against byte-identical input, SHALL NOT count toward the provider degradation threshold, and SHALL NOT be reported to the operator as a provider outage. A run that quarantines packs SHALL end in a state naming how many were quarantined and why, so a systematic rejection is visible rather than hidden behind a successful-looking run.

#### Scenario: One unacceptable pack does not end the sweep
- **WHEN** a regeneration sweep encounters several packs the provider rejects deterministically, interleaved with packs it accepts
- **THEN** each rejected pack is quarantined with its recorded reason, every acceptable pack in the queue is still processed, and the run does not halt or report the provider as unavailable

#### Scenario: Quarantined work is reported, not silently dropped
- **WHEN** a run finishes having quarantined one or more packs
- **THEN** the run's outcome names the quarantined count and reason alongside the committed count, and the affected episodes remain identifiable for a later re-run
