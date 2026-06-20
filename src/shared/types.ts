export type ChatType = "dm" | "group" | "community" | "broadcast" | "status" | "unknown";

export type ImportRunStatus = "running" | "completed" | "failed";
export type ImportMode = "merge" | "replace";
export type ImportStagingFileKind = "msgstore" | "wa" | "media" | "key";
export type ImportJobStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type LiveConnectionState = "not_configured" | "pairing" | "connected" | "disconnected" | "stopped" | "error";
export type LiveHealthState = "healthy" | "catching_up" | "uncertain" | "disconnected" | "needs_user_action";
export type LiveGapStatus = "open" | "retrying" | "closed" | "uncertain" | "needs_user_action";
export type LiveGapReason = "late_start" | "disconnect" | "watermark_mismatch" | "history_sync_stalled" | "manual_retry";
export type GuidedSetupState =
  | "empty_archive"
  | "baseline_too_old"
  | "baseline_ready_unlinked"
  | "linking"
  | "syncing"
  | "paused"
  | "disconnected"
  | "needs_attention";

export type GuidedSetupPrimaryAction = "import_backup" | "link_whatsapp" | "monitor_sync" | "resume_sync" | "reconnect" | "review_gaps";

export interface StatusSummary {
  database: {
    configured: boolean;
    initialized: boolean;
    adapter?: "sqlite" | "postgres" | "memory";
    location?: string;
    error?: string;
  };
  counts: {
    chats: number;
    contacts: number;
    participants: number;
    messages: number;
    warnings: number;
  };
  latestImport: ImportRunSummary | null;
  latestWarnings: ImportWarning[];
  live?: LiveMaintainerStatusSummary;
  setup?: GuidedSetupSummary;
}

export interface GuidedSetupSummary {
  state: GuidedSetupState;
  label: string;
  description: string;
  primaryAction: GuidedSetupPrimaryAction;
  phase: "backup" | "archive" | "live";
  canImport: boolean;
  canLink: boolean;
  canPause: boolean;
  canResume: boolean;
  canUnlink: boolean;
  blockingReason: string | null;
}

export interface ImportRunSummary {
  id: string;
  status: ImportRunStatus;
  startedAt: string;
  finishedAt: string | null;
  totals: ImportTotals;
  warningCount: number;
  errorMessage?: string | null;
}

export interface ImportTotals {
  contacts: number;
  chats: number;
  participants: number;
  messages: number;
  skipped: number;
  warnings: number;
}

export interface ImportWarning {
  id?: number;
  severity: "info" | "warning" | "error";
  code: string;
  entityType?: string | null;
  sourceTable?: string | null;
  sourceRowId?: string | null;
  message: string;
  context?: Record<string, unknown> | null;
}

