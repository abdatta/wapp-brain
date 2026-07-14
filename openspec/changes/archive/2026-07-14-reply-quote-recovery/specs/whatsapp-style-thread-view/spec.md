## ADDED Requirements

### Requirement: Render Reply Quote Previews
The thread UI SHALL render a reply's resolved quoted-message context as an offline WhatsApp-style preview above the reply's own content. The preview SHALL use the captured snapshot before a resolvable same-chat original, SHALL show the resolved quoted sender and complete available semantic context, and SHALL never fabricate unavailable content. Long preview text SHALL be line-clamped with an ellipsis by default and expandable in place without changing the full stored/API value. When the original is archived in the same chat, the preview SHALL offer a separate jump action through the existing anchor-centered thread route. Captured quote thumbnails and metadata SHALL be served only from the local archive and SHALL trigger no remote fetch.

#### Scenario: Text reply shows sender and quote bubble
- **WHEN** a thread message carries a captured text snapshot
- **THEN** a tinted quoted-message preview above the reply shows the resolved quoted sender and quoted text

#### Scenario: Live reply appears without backup re-import
- **WHEN** live sync archives a reply carrying an embedded quoted snapshot
- **THEN** the thread shows the same quoted-message preview shape used for backup-imported replies as soon as the archive change reaches the client

#### Scenario: Long quote expands without data loss
- **WHEN** captured quoted text exceeds the preview's default line clamp
- **THEN** the UI shows an ellipsis and a show-more control, expanding reveals the complete API-provided text, and collapsing changes only display state

#### Scenario: Structured quote has useful context
- **WHEN** a reply quotes an image, location, or vCard snapshot
- **THEN** the preview shows the captured caption/thumbnail or deterministic type-specific context instead of a bare unsupported-media marker

#### Scenario: Same-chat original is unobtrusively jumpable
- **WHEN** the quoted original resolves to an archived message in the reply's chat
- **THEN** the preview itself is an accessible jump target to `/chats/:id?at=<messageId>`, gains a subtle hover/focus treatment and pointer cursor without a visible jump button, and loads/highlights the original even when it is outside the current page

#### Scenario: Cross-chat or deleted original remains readable
- **WHEN** a snapshot exists but no original message resolves in the current chat
- **THEN** the preview remains readable from the snapshot with no fabricated jump target, hover treatment, or pointer cursor

#### Scenario: Pointer-only reply retains compatibility
- **WHEN** a reply has no captured snapshot but its legacy pointer resolves to an archived same-chat message
- **THEN** the thread shows a bounded preview from that original and preserves the jump action

#### Scenario: Missing context stays honest
- **WHEN** a reply has neither a captured snapshot nor a resolvable original
- **THEN** the thread does not invent a quoted sender, text, thumbnail, or jump target

#### Scenario: Quote preview is fully local
- **WHEN** a preview contains a captured thumbnail or structured metadata
- **THEN** rendering uses only local API data and local asset routes without contacting WhatsApp or the quoted content's origin
