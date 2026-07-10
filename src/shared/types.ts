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
  // True when the local server can open a native OS file/folder dialog (Windows
  // today); the import wizard shows "Browse…" only when this is true.
  pickerAvailable?: boolean;
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
  // Explicit mentioned JIDs from the transport envelope (live contextInfo);
  // text-token "@digits" mentions are additionally derived at write time.
  mentionedJids?: string[] | null;
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

// --- Archive full-text search (brain hot tier) ---

// Where the search index stands relative to the archive. "needs_rebuild"
// appears when the index was added (or invalidated) on an archive that already
// held messages; search refuses honestly until a reindex job runs.
export type SearchIndexState = "ready" | "needs_rebuild";

export interface SearchIndexStatus {
  state: SearchIndexState;
  totalMessages: number;
}

export type SearchTypeFilter = "text" | "media" | "call";

export interface SearchQueryOptions {
  query: string;
  chatId?: number | null;
  // Free-text sender match: canonical JID, saved name, or push name.
  sender?: string | null;
  afterMs?: number | null;
  beforeMs?: number | null;
  type?: SearchTypeFilter | null;
  direction?: "incoming" | "outgoing" | null;
  // Default false: only visible-exchange (conversation) rows are returned.
  includeNoise?: boolean;
  limit: number;
  offset: number;
}

// Snippet highlight markers: private-use codepoints that cannot occur in real
// message text; consumers replace them with their own emphasis markup.
export const SEARCH_HIGHLIGHT_START = "\uE000";
export const SEARCH_HIGHLIGHT_END = "\uE001";

// One search hit. Layer is fixed to "message" until brain documents (episodes,
// pages) join the same result shape in later phases.
export interface SearchResultItem {
  layer: "message";
  messageId: number;
  sourceMessageKey: string;
  sourceMessageId: string;
  chatId: number;
  chatSourceId: string;
  chatDisplayName: string | null;
  chatType: ChatType;
  senderDisplayName: string | null;
  senderSourceJid: string | null;
  timestampMs: number | null;
  sentAt: string | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  interpretation: MessageInterpretationSummary | null;
  // Match locality with highlight markers around matched terms; mention tokens
  // arrive resolved where the index carried resolved text.
  snippet: string;
  // Relevance after recency decay; higher is better, comparable only within
  // one result set.
  score: number;
  hasMedia: boolean;
  isDeleted: boolean;
}

export interface SearchResponse {
  index: SearchIndexStatus;
  // Exact number of messages matching the query and filters across the whole
  // archive; results carries only the requested page of the ranked top pool.
  totalMatches: number;
  results: SearchResultItem[];
}

// Window of a chat's thread centered on one message, for search deep links.
// newerCount is how many chat messages are newer than the window's newest row,
// so offset-based "load older/newer" paging continues from the jump position.
export interface MessageContextWindow {
  messages: MessageListItem[];
  newerCount: number;
  anchorMessageId: number;
}

// --- Brain substrate (tiered assimilation) ---

export type BrainTaskKind = "episode" | "rollup" | "overview" | "merge_adjudicate" | "reindex" | "project_pages";
export type BrainTaskStatus = "pending" | "running" | "done" | "failed";
export type BrainRunKind = "nightly" | "catchup" | "manual" | "backfill";
export type BrainRunStatus = "running" | "completed" | "failed" | "interrupted" | "budget_exceeded";

export interface BrainTaskInput {
  kind: BrainTaskKind;
  chatSourceId?: string | null;
  payload?: Record<string, unknown> | null;
  // Idempotency key: re-enqueueing known work is a no-op by construction.
  dedupeKey: string;
  priority?: number;
}

export interface BrainTaskRecord {
  id: number;
  kind: BrainTaskKind;
  chatSourceId: string | null;
  payload: Record<string, unknown> | null;
  dedupeKey: string;
  status: BrainTaskStatus;
  priority: number;
  attempts: number;
  nextAttemptAtMs: number | null;
  lastError: string | null;
}

export interface BrainTaskSummary {
  pending: number;
  running: number;
  failed: number;
  done: number;
}

// One chat's assimilation state: the watermark plus its live-derived backlog
// (visible-exchange messages newer than the watermark — never a stored
// counter that can drift).
export interface BrainChatBacklogItem {
  chatSourceId: string;
  chatDisplayName: string | null;
  assimilatedThroughMs: number;
  lastEpisodeAt: string | null;
  pendingVisibleMessages: number;
  newestVisibleMs: number | null;
}

export interface BrainRunSummary {
  id: string;
  kind: BrainRunKind;
  status: BrainRunStatus;
  startedAt: string;
  finishedAt: string | null;
  timezone: string | null;
  totals: Record<string, number> | null;
  errorMessage: string | null;
}

export interface BrainLlmUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export type BrainProviderName = "claude-cli" | "codex" | "extractive";

export interface BrainProviderHealth {
  consecutiveFailures: number;
  degradedSince: string | null;
  lastError: string | null;
  lastOkAt: string | null;
}

