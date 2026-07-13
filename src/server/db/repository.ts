import type {
  BrainChatBacklogItem,
  BrainEpisodeInput,
  BrainEpisodeRecord,
  BrainLlmUsageSummary,
  BrainRunSummary,
  BrainStatusSummary,
  BrainTaskInput,
  BrainTaskRecord,
  BrainTaskSummary,
  CapturedLinkPreview,
  ChatListItem,
  ChatRecord,
  ChatSyncStateRecord,
  ContactRecord,
  GoogleContactCandidate,
  GoogleContactsSyncResult,
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
  ParticipantRecord,
  RetainedPayloadRecord,
  ChatListOptions,
  RecoveryAnchorRecord,
  SearchIndexStatus,
  SearchQueryOptions,
  SearchResponse,
  StatusSummary
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
  recordIdentityLinks(links: Array<{ lid: string; pn: string; source?: string | null }>): Promise<string[]>;
  resolveIdentityJid(jid: string): Promise<string>;
  // Reverse of resolveIdentityJid: the LID form(s) known for a phone JID (or the
  // JID itself if it is already a LID). Secret-encrypted edit decryption binds
  // the exact LID the sender used, so it needs the LID, not the canonical phone.
  getIdentityLidsForJid(jid: string): Promise<string[]>;
  listUnmergedLidIdentities(limit?: number): Promise<Array<{ lid: string; pn: string }>>;
  mergeIdentity(lid: string, pn: string): Promise<{ chatsMerged: number; contactsMerged: number; messagesCollapsed: number }>;
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
  // Edit history: snapshot rides applyLiveMessageUpdates; this reads it back.
  listMessageEditRevisions(messageId: number): Promise<MessageEditRevisionRecord[]>;
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
  searchMessages(options: SearchQueryOptions): Promise<SearchResponse>;
  getSearchIndexStatus(): Promise<SearchIndexStatus>;
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
  claimDueBrainTasks(limit: number, nowMs?: number): Promise<BrainTaskRecord[]>;
  completeBrainTask(id: number): Promise<void>;
  failBrainTask(id: number, error: string, options?: { retryInMs?: number | null }): Promise<void>;
  // Restart recovery: claimed-but-unfinished tasks return to pending.
  resetInFlightBrainTasks(staleClaimMs?: number): Promise<number>;
  getBrainTaskSummary(): Promise<BrainTaskSummary>;
  // Archive owner identity: who "me" is in evidence, episodes, and search.
  getArchiveOwnerName(): Promise<string | null>;
  setArchiveOwnerName(displayName: string | null): Promise<void>;
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
  listBrainEpisodes(options: { chatSourceId?: string | null; episodeId?: string; limit: number }): Promise<BrainEpisodeRecord[]>;
  // Staleness propagation: edits/deletes/interpretation upgrades on a cited
  // message mark the dependent 'current' episodes 'stale' and enqueue a
  // dedupe-keyed regeneration task per episode (one transaction). Returns the
  // number of episodes newly marked stale.
  markStaleEpisodesForMessages(sourceMessageKeys: string[]): Promise<number>;
  close?(): Promise<void>;
}

export interface ArchiveRestorePoint {
  restore(): Promise<void>;
  dispose(): Promise<void>;
}
