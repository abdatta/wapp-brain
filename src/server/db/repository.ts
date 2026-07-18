import type {
  ArchiveSignalBatch,
  ChatMetadataHistoryRecord,
  EngagementAggregateRecord,
  BrainChatBacklogItem,
  BrainClaimGradeRecord,
  BrainClaimGradeValue,
  BrainEpisodeGenerator,
  BrainEpisodeInput,
  BrainEpisodeRecord,
  BrainEvalRunRecord,
  BrainGradingSample,
  BrainGraphEntityView,
  BrainGraphRebuildResult,
  BrainGraphRecomputeResult,
  BrainGraphStats,
  BrainGraphSyncResult,
  BrainGraphUnresolvedEntity,
  BrainModelQualityAggregate,
  BrainLlmUsageSummary,
  BrainMediaGapImpact,
  BrainMediaGapSummary,
  BrainResolutionDebtSummary,
  BrainRunSummary,
  BrainStatusSummary,
  BrainTaskInput,
  BrainTaskKind,
  BrainTaskRecord,
  BrainTaskSummary,
  BrainValidationIssueInput,
  BrainValidationIssueRecord,
  BrainValidationIssueSummary,
  CapturedLinkPreview,
  ChatListItem,
  ChatRecord,
  ChatSyncStateRecord,
  ContactRecord,
  GoogleContactCandidate,
  GoogleContactsSyncResult,
  GroupMembershipEventRecord,
  GroupMembershipPeriodRecord,
  IdentityNumberChangeRecord,
  IdentityRecentMedia,
  IdentityRecentMessage,
  IdentityRepairResult,
  ImportTotals,
  ImportWarning,
  LiveChatCheckpointRecord,
  LiveEventReceiptRecord,
  LiveGapStatus,
  LiveGapWindowRecord,
  LiveMaintainerStatusSummary,
  LiveMessageUpdateRecord,
  LiveMessageUpdateResult,
  LiveSessionSummary,
  LiveSyncRunSummary,
  LiveSyncTotals,
  MediaAssetRecord,
  MediaDownloadQueueRecord,
  MediaQueueSummary,
  MessageEditRevisionRecord,
  MessageDetail,
  MemoryCitationRecord,
  MemoryEvidenceMessage,
  MemoryEvidencePackRecord,
  MemoryPageRevisionRecord,
  MemoryProviderStatus,
  MemoryRunSummary,
  MemorySourceWindowRecord,
  MemoryStatusSummary,
  MemoryValidationIssue,
  MessageContextWindow,
  MessageListItem,
  MessageRecord,
  MessageSecretRecord,
  OwnerIdentitySuggestion,
  OwnerSelfIdentity,
  ParticipantRecord,
  RetainedPayloadRecord,
  ChatListOptions,
  RecoveryAnchorRecord,
  SearchIndexStatus,
  SearchQueryOptions,
  SearchResponse,
  StatusSummary,
  GoogleContactGroupEntry,
  IdentityActivitySummary,
  IdentityChatActivity,
  IdentityProfile,
  PersonConnectResult,
  PersonDisconnectResult,
  PersonLinkEventRecord,
  PersonLinkSuppressionRecord,
  PersonLookupResult,
  PersonMemberSource,
  PersonRecord,
  PersonSuggestionInput,
  PersonSuggestionKind,
  PersonSuggestionRecord,
  PersonSuggestionStatus
} from "../../shared/types";