// GPT-5.6 reasoning-effort settings; the brain pins one explicitly so what
// stamps permanent episodes never shifts with a provider-side default change.
export type BrainReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface BrainProviderStatus {
  provider: BrainProviderName;
  modelBacked: boolean;
  enabled: boolean;
  // Codex only: enabled but no local OAuth session; calls refuse fast with
  // login instructions instead of hanging in an interactive flow.
  sessionMissing: boolean;
  degraded: boolean;
  // Persisted model selection for the active provider (null for extractive).
  model: string | null;
  // Reasoning effort requested on every call for providers with an effort
  // knob (codex); null when the provider has none (claude-cli, extractive).
  reasoningEffort: BrainReasoningEffort | null;
  // Selectable models per provider, for UI pickers.
  models: Record<string, string[]>;
  health: BrainProviderHealth;
  message: string;
}

// Manual-first scheduling: paused mode computes dueness and alerts; only auto
// mode executes runs unattended.
export interface BrainSchedulerStatus {
  mode: "paused" | "auto";
  runDue: boolean;
  dueReason: string | null;
}

// One-call brain overview: coverage, queue, budget, runs. Provider health is
// attached by the server layer (it lives outside the repository).
export interface BrainStatusSummary {
  // The archive owner's display name (UI-settable): evidence and episodes
  // label the owner's messages with it instead of the confusing "Me".
  ownerName: string | null;
  totalVisibleMessages: number;
  assimilatedVisibleMessages: number;
  coveragePercent: number;
  chatsWithBacklog: number;
  backlogSample: BrainChatBacklogItem[];
  tasks: BrainTaskSummary;
  usageToday: BrainLlmUsageSummary;
  latestRun: BrainRunSummary | null;
  activeRun: BrainRunSummary | null;
}

// The /api/brain/status response: repository status + provider + scheduler.
export interface BrainOverview extends BrainStatusSummary {
  provider: BrainProviderStatus;
  scheduler: BrainSchedulerStatus;
}

// --- Episodic tier ---

export type BrainClaimKind = "fact" | "decision" | "commitment" | "question" | "event";
export type BrainEpisodeGenerator = "model" | "extractive";

export interface BrainCitationRecord {
  sourceMessageKey: string;
  sourceChatId: string;
  messageId: number | null;
  senderSourceJid: string | null;
  timestampMs: number | null;
}

export interface BrainClaimRecord {
  id: string;
  kind: BrainClaimKind;
  text: string;
  citations: BrainCitationRecord[];
}

export interface BrainEpisodeInput {
  chatSourceId: string;
  startAtMs: number;
  endAtMs: number;
  messageCount: number;
  participants: string[];
  summary: string;
  markdown: string;
  generator: BrainEpisodeGenerator;
  model: string | null;
  runId: string | null;
  claims: Array<{ kind: BrainClaimKind; text: string; citations: string[] }>;
}

export interface BrainEpisodeRecord {
  id: string;
  chatSourceId: string;
  chatDisplayName: string | null;
  startAtMs: number;
  endAtMs: number;
  messageCount: number;
  participants: string[];
  summary: string;
  markdown: string;
  generator: BrainEpisodeGenerator;
  model: string | null;
  status: "current" | "superseded" | "stale" | "compressed";
  createdAt: string;
  claims: BrainClaimRecord[];
}

// In-memory progress of a manual/scheduled brain run (job + polling model).
export interface BrainRunProgress {
  state: "idle" | "running" | "completed" | "failed" | "budget_exceeded";
  runId: string | null;
  mode: BrainEpisodeGenerator;
  provider: string | null;
  model: string | null;
  processedChats: number;
  totalChats: number;
  currentChat: string | null;
  episodesCommitted: number;
  claimsCommitted: number;
  modelCalls: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

// Progress of a search reindex job (chunked FTS rebuild).
export interface SearchReindexProgress {
  state: "idle" | "running" | "finalizing" | "completed" | "failed";
  processedMessages: number;
  totalMessages: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ImportRequest {
  msgstorePath: string;
  waPath?: string | null;
  mediaPath?: string | null;
  key?: string | null;
  keyPath?: string | null;
  keepDecrypted?: boolean;
  mode?: ImportMode;
}

export interface ImportVerificationSummary {
  ok: boolean;
  encrypted: boolean;
  message: string;
}

// Native OS file/folder picker (see server/import/nativePicker.ts). The picker
// returns an absolute path the server reads in place — nothing is uploaded.
export type PickKind = "backup-root" | "media" | "msgstore" | "wa";

export type PickResult =
  | { path: string }
  | { cancelled: true }
  | { unavailable: true; reason: string };

// Backup-folder auto-detection (see server/import/detectBackup.ts).
export type BackupInputKind = "msgstore" | "wa" | "media";

export interface BackupDetectionFile {
  kind: BackupInputKind;
  name: string;
  path: string;
  encrypted: boolean;
}

export interface BackupAuxiliaryFile {
  // A recognized auxiliary WhatsApp backup file, detected and reserved for a
  // future ingestion — never ingested by this import.
  kind: string;
  name: string;
  path: string;
}

export interface BackupDetectionManifest {
  root: string;
  // valid === (msgstore !== null); a folder with no msgstore cannot be imported.
  valid: boolean;
  msgstore: BackupDetectionFile | null;
  wa: BackupDetectionFile | null;
  media: { name: string; path: string } | null;
  auxiliary: BackupAuxiliaryFile[];
  notes: string[];
}

export type ImportProgressStep =
  | "validating"
  | "initializing"
  | "preparing"
  | "decrypting"
  | "opening"
  | "parsing"
  | "contacts"
  | "identity-merge"
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
      // Of the unmatched: queued for CDN recovery vs. genuinely unrecoverable.
      queuedForRecovery?: number;
      unrecoverable?: number;
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
