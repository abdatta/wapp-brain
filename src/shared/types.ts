export type ChatType = "dm" | "group" | "community" | "broadcast" | "status" | "unknown";

// Honest per-message media availability, computed server-side from asset +
// download-queue state and read by every consumer (thread view, memory
// evidence, search, MCP). Never claims media is kept when it is not, nor that
// it is unkept when it is stored.
export type MediaAvailabilityState =
  | "stored"
  | "downloading"
  | "pending"
  | "expired_unrecoverable"
  | "not_captured"
  | "import_missing";

export type MediaAssetSource = "live-download" | "media-retry" | "import-folder";

export type MediaDownloadStatus = "pending" | "downloading" | "stored" | "retry" | "expired_unrecoverable" | "failed";

// The minimal downloadable descriptor captured at the platform event boundary
// — exactly what a passive CDN fetch + local decrypt needs. Binary fields are
// base64 strings so the record persists as JSON inside the queue row (never on
// the messages table) and is removed once the asset is stored.
export interface MediaDownloadDescriptor {
  mediaType: "image" | "video" | "audio" | "document" | "sticker" | "ptv";
  mediaKey: string;
  directPath: string | null;
  url: string | null;
  fileEncSha256: string | null;
  fileSha256: string | null;
  mediaKeyTimestamp: number | null;
  mimeType: string | null;
  fileName: string | null;
  fileLength: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  // The exact platform key of the original delivery (raw identity forms), kept
  // only because a media re-upload request must reference the message exactly
  // as the sender addressed it.
  retryKey?: { remoteJid: string; id: string; fromMe: boolean | null; participant: string | null } | null;
}

// A media capture riding on a live event from the handler boundary to the
// durable queue: descriptor + linkage + the embedded thumbnail bytes.
export interface CapturedMediaDescriptor {
  chatSourceId: string;
  sourceMessageId: string;
  descriptor: MediaDownloadDescriptor;
  isViewOnce: boolean;
  messageTimestampMs: number | null;
  thumbnail: Uint8Array | null;
}

// Sender-embedded link-preview data captured with a live text message. The
// thumbnail is embedded bytes from the message itself — never fetched from the
// link target.
export interface CapturedLinkPreview {
  chatSourceId: string;
  sourceMessageId: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  thumbnail: Uint8Array | null;
}

export interface MediaDownloadQueueRecord {
  id?: number;
  messageKey: string;
  chatSourceId: string;
  sourceMessageId: string;
  descriptor: MediaDownloadDescriptor;
  thumbnail?: Uint8Array | null;
  isViewOnce: boolean;
  status: MediaDownloadStatus;
  attempts: number;
  reuploadAttempts: number;
  nextAttemptAtMs: number | null;
  lastError: string | null;
  priority: number;
}

export interface MediaAssetRecord {
  id?: number;
  messageKey: string;
  chatSourceId: string;
  sha256: string;
  storagePath: string;
  mimeType: string | null;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbnail?: Uint8Array | null;
  source: MediaAssetSource;
  isViewOnce: boolean;
  createdAt?: string;
}

// Asset reference + availability exposed on the message DTO so clients can
// render media or explain its absence without reimplementing availability.
export interface MessageMediaSummary {
  availability: MediaAvailabilityState;
  assetId: number | null;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
  isViewOnce: boolean;
}

export interface LinkPreviewSummary {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  hasThumbnail: boolean;
}

// A retained prior version of an edited message (live edits only; backup
// imports never fabricate history).
export interface MessageEditRevisionRecord {
  id?: number;
  messageKey: string;
  revisionIndex: number;
  body: string | null;
  caption: string | null;
  editedAtMs: number | null;
  createdAt?: string;
}

// Privacy-safe media diagnostics: counts by state only — no content, no paths.
export interface MediaQueueSummary {
  assets: number;
  pending: number;
  downloading: number;
  retry: number;
  stored: number;
  failed: number;
  expiredUnrecoverable: number;
}

export type ImportRunStatus = "running" | "completed" | "failed";
export type ImportMode = "merge" | "replace";
export type ImportStagingFileKind = "msgstore" | "wa" | "media" | "key";
export type ImportJobStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type LiveConnectionState = "not_configured" | "pairing" | "connected" | "disconnected" | "stopped" | "error" | "logged_out";
export type LiveHealthState = "healthy" | "catching_up" | "uncertain" | "disconnected" | "needs_user_action";
export type LiveGapStatus = "open" | "retrying" | "closed" | "uncertain" | "needs_user_action";
export type LiveGapReason = "late_start" | "disconnect" | "watermark_mismatch" | "history_sync_stalled" | "manual_retry";
export type MemoryRunStatus = "running" | "completed" | "failed" | "blocked";
export type MemorySourceWindowStatus = "open" | "committed" | "skipped" | "stale";
export type MemoryEvidencePackStatus = "prepared" | "generated" | "validated" | "failed";
export type MemoryProviderName = "local" | "codex";
export type MemoryEvidenceLayer = "long_term" | "short_term";
export type GuidedSetupState =
  | "empty_archive"
  | "baseline_too_old"
  | "baseline_ready_unlinked"
  | "linking"
  | "syncing"
  | "paused"
  | "disconnected"
  | "logged_out"
  | "needs_attention";