export interface ArchiveRepository {
  createRestorePoint(label: string): Promise<ArchiveRestorePoint>;
  startImportRun(sourceSummary: Record<string, unknown>): Promise<string>;
  completeImportRun(runId: string, totals: ImportTotals, warningCount: number): Promise<void>;
  failImportRun(runId: string, code: string, message: string, totals?: ImportTotals, warningCount?: number): Promise<void>;
  addWarnings(runId: string, warnings: ImportWarning[]): Promise<void>;
  upsertContacts(runId: string, contacts: ContactRecord[]): Promise<Map<string, number>>;
  enrichContactsFromGoogle(contacts: GoogleContactCandidate[]): Promise<Pick<GoogleContactsSyncResult, "matchedIdentities" | "improvedNames">>;
  upsertChats(runId: string, chats: ChatRecord[]): Promise<Map<string, number>>;
  upsertParticipants(participants: ParticipantRecord[]): Promise<number>;
  upsertMessages(messages: MessageRecord[]): Promise<number>;
  // Local-only structured source signals. A batch is idempotent and returns
  // message anchors materially enriched so brain evidence can become stale
  // without any raw WhatsApp rows escaping the importer.
  upsertArchiveSignals(batch: ArchiveSignalBatch): Promise<{ changedMessageKeys: string[]; skippedUnanchoredRecords: number }>;
  // One-time repair for the pre-role-correct parser bug. Only facts whose sole
  // evidence was the ambiguous backup flag are removed; generic source
  // messages and verified membership history remain untouched.
  repairAmbiguousSelfMembershipFacts(): Promise<number>;
  listIdentityNumberChanges(options?: { oldJid?: string; newJid?: string; limit?: number }): Promise<IdentityNumberChangeRecord[]>;
  listGroupMembershipPeriods(options?: { groupSourceId?: string; participantJid?: string; limit?: number }): Promise<GroupMembershipPeriodRecord[]>;
  listGroupMembershipEvents(options?: { groupSourceId?: string; participantJid?: string; limit?: number }): Promise<GroupMembershipEventRecord[]>;
  listChatMetadataHistory(options?: { chatSourceId?: string; limit?: number }): Promise<ChatMetadataHistoryRecord[]>;
  // Engagement is intentionally not returned by general message/status reads.
  listEngagementAggregates(options?: { chatSourceId?: string; counterpartyJid?: string; limit?: number }): Promise<EngagementAggregateRecord[]>;
  recordIdentityLinks(links: Array<{ lid: string; pn: string; source?: string | null }>): Promise<string[]>;
  resolveIdentityJid(jid: string): Promise<string>;
  // Reverse of resolveIdentityJid: the LID form(s) known for a phone JID (or the
  // JID itself if it is already a LID). Secret-encrypted edit decryption binds
  // the exact LID the sender used, so it needs the LID, not the canonical phone.
  getIdentityLidsForJid(jid: string): Promise<string[]>;
  listUnmergedLidIdentities(limit?: number): Promise<Array<{ lid: string; pn: string }>>;
  mergeIdentity(lid: string, pn: string): Promise<{ chatsMerged: number; contactsMerged: number; messagesCollapsed: number }>;
  // Identity late-resolution: one entry point every resolution source routes
  // through to deterministically repair derived layers keyed on an improved
  // identity (search text + brain prose/projection), with no model call. Called
  // internally by the name-gained and merge write paths; also callable directly
  // by future name sources.
  repairIdentityResolution(jids: string | string[]): Promise<IdentityRepairResult>;
  // One-time idempotent pass that repairs episodes written before the identity
  // repair machinery existed, for identities that already resolve to a name.
  backfillIdentityResolution(): Promise<IdentityRepairResult>;
  // The resolution-debt surface: episodes still referring to people by number,
  // ranked by message volume. Computed with no model call.
  getBrainResolutionDebt(options?: { limit?: number }): Promise<BrainResolutionDebtSummary>;
  // Collapse rows stored under a superseded identity (e.g. an edited message's
  // edit key from an earlier importer) onto their canonical row; removed rows
  // route through memory staleness.
  collapseSupersededMessages(
    pairs: Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>
  ): Promise<number>;
  listUnnamedGroupChats(limit?: number): Promise<string[]>;
  // One-time hygiene: live rows archived from Signal-protocol transport
  // envelopes (sender-key distribution) before they were filtered at
  // normalization. They are protocol noise, never user messages.
  removeProtocolNoiseMessages(): Promise<number>;
  // Unknown-type worksheet source: per-code counts with example locations
  // (chat display labels and timestamps only — never message content).
  listUnknownTypeCodes(): Promise<Array<{ code: string; count: number; examples: Array<{ chatLabel: string; timestampMs: number | null }> }>>;
  clearIdentityDerivedChatNames(): Promise<number>;
  refreshChatStats(chatSourceIds?: string[]): Promise<void>;
  clearArchiveData(): Promise<void>;
  getStatus(): Promise<StatusSummary>;
  upsertLiveSession(session: Partial<LiveSessionSummary> & { id: string; status: LiveSessionSummary["status"]; clientName: string }): Promise<void>;
  reconcileLiveState(): Promise<{ staleSessions: number; staleRuns: number }>;
  startLiveSyncRun(sourceSummary: Record<string, unknown>): Promise<string>;
  completeLiveSyncRun(runId: string, totals: LiveSyncTotals, warningCount: number): Promise<void>;
  failLiveSyncRun(runId: string, code: string, message: string, totals?: LiveSyncTotals, warningCount?: number): Promise<void>;
  upsertLiveCheckpoint(checkpoint: LiveChatCheckpointRecord): Promise<void>;
  listLiveCheckpoints(chatSourceIds?: string[]): Promise<LiveChatCheckpointRecord[]>;
  listChatSyncStates(chatSourceIds?: string[]): Promise<ChatSyncStateRecord[]>;
  getRecoveryAnchor(chatSourceId: string, afterMs: number | null): Promise<RecoveryAnchorRecord | null>;
  upsertLiveGap(gap: LiveGapWindowRecord): Promise<number>;
  updateLiveGapStatus(id: number, status: LiveGapStatus, notes?: string | null): Promise<void>;
  listLiveGaps(statuses?: LiveGapStatus[]): Promise<LiveGapWindowRecord[]>;
  recordLiveEventReceipt(receipt: LiveEventReceiptRecord): Promise<void>;
  hasLiveEventReceipt(eventKey: string): Promise<boolean>;
  applyLiveMessageUpdates(updates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult>;
  listPendingLiveMessageUpdates(limit?: number): Promise<LiveMessageUpdateRecord[]>;
  // Message secrets and retained secret-encrypted payloads. Secret bytes must
  // never appear in logs, DTOs, exports, or diagnostics.
  recordMessageSecrets(secrets: MessageSecretRecord[]): Promise<number>;
  getMessageSecret(chatSourceId: string, sourceMessageId: string): Promise<Uint8Array | null>;
  countMessageSecrets(): Promise<number>;
  retainEncryptedPayloads(payloads: RetainedPayloadRecord[]): Promise<number>;
  listRetainedEncryptedPayloads(limit?: number): Promise<RetainedPayloadRecord[]>;
  deleteRetainedEncryptedPayload(id: number): Promise<void>;
  // Minimal context a decryption pass needs about a target message.
  getMessageInterpretationContext(
    chatSourceId: string,
    sourceMessageId: string
  ): Promise<{ senderSourceJid: string | null; fromMe: boolean | null; rawMetadata: Record<string, unknown> | null } | null>;
  // Durable media download queue (mirrors retained payloads / gap windows):
  // descriptors persist here — never on the messages table — until stored.
  enqueueMediaDownloads(
    items: Array<Pick<MediaDownloadQueueRecord, "messageKey" | "chatSourceId" | "sourceMessageId" | "descriptor" | "thumbnail" | "isViewOnce" | "priority">>
  ): Promise<number>;
  claimDueMediaDownloads(limit: number, nowMs?: number): Promise<MediaDownloadQueueRecord[]>;
  // Success path: writes the media_assets row (deduped by content hash) and
  // marks the queue entry terminal, dropping its descriptor. Returns asset id.
  completeMediaDownload(queueId: number, asset: MediaAssetRecord): Promise<number>;
  markMediaDownloadRetry(queueId: number, error: string, nextAttemptAtMs: number, options?: { countReupload?: boolean }): Promise<void>;
  markMediaDownloadTerminal(queueId: number, status: "expired_unrecoverable" | "failed", error: string | null): Promise<void>;
  // Import backfill path: link an asset directly (no queue entry involved).
  linkMediaAsset(asset: MediaAssetRecord): Promise<number>;
  getMediaAsset(assetId: number): Promise<MediaAssetRecord | null>;
  getMediaAssetForMessage(messageId: number): Promise<MediaAssetRecord | null>;
  getMediaQueueSummary(): Promise<MediaQueueSummary>;
  // User-facing retry control for stuck items; returns re-queued count.
  retryStuckMediaDownloads(): Promise<number>;
  // Restart recovery: claimed-but-unfinished downloads return to pending.
  resetInFlightMediaDownloads(): Promise<number>;
  recordLinkPreviews(previews: CapturedLinkPreview[]): Promise<number>;
  getLinkPreviewThumbnail(messageId: number): Promise<Uint8Array | null>;
  // Captured inside a reply-owned WhatsApp quote envelope; this is local-only
  // and never causes a media download.
  getQuotedSnapshotThumbnail(messageId: number): Promise<Uint8Array | null>;
  // Edit history: snapshot rides applyLiveMessageUpdates; this reads it back.
  listMessageEditRevisions(messageId: number): Promise<MessageEditRevisionRecord[]>;
  // Focused owner-local payload; distinct from bounded thread pagination.
  getMessageDetail(messageId: number): Promise<MessageDetail | null>;
  getMessageVcardDownload(messageId: number, cardIndex: number): Promise<{ content: string; fileName: string; constructed: boolean } | null>;
  getLiveStatus(): Promise<LiveMaintainerStatusSummary>;
  listChats(options: ChatListOptions): Promise<ChatListItem[]>;
  listMessages(
    chatId: number,
    options: { limit: number; offset: number; sender?: string; query?: string; order?: "asc" | "desc" }
  ): Promise<MessageListItem[]>;
  // Thread window centered on one message, for search deep links; null when
  // the anchor does not exist in the chat.
  listMessagesAround(chatId: number, messageId: number, radius: number): Promise<MessageContextWindow | null>;
  // Indexed full-text search across all chats (brain hot tier). Refuses with a
  // PublicError while the index needs a rebuild — never a linear-scan fallback.
  // Zero-hit queries walk the relaxation ladder; responses carry the match
  // tier so degraded precision is always labelled.
  searchMessages(options: SearchQueryOptions): Promise<SearchResponse>;
  getSearchIndexStatus(): Promise<SearchIndexStatus>;
  // Persist term-alias variants (bidirectional groups, OR-ed into queries at
  // zero model cost). Seeded statically at boot; the deep retrieval path may
  // add learned rows so the asset compounds. Returns rows actually added.
  addTermAliases(entries: Array<{ term: string; variant: string; source?: string; weight?: number }>): Promise<number>;
  // Chunked recompute of derived resolved text + full FTS rebuild; yields to
  // the event loop between chunks and reports progress.
  rebuildSearchIndex(onProgress?: (processedMessages: number, totalMessages: number) => void): Promise<{ indexedMessages: number }>;
  getMemoryStatus(provider: MemoryProviderStatus): Promise<MemoryStatusSummary>;
  startMemoryRun(input: {
    kind: MemoryRunSummary["kind"];
    sourceStartAtMs?: number | null;
    sourceEndAtMs?: number | null;
    sourceSummary?: Record<string, unknown> | null;
  }): Promise<string>;
  completeMemoryRun(runId: string, totals: { pages: number; citations: number; messages: number; warnings: number }): Promise<void>;
  failMemoryRun(runId: string, status: "failed" | "blocked", message: string, warningCount?: number): Promise<void>;
  getMemoryRun(runId: string): Promise<MemoryRunSummary | null>;
  listMemoryRuns(limit: number): Promise<MemoryRunSummary[]>;
  tryAcquireMemoryLock(runId: string, ttlMs: number): Promise<boolean>;
  releaseMemoryLock(runId: string): Promise<void>;
  createMemorySourceWindow(input: Omit<MemorySourceWindowRecord, "id" | "createdAt">): Promise<MemorySourceWindowRecord>;
  getCommittedMemoryWindow(sourceHash: string): Promise<MemorySourceWindowRecord | null>;
  commitMemorySourceWindow(windowId: string): Promise<void>;
  listMemoryEvidenceMessages(options: {
    startAtMs?: number | null;
    endAtMs?: number | null;
    chatSourceIds?: string[];
    limit: number;
  }): Promise<MemoryEvidenceMessage[]>;
  getLatestCommittedMemoryEndAtMs(chatSourceId?: string | null): Promise<number | null>;
  recordMemoryEvidencePack(pack: MemoryEvidencePackRecord): Promise<void>;
  commitMemoryPageRevision(revision: MemoryPageRevisionRecord, citations: MemoryCitationRecord[]): Promise<void>;
  listMemoryPageRevisions(options?: { query?: string; limit?: number }): Promise<MemoryPageRevisionRecord[]>;
  listMemoryCitations(revisionId?: string): Promise<MemoryCitationRecord[]>;
  recordMemoryValidationIssues(issues: MemoryValidationIssue[]): Promise<void>;
  listMemoryValidationIssues(runId?: string): Promise<MemoryValidationIssue[]>;
  markStaleMemoryForMissingMessages(): Promise<number>;
  resolveMemoryCitation(citationLabelOrMessageKey: string): Promise<MemoryCitationRecord | null>;
  listNearbyMemoryMessages(messageId: number, radius: number): Promise<MemoryEvidenceMessage[]>;
  resolveQuotedReferents(
    chatSourceId: string,
    quotedSourceMessageIds: string[]
  ): Promise<Map<string, { senderLabel: string; snippet: string }>>;
  // --- Brain substrate: watermarks (coverage truth), durable task queue,
  // run ledger, and model-usage ledger. Watermarks advance only on commit;
  // backlog is derived live from messages newer than the watermark.
  getBrainChatBacklog(options: { limit: number; minPending?: number }): Promise<BrainChatBacklogItem[]>;
  advanceBrainWatermark(chatSourceId: string, throughMs: number): Promise<void>;
  enqueueBrainTasks(tasks: BrainTaskInput[]): Promise<number>;
  // Optional kind filter: a regenerate run drains only its own task kind while
  // the auto pass claims everything due.
  claimDueBrainTasks(limit: number, nowMs?: number, kind?: BrainTaskKind): Promise<BrainTaskRecord[]>;
  completeBrainTask(id: number): Promise<void>;
  failBrainTask(id: number, error: string, options?: { retryInMs?: number | null }): Promise<void>;
  // Restart recovery: claimed-but-unfinished tasks return to pending.
  resetInFlightBrainTasks(staleClaimMs?: number): Promise<number>;
  getBrainTaskSummary(): Promise<BrainTaskSummary>;
  // Archive owner identity: who "me" is in evidence, episodes, and search.
  getArchiveOwnerName(): Promise<string | null>;
  setArchiveOwnerName(displayName: string | null): Promise<void>;
  // Additional self numbers (run console): canonical identity JIDs the evidence
  // labeler treats as the owner with ABSOLUTE precedence over saved names.
  getArchiveOwnerSelfIdentities(): Promise<OwnerSelfIdentity[]>;
  // Replaces the stored list. Accepts digits or identity JIDs; normalizes,
  // canonicalizes through identity links, dedupes; rejects non-phone-shaped
  // input with a PublicError naming the offending value.
  setArchiveOwnerSelfJids(inputs: string[]): Promise<OwnerSelfIdentity[]>;
  // Plain substring autocomplete over archived identities (numbers and names,
  // no inference) — every row carries the number's CURRENT resolved label so
  // picking the wrong person is visible before saving.
  listOwnerIdentitySuggestions(query: string, limit?: number): Promise<OwnerIdentitySuggestion[]>;
  // Startup sweep: a run left 'running' by a dead process becomes an honest
  // 'interrupted' (watermarks make interruption free; the row must not lie).
  reconcileBrainRuns(): Promise<number>;
  startBrainRun(kind: BrainRunSummary["kind"], timezone?: string | null): Promise<string>;
  getBrainRun(runId: string): Promise<BrainRunSummary | null>;
  completeBrainRun(runId: string, totals: Record<string, number>): Promise<void>;
  failBrainRun(
    runId: string,
    status: "failed" | "interrupted" | "budget_exceeded",
    message: string,
    totals?: Record<string, number>
  ): Promise<void>;
  // Cross-process 'brain' job lock (mirrors the memory lock): the auto pass and
  // a CLI run must not spend the budget concurrently. TTL-expiring, re-entrant
  // for the same run id.
  tryAcquireBrainLock(runId: string, ttlMs: number): Promise<boolean>;
  releaseBrainLock(runId: string): Promise<void>;
  recordBrainLlmUsage(entry: {
    purpose: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    estimated?: boolean;
  }): Promise<void>;
  getBrainLlmUsage(options: { sinceMs?: number; day?: string }): Promise<BrainLlmUsageSummary>;
  getBrainStatus(): Promise<BrainStatusSummary>;
  // Episode commit is atomic: episode + claims + citations + watermark advance
  // in one transaction — coverage moves only when the evidence lands.
  // Reset derived brain data (episodes + claims + citations + watermarks),
  // optionally for one chat. Raw messages are untouched; the next run
  // re-assimilates from scratch. Returns removed episode ids for file cleanup.
  resetBrainDerivedData(options?: { chatSourceId?: string | null }): Promise<{ episodeIds: string[]; watermarks: number }>;
  commitBrainEpisode(episode: BrainEpisodeInput): Promise<BrainEpisodeRecord>;
  // Rendered markdown references committed claim ids, so it lands post-commit.
  updateBrainEpisodeMarkdown(episodeId: string, markdown: string): Promise<void>;
  listBrainEpisodes(options: {
    chatSourceId?: string | null;
    episodeId?: string;
    // Contract-v2 filters: continuity lookup (latest current model episode) and
    // regeneration selection use these instead of bespoke queries.
    status?: BrainEpisodeRecord["status"];
    generator?: BrainEpisodeGenerator;
    endAtOrBeforeMs?: number;
    limit: number;
  }): Promise<BrainEpisodeRecord[]>;
  // Regeneration selection: current episodes that are extractive-generated or
  // carry a stale extraction version, optionally scoped to one chat.
  listRegenerableBrainEpisodes(options: {
    currentVersion: number;
    chatSourceId?: string | null;
    limit: number;
  }): Promise<BrainEpisodeRecord[]>;
  // Cheap count for status surfaces (no record materialization).
  countRegenerableBrainEpisodes(currentVersion: number): Promise<number>;
  // --- Brain evaluation (eval harness) ---
  // Eval runs and manual claim grades are user-authored ground truth, not
  // derived data: they survive resetBrainDerivedData, regeneration, and the
  // contract-shape rebuild by construction (no FKs into brain tables).
  insertBrainEvalRun(run: BrainEvalRunRecord): Promise<void>;
  listBrainEvalRuns(options?: { goldenHash?: string; limit?: number }): Promise<BrainEvalRunRecord[]>;
  getBrainEvalRun(id: string): Promise<BrainEvalRunRecord | null>;
  // Invalid-expectation quarantine: which golden keys still resolve to rows.
  filterExistingMessageKeys(keys: string[]): Promise<Set<string>>;
  // Deterministic stratified grading sample: current model episodes only,
  // per model stamp, ungraded first, claim-UUID order.
  listClaimsForGrading(options: { perModel: number; includeGraded?: boolean }): Promise<BrainGradingSample>;
  // One grade per claim, regrade overwrites; stamps denormalized server-side.
  upsertBrainClaimGrade(claimId: string, grade: BrainClaimGradeValue): Promise<BrainClaimGradeRecord>;
  // Per-(model, extraction_version) quality rollup, every rate with its
  // denominator; fallbacks attribute via attempted_model ('unknown' legacy).
  getBrainModelQualityAggregates(): Promise<BrainModelQualityAggregate[]>;
  // D13 media-gap demand signal: the modality/impact aggregate (the demand
  // stat) and the materiality-aware selector a future media-interpretation
  // change regenerates first.
  getBrainMediaGapSummary(): Promise<BrainMediaGapSummary[]>;
  listBrainEpisodesWithMediaGaps(options: { impact: BrainMediaGapImpact; limit: number }): Promise<BrainEpisodeRecord[]>;
  // Supersede an episode replaced by regeneration (the status's one writer).
  markBrainEpisodeSuperseded(episodeId: string): Promise<void>;
  // Contract-v2 quality signals: flag rows never block a commit.
  recordBrainValidationIssues(issues: BrainValidationIssueInput[]): Promise<void>;
  listBrainValidationIssues(options?: { episodeId?: string | null; limit?: number }): Promise<BrainValidationIssueRecord[]>;
  getBrainValidationIssueSummary(): Promise<BrainValidationIssueSummary>;
  // Topic vocabulary offer: existing topic titles, this chat's most-used first,
  // then global by usage, deduped and capped.
  listBrainTopicVocabulary(chatSourceId: string, limit: number): Promise<string[]>;
  // Staleness propagation: edits/deletes/interpretation upgrades on a cited
  // message mark the dependent 'current' episodes 'stale' and enqueue a
  // dedupe-keyed regeneration task per episode (one transaction). Returns the
  // number of episodes newly marked stale.
  markStaleEpisodesForMessages(sourceMessageKeys: string[]): Promise<number>;
  // --- Knowledge graph (knowledge-graph-foundation) ---
  // Derived-of-derived: nodes/edges rebuild from committed episodes + captured
  // signals with zero model calls. Commit-time upserts live inside
  // commitBrainEpisode's transaction; these are the maintenance jobs and reads.
  // Idempotent chunked signal sync: membership periods → participates_in,
  // resolved vCards → mentions, number-changes → alias evidence, engagement
  // aggregates → bounded person salience factor.
  syncBrainGraphSignals(): Promise<BrainGraphSyncResult>;
  // Wipe graph tables and replay every current model episode + signal sync +
  // salience recompute. Deterministic: converges to the incremental state.
  rebuildBrainGraph(): Promise<BrainGraphRebuildResult>;
  // Evidence-derived salience with kind-aware dormancy (open commitment/
  // question nodes never go dormant; due-soon nodes boost). Pure SQL/TS math.
  recomputeBrainGraphSalience(): Promise<BrainGraphRecomputeResult>;
  getBrainGraphStats(): Promise<BrainGraphStats>;
  // Entity view resolved by node id (redirect-following), canonical JID, or
  // name — person-aggregated at read time through person_members.
  getBrainGraphEntity(query: { nodeId?: string; jid?: string; name?: string }): Promise<BrainGraphEntityView | null>;
  // Chat-scoped unresolved person entities ranked by salience — deterministic
  // backpressure for the person layer's suggestion producers, never a join key.
  listUnresolvedBrainGraphEntities(options?: { limit?: number }): Promise<BrainGraphUnresolvedEntity[]>;
  // --- Two-level person model: identities (canonical JIDs) stay immutable
  // anchors; persons are an editable membership. Connect/disconnect touch only
  // person-layer tables — never episodes, claims, citations, or archive rows.
  // A `user` connect clears a standing suppression; auto sources are blocked
  // by it. Both directions are audited in person_link_events.
  connectIdentities(
    jidA: string,
    jidB: string,
    source: PersonMemberSource,
    evidence?: Record<string, unknown> | null
  ): Promise<PersonConnectResult>;
  // Removes the membership, writes 'disconnected' suppressions against every
  // former co-member (so no auto source silently reconnects), and dissolves
  // the person to a redirect when fewer than two members remain.
  disconnectIdentities(identityJid: string): Promise<PersonDisconnectResult>;
  resolvePersonForJid(jid: string): Promise<PersonRecord | null>;
  listPersons(options?: { limit?: number }): Promise<PersonRecord[]>;
  // Resolves redirects: a dissolved or union-merged person id answers with its
  // replacement person or surviving identity rather than an error.
  getPerson(personId: string): Promise<PersonLookupResult>;
  // Batch person-key map for DTO assembly: jid → person id when the identity
  // is a member, else the jid itself (a lone identity is its own person).
  personKeyForJids(jids: string[]): Promise<Map<string, string>>;
  // Ranked detector output. Never applies membership; skips pairs that are
  // already co-members or suppressed; a rejected row is never resurrected.
  upsertPersonSuggestions(suggestions: PersonSuggestionInput[]): Promise<{ created: number; updated: number }>;
  listPersonSuggestions(options?: {
    status?: PersonSuggestionStatus;
    jid?: string;
    minScore?: number;
    limit?: number;
  }): Promise<PersonSuggestionRecord[]>;
  acceptPersonSuggestion(suggestionId: string): Promise<PersonConnectResult>;
  rejectPersonSuggestion(suggestionId: string): Promise<boolean>;
  // Human-only dismissal undo: every rejected row for the normalized pair
  // returns to pending, audited as 'unreject'. Detectors never do this.
  unrejectPersonSuggestions(jidLow: string, jidHigh: string): Promise<number>;
  // Retire a detector kind's pending queue (e.g. a detector removed after
  // real-data feedback); rejected/accepted history is preserved.
  supersedePersonSuggestionsByKind(kind: PersonSuggestionKind): Promise<number>;
  // Prune specific pending rows (e.g. pairs with no unifiable history).
  // Superseded rows resurrect to pending when a detector produces them afresh;
  // rejected/accepted never do.
  supersedePersonSuggestionsByIds(ids: string[]): Promise<number>;
  // A sender's recent visible messages across every chat (groups included) —
  // the compare dialog's activity view for identities without a direct chat.
  listRecentMessagesBySender(jid: string, limit?: number): Promise<IdentityRecentMessage[]>;
  // A sender's recent already-stored media (ids + labels, never bytes) for
  // the compare dialog's media strips.
  listRecentMediaBySender(jid: string, limit?: number): Promise<IdentityRecentMedia[]>;
  // Display labels for chat source ids (null when unresolved) — read-path
  // helper for surfaces that carry chat references.
  getChatLabels(sourceChatIds: string[]): Promise<Map<string, string | null>>;
  listPersonLinkSuppressions(limit?: number): Promise<PersonLinkSuppressionRecord[]>;
  // Delete one suppression so auto-connect/detectors may re-evaluate the
  // pair. Audited as 'release'; never connects by itself.
  releasePersonLinkSuppression(jidA: string, jidB: string): Promise<boolean>;
  listPersonLinkEvents(options?: { limit?: number }): Promise<PersonLinkEventRecord[]>;
  // Same-contact grouping persisted by the Google sync: full replace so the
  // stored groupings always mirror the provider's current state. Replacing
  // never disconnects members it previously connected.
  replaceGoogleContactGroups(groups: GoogleContactGroupEntry[]): Promise<{ groups: number; numbers: number }>;
  listGoogleContactGroups(): Promise<GoogleContactGroupEntry[]>;
  // Phone → archived canonical JIDs, matched the same way Google enrichment
  // matches (phone_number column or phone-form JID).
  resolveArchivedJidsForPhones(phones: string[]): Promise<Map<string, string[]>>;
  // Bounded deterministic read surfaces for the person detectors.
  listIdentityProfiles(options?: { limit?: number }): Promise<IdentityProfile[]>;
  listIdentityActivitySummaries(options?: { minMessages?: number; limit?: number }): Promise<IdentityActivitySummary[]>;
  listIdentityChatActivity(jids: string[]): Promise<IdentityChatActivity[]>;
  listGroupParticipantSets(options?: { maxGroupSize?: number; limit?: number }): Promise<Array<{ groupSourceId: string; participantJids: string[] }>>;
  listCoCitedIdentityPairs(options?: { minEpisodes?: number; limit?: number }): Promise<Array<{ jidA: string; jidB: string; episodes: number }>>;
  listResolvedVcardNames(options?: { limit?: number }): Promise<Array<{ resolvedJid: string; displayName: string | null }>>;
  close?(): Promise<void>;
}

export interface ArchiveRestorePoint {
  restore(): Promise<void>;
  dispose(): Promise<void>;
}
