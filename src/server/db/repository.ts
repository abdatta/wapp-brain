import type {
  ChatListItem,
  ChatRecord,
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
  MessageListItem,
  MessageRecord,
  ParticipantRecord,
  ChatListOptions,
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
  refreshChatStats(): Promise<void>;
  clearArchiveData(): Promise<void>;
  getStatus(): Promise<StatusSummary>;
  upsertLiveSession(session: Partial<LiveSessionSummary> & { id: string; status: LiveSessionSummary["status"]; clientName: string }): Promise<void>;
  startLiveSyncRun(sourceSummary: Record<string, unknown>): Promise<string>;
  completeLiveSyncRun(runId: string, totals: LiveSyncTotals, warningCount: number): Promise<void>;
  failLiveSyncRun(runId: string, code: string, message: string, totals?: LiveSyncTotals, warningCount?: number): Promise<void>;
  upsertLiveCheckpoint(checkpoint: LiveChatCheckpointRecord): Promise<void>;
  listLiveCheckpoints(): Promise<LiveChatCheckpointRecord[]>;
  upsertLiveGap(gap: LiveGapWindowRecord): Promise<number>;
  updateLiveGapStatus(id: number, status: LiveGapStatus, notes?: string | null): Promise<void>;
  listLiveGaps(statuses?: LiveGapStatus[]): Promise<LiveGapWindowRecord[]>;
  recordLiveEventReceipt(receipt: LiveEventReceiptRecord): Promise<void>;
  hasLiveEventReceipt(eventKey: string): Promise<boolean>;
  applyLiveMessageUpdates(updates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult>;
  getLiveStatus(): Promise<LiveMaintainerStatusSummary>;
  listChats(options: ChatListOptions): Promise<ChatListItem[]>;
  listMessages(
    chatId: number,
    options: { limit: number; offset: number; sender?: string; query?: string; order?: "asc" | "desc" }
  ): Promise<MessageListItem[]>;
  close?(): Promise<void>;
}

export interface ArchiveRestorePoint {
  restore(): Promise<void>;
  dispose(): Promise<void>;
}