export type GuidedSetupPrimaryAction = "import_backup" | "link_whatsapp" | "monitor_sync" | "resume_sync" | "reconnect" | "repair_link" | "review_gaps";

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
  memory?: MemoryStatusSummary;
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
  platformRecencyMs?: number | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface ChatSyncStateRecord {
  chatSourceId: string;
  latestArchivedAtMs: number | null;
  latestArchivedMessageId: string | null;
  earliestArchivedAtMs: number | null;
  earliestArchivedMessageId: string | null;
  platformRecencyMs: number | null;
}

export interface RecoveryAnchorRecord {
  sourceMessageId: string;
  timestampMs: number;
  fromMe: boolean | null;
  senderSourceJid: string | null;
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
  // Name or phone number; NULL means unresolved and the UI renders an explicit
  // state instead of a raw identifier.
  displayName: string | null;
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

// Server-side interpretation of a message whose body cannot speak for itself:
// a label naming the kind, plus a reason when genuinely unreadable. NULL for
// plain text. One source of truth for UI, memory evidence, and future
// search/MCP/agent consumers.
export interface MessageInterpretationSummary {
  label: string;
  reason: string | null;
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
  interpretation: MessageInterpretationSummary | null;
  body: string | null;
  caption: string | null;
  // Resolved mention labels substituted into body/caption ("@<label>" spans),
  // so the UI can highlight them; unresolved tokens stay raw @digits.
  mentions: string[];
  hasMedia: boolean;
  mediaMimeType: string | null;
  mediaName: string | null;
  // Media asset reference + honest availability; null for non-media messages.
  media: MessageMediaSummary | null;
  // Stored sender-embedded link preview; null when the message carries none.
  linkPreview: LinkPreviewSummary | null;
  isEdited: boolean;
  // Retained prior revisions available for this message (live edits only).
  editRevisionCount: number;
  isDeleted: boolean;
  isForwarded: boolean;
  isStarred: boolean;
}

export interface MemoryConfigSummary {
  rootDir: string;
  pagesDir: string;
  citationsDir: string;
  runsDir: string;
  codexSessionPath: string;
  provider: MemoryProviderName;
  remoteModelEnabled: boolean;
  defaultCutoffHour: number;
  maxEvidenceMessages: number;
  maxQueryMessages: number;
}

export interface MemoryProviderStatus {
  provider: MemoryProviderName;
  remoteModelEnabled: boolean;
  codexPackageAvailable: boolean;
  codexSessionExists: boolean;
  message: string;
}

export interface MemoryRunSummary {
  id: string;
  status: MemoryRunStatus;
  kind: "rem" | "manual" | "rebuild" | "validate";
  startedAt: string;
  finishedAt: string | null;
  sourceStartAtMs: number | null;
  sourceEndAtMs: number | null;
  pageCount: number;
  citationCount: number;
  messageCount: number;
  warningCount: number;
  errorMessage?: string | null;
}

export interface MemoryStatusSummary {
  enabled: boolean;
  rootDir: string;
  pageCount: number;
  citationCount: number;
  stalePageCount: number;
  latestRun: MemoryRunSummary | null;
  activeRun: MemoryRunSummary | null;
  latestCommittedAtMs: number | null;
  provider: MemoryProviderStatus;
}

export interface MemorySourceWindowRecord {
  id: string;
  runId: string;
  status: MemorySourceWindowStatus;
  startAtMs: number | null;
  endAtMs: number | null;
  chatSourceIds: string[];
  messageCount: number;
  sourceHash: string;
  committedAt: string | null;
  createdAt?: string;
}

export interface MemoryEvidenceMessage {
  citationLabel: string;
  messageId: number;
  sourceMessageKey: string;
  sourceMessageId: string;
  sourceChatId: string;
  chatId: number;
  chatDisplayName: string | null;
  senderSourceJid: string | null;
  senderDisplayName: string | null;
  timestampMs: number | null;
  sentAt: string | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  interpretation: MessageInterpretationSummary | null;
  text: string | null;
}

export interface MemoryEvidencePackRecord {
  id: string;
  runId: string;
  windowId: string;
  status: MemoryEvidencePackStatus;
  sequence: number;
  messageCount: number;
  citationLabels: string[];
  createdAt: string;
}

export interface MemoryCitationRecord {
  id?: number;
  revisionId: string;
  claimId: string;
  citationLabel: string;
  messageId: number | null;
  sourceMessageKey: string;
  sourceMessageId: string;
  sourceChatId: string;
  senderSourceJid: string | null;
  timestampMs: number | null;
}

export interface MemoryPageRevisionRecord {
  id: string;
  pageId: string;
  runId: string;
  windowId: string;
  title: string;
  path: string;
  summary: string;
  markdown: string;
  status: "current" | "superseded" | "stale";
  sourceStartAtMs: number | null;
  sourceEndAtMs: number | null;
  citationCount: number;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryValidationIssue {
  id?: number;
  runId: string;
  packId?: string | null;
  pageId?: string | null;
  severity: "warning" | "error";
  code: string;
  message: string;
  context?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface MemoryConsolidationRequest {
  kind?: "rem" | "manual" | "rebuild";
  startAtMs?: number | null;
  endAtMs?: number | null;
  chatSourceIds?: string[];
  dryRun?: boolean;
  force?: boolean;
  provider?: MemoryProviderName;
}

export interface MemoryConsolidationResult {
  ok: boolean;
  run: MemoryRunSummary;
  window: MemorySourceWindowRecord | null;
  pages: MemoryPageRevisionRecord[];
  issues: MemoryValidationIssue[];
  dryRun: boolean;
  previewPath?: string | null;
}

export interface MemoryQueryEvidence {
  layer: MemoryEvidenceLayer;
  title: string;
  snippet: string;
  pageId?: string | null;
  revisionId?: string | null;
  citation?: MemoryCitationRecord | null;
  message?: MemoryEvidenceMessage | null;
}

export interface MemoryQueryResult {
  query: string;
  answer: string;
  remoteSynthesisUsed: boolean;
  evidence: MemoryQueryEvidence[];
  citations: MemoryCitationRecord[];
}

export interface MemoryCitationResolution {
  ok: boolean;
  stale: boolean;
  citation: MemoryCitationRecord | null;
  message: MemoryEvidenceMessage | null;
  nearbyMessages: MemoryEvidenceMessage[];
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
  | "addons"
  | "media"
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
      // Media-ingestion phase progress: counts only, never file names/paths.
      type: "media-progress";
      processedRefs: number;
      matchedRefs: number;
      copiedAssets: number;
      missingRefs: number;
      warningCount: number;
      totalRefs: number | null;
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
  state: "idle" | "starting" | "pairing" | "connected" | "disconnected" | "stopped" | "error" | "logged_out";
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
  gapGroups: LiveGapGroupSummary[];
  identityHealth: IdentityHealthSummary;
  chatHealth: LiveChatHealthSummary[];
  media: MediaQueueSummary;
}

export interface IdentityHealthSummary {
  unnamedGroups: number;
  unresolvedLids: number;
  samples: string[];
}

// In-memory sync progress; served without touching the database so the UI can
// poll it even while heavy ingestion is running.
export interface LiveSyncProgress {
  active: boolean;
  connected: boolean;
  processedMessages: number;
  processedEvents: number;
  queuedMessages: number;
  // Platform-reported progress of WhatsApp's proactive history push (phase 1).
  historySyncPercent: number | null;
  // Per-chat backfill of downtime windows (phase 2): audit → gaps → recovery.
  auditPending: boolean;
  gapsOpened: number;
  gapsClosed: number;
  lastEventAt: string | null;
}

export interface LiveGapGroupSummary {
  status: LiveGapStatus;
  reason: LiveGapReason;
  count: number;
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

// Per-message secrets (WhatsApp "message secrets" layer) unlock
// secret-encrypted updates targeting the message: poll votes, event responses,
// and edits. Stored deliberately (user decision, 2026-07-07): the archive
// already holds the corresponding plaintext locally. Secret bytes MUST never
// reach logs, DTOs, exports, or diagnostics.
export interface MessageSecretRecord {
  chatSourceId: string;
  sourceMessageId: string;
  secret: Uint8Array;
  source: "live" | "backup";
}

// A secret-encrypted payload the archive cannot decrypt yet, retained keyed to
// its target so a later-learned secret makes it readable retroactively.
export interface RetainedPayloadRecord {
  id?: number;
  eventKey: string;
  chatSourceId: string;
  targetMessageId: string;
  kind: "poll_vote" | "event_response" | "secret_encrypted";
  actorJid: string | null;
  encPayload: Uint8Array;
  encIv: Uint8Array | null;
  occurredAtMs: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface LiveMessageUpdateRecord {
  eventKey: string;
  chatSourceId: string;
  sourceMessageKey: string;
  updateType: "delete" | "edit" | "reaction" | "poll_vote" | "event_response" | "receipt" | "call" | "unknown";
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