export interface ContactRecord {
  sourceJid: string;
  displayName?: string | null;
  phoneNumber?: string | null;
  pushName?: string | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ChatRecord {
  sourceChatId: string;
  jid: string;
  displayName?: string | null;
  chatType: ChatType;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ParticipantRecord {
  chatSourceId: string;
  sourceJid: string;
  displayName?: string | null;
  firstSeenAtMs?: number | null;
  lastSeenAtMs?: number | null;
  membershipSource: "source" | "inferred";
  rawMetadata?: Record<string, unknown> | null;
}

export interface MessageRecord {
  sourceMessageId: string;
  sourceMessageKey: string;
  sourceTable: string;
  sourceRowId: string;
  chatSourceId: string;
  senderSourceJid?: string | null;
  timestampMs?: number | null;
  sentAtIso?: string | null;
  fromMe: boolean | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  rawTypeCode?: string | number | null;
  body?: string | null;
  caption?: string | null;
  hasMedia: boolean;
  mediaMimeType?: string | null;
  mediaName?: string | null;
  quotedSourceMessageId?: string | null;
  isDeleted: boolean;
  isForwarded: boolean;
  isStarred: boolean;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ChatListItem {
  id: number;
  sourceChatId: string;
  jid: string;
  displayName: string;
  chatType: ChatType;
  messageCount: number;
  participantCount: number;
  lastMessageAt: string | null;
}

export interface ChatListOptions {
  search?: string;
  limit: number;
  offset: number;
  type?: string;
  includeEventOnly?: boolean;
}

export interface MessageListItem {
  id: number;
  sourceMessageId: string;
  senderDisplayName: string | null;
  senderSourceJid: string | null;
  timestampMs: number | null;
  sentAt: string | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  body: string | null;
  caption: string | null;
  hasMedia: boolean;
  mediaMimeType: string | null;
  mediaName: string | null;
  isDeleted: boolean;
  isForwarded: boolean;
  isStarred: boolean;
}

export type MessageListOrder = "asc" | "desc";

export interface ImportRequest {
  msgstorePath: string;
  waPath?: string | null;
  mediaPath?: string | null;
  key?: string | null;
  keyPath?: string | null;
  keepDecrypted?: boolean;
  mode?: ImportMode;
}

export interface ImportStagingFileSummary {
  kind: ImportStagingFileKind;
  name: string;
  size: number;
  stagedAt: string;
}

export interface ImportStagingSessionSummary {
  id: string;
  createdAt: string;
  files: Partial<Record<ImportStagingFileKind, ImportStagingFileSummary>>;
}

export interface ImportVerificationSummary {
  ok: boolean;
  encrypted: boolean;
  message: string;
}

export type ImportProgressStep =
  | "validating"
  | "initializing"
  | "preparing"
  | "decrypting"
  | "opening"
  | "parsing"
  | "contacts"
  | "chats"
  | "messages"
  | "participants"
  | "finalizing"
  | "completed";

export type ImportProgressEvent =
  | {
      type: "step";
      step: ImportProgressStep;
      message: string;
    }
  | {
      type: "file-progress";
      phase: "verify" | "decrypt" | "materialize";
      message: string;
      processedBytes: number;
      totalBytes: number;
    }
  | {
      type: "message-progress";
      processedMessages: number;
      persistedMessages: number;
      totalMessages: number | null;
    }
  | {
      type: "warnings";
      count: number;
      codes: string[];
    }
  | {
      type: "complete";
      totals: ImportTotals;
    };

export interface ImportJobSummary {
  id: string;
  status: ImportJobStatus;
  mode: ImportMode;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  events: ImportProgressEvent[];
  totals: ImportTotals | null;
  error: string | null;
}

export interface LivePairingSummary {
  state: "idle" | "starting" | "pairing" | "connected" | "disconnected" | "stopped" | "error";
  qrDataUrl: string | null;
  pairingCode: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
}

export interface LiveMaintainerStatusSummary {
  enabled: boolean;
  baseline: LiveBaselineSummary;
  session: LiveSessionSummary | null;
  currentRun: LiveSyncRunSummary | null;
  totals: LiveSyncTotals;
  openGapCount: number;
  chatHealth: LiveChatHealthSummary[];
}

export interface LiveBaselineSummary {
  ready: boolean;
  messageCount: number;
  latestImportAt: string | null;
  latestMessageAt: string | null;
  maxBackfillDays: number;
  status: "ready" | "missing_archive" | "missing_messages" | "too_old";
  warning: string | null;
}

export interface LiveSessionSummary {
  id: string;
  status: LiveConnectionState;
  clientName: string;
  linkedDeviceJid: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LiveSyncRunSummary {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  totals: LiveSyncTotals;
  warningCount: number;
  errorMessage?: string | null;
}

export interface LiveSyncTotals {
  contacts: number;
  chats: number;
  participants: number;
  messages: number;
  updates: number;
  gapsOpened: number;
  gapsClosed: number;
  warnings: number;
}

export interface LiveChatCheckpointRecord {
  chatSourceId: string;
  chatId?: number | null;
  latestArchivedMessageKey?: string | null;
  latestArchivedAtMs?: number | null;
  earliestArchivedMessageKey?: string | null;
  earliestArchivedAtMs?: number | null;
  latestLiveMessageKey?: string | null;
  latestLiveAtMs?: number | null;
  oldestVerifiedMessageKey?: string | null;
  oldestVerifiedAtMs?: number | null;
  health: LiveHealthState;
  retryCount: number;
  nextRecoveryAt?: string | null;
  lastAuditAt?: string | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface LiveGapWindowRecord {
  id?: number;
  chatSourceId: string;
  chatId?: number | null;
  reason: LiveGapReason;
  status: LiveGapStatus;
  startAtMs: number | null;
  endAtMs: number | null;
  requiredLowerBoundAtMs?: number | null;
  anchorMessageKey?: string | null;
  requestCount: number;
  lastAttemptAt?: string | null;
  confidence: "low" | "medium" | "high";
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LiveChatHealthSummary {
  chatSourceId: string;
  chatDisplayName: string | null;
  health: LiveHealthState;
  latestArchivedAt: string | null;
  latestLiveAt: string | null;
  oldestVerifiedAt: string | null;
  openGapCount: number;
  nextRecoveryAt: string | null;
}

export interface LiveEventReceiptRecord {
  eventKey: string;
  eventType: string;
  chatSourceId?: string | null;
  messageKey?: string | null;
  occurredAtMs?: number | null;
  processedAt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface LiveMessageUpdateRecord {
  eventKey: string;
  chatSourceId: string;
  sourceMessageKey: string;
  updateType: "delete" | "edit" | "reaction" | "receipt" | "call" | "unknown";
  occurredAtMs?: number | null;
  applied: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface LiveMessageUpdateResult {
  applied: number;
  pending: number;
}

export interface ArchiveChangeEvent {
  id: number;
  type: "archive-updated";
  source: "import" | "live" | "manual";
  chatSourceIds: string[];
  messageCount: number;
  contactCount: number;
  updatedAt: string;
}
