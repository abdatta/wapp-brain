# Live Sync Gap Count For Older Chats

## Type

Investigation

## Status

Needs diagnosis

## User Observation

After sync, the app reported 3842 detected gaps.

The working theory is that WhatsApp Web may not emit anything for chats whose latest updates are more than about one year old. Those older chats may appear as gaps even though there is no new data to fetch because the chat has been quiet for more than a year.

## Expected Behavior

Live sync health should distinguish between actionable missing data and uncertainty caused by platform history limits or old quiet chats.

The app should not overwhelm the user with thousands of gaps if most of them mean "not enough platform evidence to prove continuity for an old quiet chat."

## Behavior Questions

- What should count as a recoverable gap versus an unprovable quiet-chat window?
- Should old chats enter a separate state such as `uncertain_due_to_history_limit` instead of `needs_user_action`?
- Should the health summary group similar old-chat uncertainties instead of listing every chat as an individual urgent gap?
- What user action, if any, can improve confidence for chats older than the platform's history-sync horizon?

## Privacy Notes

Gap diagnostics should avoid exposing message bodies. Summaries should use chat identifiers, age ranges, counts, and status categories where safe.

## Acceptance Sketch

- **WHEN** live sync cannot prove continuity for an old quiet chat because no platform evidence is available
- **THEN** the app reports the uncertainty separately from actionable missing-message gaps.

- **WHEN** many chats share the same old-history limitation
- **THEN** the health view groups or summarizes them so the user can understand the pattern without reviewing thousands of entries.

