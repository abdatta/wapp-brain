## 1. Configuration and contracts

- [x] 1.1 Add Google OAuth configuration, private credential path, and shared connection/sync DTOs
- [x] 1.2 Extend archive contact storage and repository contracts for source-aware Google name enrichment

## 2. Google integration service

- [x] 2.1 Implement CSRF-safe authorization URL, callback exchange, local token refresh, redacted errors, and disconnect/revocation
- [x] 2.2 Implement paginated People API reads limited to names, phone numbers, and metadata
- [x] 2.3 Implement conservative international phone normalization, ambiguity detection, and aggregate sync results

## 3. Archive enrichment

- [x] 3.1 Apply Google names transactionally to matching unresolved/weaker phone identities with deterministic source precedence
- [x] 3.2 Refresh affected archive chat labels and emit archive-change notifications after improvements

## 4. Local API and UI

- [x] 4.1 Add status, connect, callback, sync, and disconnect API routes with safe response and redirect behavior
- [x] 4.2 Add typed client calls and a Google Contacts UI panel for setup, account state, results, resync, errors, and confirmed disconnect

## 5. Privacy, documentation, and verification

- [x] 5.1 Document Google Cloud/People API setup, callback configuration, local data handling, and limitations
- [x] 5.2 Add unit and integration tests for OAuth state, token lifecycle, pagination, normalization, precedence, ambiguity, and API status
- [x] 5.3 Run `npm test`, `npm run doctor`, `npm run build`, and inspect the running local UI

## 6. Brain freshness boundary

- [x] 6.1 Require a connected Google Contacts sync before brain assimilation reads backlog
- [x] 6.2 Add tests for pre-assimilation ordering, disconnected bypass, and sync-failure abort behavior
- [x] 6.3 Re-run full verification, sync main specs, archive the change, and commit the completed work
