import type {
  ChatListItem,
  ChatRecord,
  ChatSyncStateRecord,
  ContactRecord,
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
  MemoryCitationRecord,
  MemoryEvidenceMessage,
  MemoryEvidencePackRecord,
  MemoryPageRevisionRecord,
  MemoryProviderStatus,
  MemoryRunSummary,
  MemorySourceWindowRecord,
  MemoryStatusSummary,
  MemoryValidationIssue,
  MessageListItem,
  MessageRecord,
  MessageSecretRecord,
  ParticipantRecord,
  RetainedPayloadRecord,
  ChatListOptions,
  RecoveryAnchorRecord,
  StatusSummary
} from "../../shared/types";

export interface ArchiveRepository {
  createRestorePoint(label: string): Promise<ArchiveRestorePoint>;
  startImportRun(sourceSummary: Record<string, unknown>): Promise<string>;
  completeImportRun(runId: string, totals: ImportTotals, warningCount: number): Promise<void>;
  failImportRun(runId: string, code: string, message: string, totals?: ImportTotals, warningCount?: number): Promise<void>;
  addWarnings(runId: string, warnings: ImportWarning[]): Promise<void>;
  upsertContacts(runId: string, contacts: ContactRecord[]): Promise<Map<string, number>>;
  upsertChats(runId: string, chats: ChatRecord[]): Promise<Map<string, number>>;
  upsertParticipants(participants: ParticipantRecord[]): Promise<number>;
  upsertMessages(messages: MessageRecord[]): Promise<number>;
  recordIdentityLinks(links: Array<{ lid: string; pn: string; source?: string | null }>): Promise<string[]>;
  resolveIdentityJid(jid: string): Promise<string>;
  listUnmergedLidIdentities(limit?: number): Promise<Array<{ lid: string; pn: string }>>;
  mergeIdentity(lid: string, pn: string): Promise<{ chatsMerged: number; contactsMerged: number; messagesCollapsed: number }>;
  // Collapse rows stored under a superseded identity (e.g. an edited message's
  // edit key from an earlier importer) onto their canonical row; removed rows
  // route through memory staleness.
  collapseSupersededMessages(
    pairs: Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>
  ): Promise<number>;
  listUnnamedGroupChats(limit?: number): Promise<string[]>;
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
  getLiveStatus(): Promise<LiveMaintainerStatusSummary>;
  listChats(options: ChatListOptions): Promise<ChatListItem[]>;
  listMessages(
    chatId: number,
    options: { limit: number; offset: number; sender?: string; query?: string; order?: "asc" | "desc" }
  ): Promise<MessageListItem[]>;
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
  close?(): Promise<void>;
}

export interface ArchiveRestorePoint {
  restore(): Promise<void>;
  dispose(): Promise<void>;
}
