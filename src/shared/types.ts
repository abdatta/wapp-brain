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

// Source signals deliberately retain only information the archive can use
// locally. Their provenance lets a backup re-import enrich a live observation
// without ever treating display text as identity or retaining raw source rows.
export type ArchiveSignalSource = "backup" | "live";
export const ARCHIVE_SIGNAL_CAPTURE_VERSION = 1;

export interface ArchiveSignalProvenance {
  source: ArchiveSignalSource;
  sourceEventKey: string | null;
  observedAtMs: number | null;
  captureVersion: number;
}

// A canonical signal can be observed by both an Android backup and live sync.
// Keep those observations independently auditable without duplicating the
// canonical payload in every source row. `detailJson` is deliberately only
// available from the focused loopback detail surface; list/status/evidence
// DTOs never include it.
export type ArchiveSignalFamily =
  | "number_change"
  | "membership_period"
  | "membership_event"
  | "chat_metadata"
  | "location"
  | "location_observation"
  | "vcard"
  | "edit"
  | "deletion"
  | "media_interpretation";

export interface ArchiveSignalObservation extends ArchiveSignalProvenance {
  factKey: string;
  family: ArchiveSignalFamily;
  sourceMessageKey: string | null;
  detailJson: string | null;
}

export interface IdentityNumberChangeRecord extends ArchiveSignalProvenance {
  eventKey: string;
  chatSourceId: string | null;
  sourceMessageKey: string | null;
  oldJid: string;
  newJid: string;
  actorJid: string | null;
}

export type GroupMembershipAction = "add" | "remove" | "join" | "leave" | "invite" | "accept" | "promote" | "demote";

export interface GroupMembershipPeriodRecord extends ArchiveSignalProvenance {
  periodKey: string;
  groupSourceId: string;
  participantJid: string;
  joinedAtMs: number | null;
  leftAtMs: number | null;
  role: string | null;
}

export interface GroupMembershipEventRecord extends ArchiveSignalProvenance {
  eventKey: string;
  groupSourceId: string;
  participantJid: string;
  action: GroupMembershipAction;
  actorJid: string | null;
  sourceMessageKey: string | null;
  oldRole?: string | null;
  newRole?: string | null;
  rawType?: string | null;
  rawParameters?: string | null;
}

export type ChatMetadataField =
  | "subject"
  | "description"
  | "photo"
  | "invite_link"
  | "announcement"
  | "restriction"
  | "member_add"
  | "join_approval"
  | "disappearing";

export interface ChatMetadataHistoryRecord extends ArchiveSignalProvenance {
  eventKey: string;
  chatSourceId: string;
  field: ChatMetadataField;
  sourceMessageKey: string | null;
  actorJid: string | null;
  oldValue: string | null;
  newValue: string | null;
  rawType?: string | null;
  rawParameters?: string | null;
}

export interface MessageLocationRecord extends ArchiveSignalProvenance {
  sourceMessageKey: string;
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  address: string | null;
  isLive: boolean;
  accuracyMeters: number | null;
  url?: string | null;
  comment?: string | null;
  caption?: string | null;
  speedMps?: number | null;
  headingDegrees?: number | null;
  sequenceNumber?: number | null;
  timeOffsetMs?: number | null;
  liveShareDurationMs?: number | null;
  finalAtMs?: number | null;
  hasThumbnail?: boolean;
}

export interface MessageLocationObservationRecord extends ArchiveSignalProvenance {
  observationKey: string;
  sourceMessageKey: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  speedMps: number | null;
  headingDegrees: number | null;
  sequenceNumber: number | null;
  timeOffsetMs: number | null;
  finalAtMs: number | null;
  hasThumbnail: boolean;
}

export interface VCardProperty {
  name: string;
  group: string | null;
  parameters: Array<{ name: string; values: string[] }>;
  value: string;
}

export type VCardDownloadKind = "source" | "constructed" | "unavailable";

export interface MessageVCardRecord extends ArchiveSignalProvenance {
  sourceMessageKey: string;
  cardIndex: number;
  displayName: string | null;
  vcard: string | null;
  resolvedJid: string | null;
  properties?: VCardProperty[];
  downloadKind?: VCardDownloadKind;
  downloadFileName?: string | null;
}

export interface MessageEditEventRecord extends ArchiveSignalProvenance {
  eventKey: string;
  sourceMessageKey: string;
  originalSourceMessageId: string | null;
  observedEditMessageId: string | null;
}

export interface MessageDeletionRecord extends ArchiveSignalProvenance {
  sourceMessageKey: string;
  revokedByJid: string | null;
  revokedByAdmin?: boolean | null;
  deletionKind?: string | null;
}

export type MessageMediaInterpretationKind = "accessibility_label" | "transcription" | "transcription_segment";

export interface MessageMediaInterpretationRecord extends ArchiveSignalProvenance {
  sourceMessageKey: string;
  kind: MessageMediaInterpretationKind;
  segmentIndex: number;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

// These are the only receipt-derived values that may leave the source backup.
// They are internal repository inputs, never general message/status DTO fields.
export interface EngagementAggregateRecord extends ArchiveSignalProvenance {
  aggregateKey: string;
  chatSourceId: string;
  counterpartyJid: string | null;
  eligibleOutgoingCount: number;
  deliveredCount: number;
  readCount: number;
  responseLatencySampleCount: number;
  medianResponseLatencyMs: number | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  algorithmVersion: number;
}

export interface ArchiveSignalBatch {
  numberChanges?: IdentityNumberChangeRecord[];
  membershipPeriods?: GroupMembershipPeriodRecord[];
  membershipEvents?: GroupMembershipEventRecord[];
  chatMetadataHistory?: ChatMetadataHistoryRecord[];
  locations?: MessageLocationRecord[];
  locationObservations?: MessageLocationObservationRecord[];
  vcards?: MessageVCardRecord[];
  editEvents?: MessageEditEventRecord[];
  deletions?: MessageDeletionRecord[];
  mediaInterpretations?: MessageMediaInterpretationRecord[];
  engagementAggregates?: EngagementAggregateRecord[];
}

export type ArchiveSignalKind =
  | "mention"
  | "location"
  | "vcard"
  | "link_preview"
  | "edit"
  | "deletion"
  | "media_interpretation";

export interface ArchiveSignalAnchor {
  sourceMessageKey: string;
  kinds: ArchiveSignalKind[];
  captureVersion: number;
}

export interface MessageLocationSummary {
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  address: string | null;
  isLive: boolean;
  detailAvailable?: boolean;
}

export interface MessageVCardSummary {
  displayName: string | null;
  resolvedJid: string | null;
  downloadKind?: VCardDownloadKind;
}

export interface MessageDeletionSummary {
  revokedByJid: string | null;
  revokedAtMs: number | null;
  detailAvailable?: boolean;
}

export interface MessageEditEventSummary {
  observedAtMs: number | null;
  hasHeldRevision: boolean;
  detailAvailable?: boolean;
}

export interface MessageMediaInterpretationSummary {
  kind: MessageMediaInterpretationKind;
  text: string;
  segmentIndex: number;
}

export interface MessageStructuredSignals {
  mentionedJids: string[];
  location: MessageLocationSummary | null;
  vcards: MessageVCardSummary[];
  deletion: MessageDeletionSummary | null;
  edit: MessageEditEventSummary | null;
  mediaInterpretations: MessageMediaInterpretationSummary[];
  captureVersion: number | null;
}

export interface MessageDetailAvailability {
  hasLocation: boolean;
  vcardCount: number;
  hasDeletion: boolean;
  hasEditHistory: boolean;
  hasSourceInterpretation: boolean;
  hasSystemEventDetail: boolean;
}

export interface MessageEditTimelineEntry {
  kind: "sent" | "held_revision" | "metadata_only_edit" | "current";
  timestampMs: number | null;
  text: string | null;
  source: ArchiveSignalSource | "archive";
  sourceEventKey: string | null;
}

export interface MessageDeletionDetail {
  revokedByJid: string | null;
  revokedByAdmin: boolean | null;
  deletionKind: string | null;
  deletedAtMs: number | null;
  sentAtMs: number | null;
  contentState: "retained" | "never_captured";
  observations: ArchiveSignalObservation[];
}

export interface MessageSystemEventDetail {
  kind: MessageSystemEventKind;
  eventKey: string;
  summary: string;
  actorJid: string | null;
  actorLabel: string | null;
  participantJid: string | null;
  participantLabel: string | null;
  oldJid: string | null;
  oldIdentityLabel: string | null;
  newJid: string | null;
  newIdentityLabel: string | null;
  oldValue: string | null;
  newValue: string | null;
  action: GroupMembershipAction | null;
  field: ChatMetadataField | null;
  occurredAtMs: number | null;
  rawType: string | null;
  rawParameters: string | null;
  observations: ArchiveSignalObservation[];
}

// Focused owner-local API response. All exact fields are intentionally kept
// out of MessageListItem; callers load this only for an explicit message.
export interface MessageDetail {
  id: number;
  sourceMessageKey: string;
  sentAtMs: number | null;
  availability: MessageDetailAvailability;
  locations: Array<MessageLocationRecord & { observations: MessageLocationObservationRecord[]; provenance: ArchiveSignalObservation[] }>;
  vcards: Array<MessageVCardRecord & { provenance: ArchiveSignalObservation[] }>;
  mentionedJids: string[];
  editTimeline: MessageEditTimelineEntry[];
  deletion: MessageDeletionDetail | null;
  mediaInterpretations: MessageMediaInterpretationRecord[];
  linkPreview: LinkPreviewSummary | null;
  systemEvents: MessageSystemEventDetail[];
}

// Thread/list DTO projection. Exact coordinates, raw JIDs, vCard bodies, and
// transcript text are evidence-only local data, never general API payloads.
export interface MessageStructuredSignalSummary {
  mentionCount: number;
  location: Pick<MessageLocationSummary, "name" | "address" | "isLive"> | null;
  vcards: Array<Pick<MessageVCardSummary, "displayName">>;
  deletion: Pick<MessageDeletionSummary, "revokedAtMs"> | null;
  edit: MessageEditEventSummary | null;
  mediaInterpretations: Array<Pick<MessageMediaInterpretationSummary, "kind" | "segmentIndex"> & { hasText: boolean }>;
  captureVersion: number | null;
  detailAvailability?: MessageDetailAvailability;
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
  // Only the in-app rename path sets 'user'; imports and enrichment never do.
  // A 'user'-sourced stored name outranks every other name source and is
  // replaceable only by another user write.
  displayNameSource?: "user" | null;
  phoneNumber?: string | null;
  pushName?: string | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface GoogleContactCandidate {
  phoneNumber: string;
  displayName: string;
}

// Person-level grouping captured from the provider: which normalized numbers
// belong to one Google contact. Grouping capture is independent of name
// ambiguity (a contested name never removes a number from its contact's
// grouping) and exists to drive same-contact person auto-connect.
export interface GoogleContactGroupEntry {
  resourceName: string;
  phoneE164: string;
  displayName: string | null;
}

export interface GoogleContactsSyncResult {
  fetchedPeople: number;
  usableNumbers: number;
  matchedIdentities: number;
  improvedNames: number;
  ambiguousNumbers: number;
  skippedNumbers: number;
  // Same-contact grouping totals (absent on syncs persisted before the
  // two-level person model shipped).
  contactGroups?: number;
  groupedNumbers?: number;
  personsAutoConnected?: number;
  syncedAt: string;
}

// --- Two-level person model ---
// Identities (canonical JIDs) are immutable anchors; persons are an editable
// grouping over identities via a membership table. Connect inserts a row,
// disconnect deletes it; nothing durable ever keys on a person id.

export type PersonMemberSource = "google" | "number_change" | "user";
export type PersonSuggestionKind = "same_name" | "shared_group" | "co_citation" | "succession" | "shared_vcard" | "llm";
export type PersonSuggestionStatus = "pending" | "accepted" | "rejected" | "superseded";

export interface PersonMemberRecord {
  identityJid: string;
  source: PersonMemberSource;
  evidence: Record<string, unknown> | null;
  linkedAt: string;
  // Read-time context so provenance and the primary-member rule are visible
  // where membership is presented; never stored.
  displayLabel: string | null;
  phoneNumber: string | null;
  messageCount: number;
  hasSavedName: boolean;
}

export interface PersonRecord {
  id: string;
  // Derived at read time from the primary member (saved-name member with the
  // highest message count, else highest message count). Never stored: nothing
  // in the system groups by name.
  displayLabel: string | null;
  members: PersonMemberRecord[];
  unconfirmedHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonRedirectRecord {
  personId: string;
  replacedByPersonId: string | null;
  survivingJid: string | null;
  createdAt: string;
}

export interface PersonLookupResult {
  person: PersonRecord | null;
  redirect: PersonRedirectRecord | null;
}

export type PersonConnectOutcome = "connected" | "already_connected" | "union" | "suppressed" | "self" | "invalid";

export interface PersonConnectResult {
  outcome: PersonConnectOutcome;
  personId: string | null;
}

export interface PersonDisconnectResult {
  disconnected: boolean;
  // The person the identity was removed from (null when it was not a member).
  personId: string | null;
  // Set when the removal left fewer than two members and the person dissolved.
  dissolved: boolean;
}

export interface PersonSuggestionInput {
  jidA: string;
  jidB: string;
  kind: PersonSuggestionKind;
  score: number;
  evidence: Record<string, unknown>;
}

export interface PersonSuggestionRecord {
  id: string;
  jidLow: string;
  jidHigh: string;
  kind: PersonSuggestionKind;
  score: number;
  evidence: Record<string, unknown>;
  status: PersonSuggestionStatus;
  createdAt: string;
  updatedAt: string;
  // Read-time labels for the two identities, display-rule resolved.
  lowLabel: string | null;
  highLabel: string | null;
  // Read-time context so a human can actually decide: complete numbers, each
  // identity's DM chat id (for one-click chat exploration), message volume
  // per side (drives value-aware sorting), and display labels for any
  // chat/group source ids referenced by the evidence.
  lowPhone: string | null;
  highPhone: string | null;
  lowChatId: number | null;
  highChatId: number | null;
  lowMessageCount: number;
  highMessageCount: number;
  // The rest of the merge's value proposition, resolved at read time: how
  // often each identity is @mentioned and how many groups each is in.
  lowMentionCount: number;
  highMentionCount: number;
  lowGroupCount: number;
  highGroupCount: number;
  chatLabels: Record<string, string>;
}

// A sender's recent already-stored media, for the compare dialog's strips —
// ids and labels only, never bytes.
export interface IdentityRecentMedia {
  messageId: number;
  assetId: number;
  mimeType: string | null;
  hasThumbnail: boolean;
  timestampMs: number | null;
  chatLabel: string | null;
}

// Shared-group membership timeline entry for a compared pair.
export interface CompareTimelineEntry {
  groupSourceId: string;
  label: string | null;
  low: { joinedAtMs: number | null; leftAtMs: number | null } | null;
  high: { joinedAtMs: number | null; leftAtMs: number | null } | null;
}

export interface PersonCompareContext {
  lowMedia: IdentityRecentMedia[];
  highMedia: IdentityRecentMedia[];
  sharedGroups: CompareTimelineEntry[];
}

// A sender's recent activity across every chat (groups included) — the
// compare dialog's answer for identities with no direct chat.
export interface IdentityRecentMessage {
  chatId: number;
  chatSourceId: string;
  chatLabel: string | null;
  chatType: ChatType;
  timestampMs: number | null;
  direction: "incoming" | "outgoing" | "system" | "unknown";
  messageType: string;
  text: string | null;
}

// Freshness surface for the People page: when the deterministic passes last
// ran in this server process (in-memory — a restart honestly reads "not yet").
export interface PersonScanStatus {
  lastAutoConnectAtMs: number | null;
  lastAutoConnect: PersonAutoConnectSummary | null;
  lastDetectorAtMs: number | null;
  lastDetectors: { created: number; updated: number } | null;
}

export interface PersonLinkSuppressionRecord {
  jidLow: string;
  jidHigh: string;
  reason: "suggestion_rejected" | "disconnected";
  createdAt: string;
  // Read-time display context (resolved labels + complete numbers) so the
  // blocked-pairs review is human-readable.
  lowLabel?: string | null;
  highLabel?: string | null;
  lowPhone?: string | null;
  highPhone?: string | null;
}

export interface PersonLinkEventRecord {
  id: number;
  action: "connect" | "disconnect" | "union" | "dissolve" | "suggest" | "accept" | "reject" | "unreject" | "release";
  personId: string | null;
  identityJid: string | null;
  source: string | null;
  evidence: Record<string, unknown> | null;
  createdAt: string;
}

export interface PersonAutoConnectSummary {
  googleConnected: number;
  numberChangeConnected: number;
  unions: number;
  skippedSuppressed: number;
}

export interface PersonScanSummary extends PersonAutoConnectSummary {
  suggestionsCreated: number;
  suggestionsUpdated: number;
}

// Bounded read surfaces the deterministic person passes are built on.
export interface IdentityActivitySummary {
  jid: string;
  messages: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface IdentityChatActivity {
  jid: string;
  chatSourceId: string;
  messages: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface IdentityProfile {
  jid: string;
  displayName: string | null;
  pushName: string | null;
  phoneNumber: string | null;
  messageCount: number;
}

export interface GoogleContactsStatus {
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  callbackUrl: string;
  lastSync: GoogleContactsSyncResult | null;
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
  // WhatsApp keeps a reply-owned, self-contained copy of the quoted message.
  // It is deliberately not a normal archive message: it has no chat membership
  // of its own and is never independently searchable or citable.
  quotedSnapshot?: QuotedMessageSnapshot | null;
  isDeleted: boolean;
  isForwarded: boolean;
  isStarred: boolean;
  // Explicit mentioned JIDs from the transport envelope (live contextInfo);
  // text-token "@digits" mentions are additionally derived at write time.
  mentionedJids?: string[] | null;
  rawMetadata?: Record<string, unknown> | null;
}

export interface QuotedMessageStructuredLocation {
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  address: string | null;
}

export interface QuotedMessageStructuredVCard {
  name: string | null;
  vcard: string | null;
}

export interface QuotedMessageStructuredLocationSummary {
  name: string | null;
  address: string | null;
}

export interface QuotedMessageStructuredVCardSummary {
  name: string | null;
}

export interface QuotedMessageSnapshot {
  quotedSourceMessageId: string | null;
  quotedSourceChatId: string | null;
  quotedSenderSourceJid: string | null;
  quotedFromMe: boolean | null;
  timestampMs: number | null;
  messageType: string;
  rawTypeCode?: string | number | null;
  body: string | null;
  caption: string | null;
  mediaMimeType?: string | null;
  mediaName?: string | null;
  thumbnail?: Uint8Array | null;
  location?: QuotedMessageStructuredLocation | null;
  vcard?: QuotedMessageStructuredVCard | null;
  mentionedJids?: string[] | null;
}

// The resolved, consumer-safe shape. Thumbnail bytes are intentionally omitted
// from normal API/evidence projections and use a dedicated local endpoint.
export interface QuotedMessageSnapshotSummary {
  // True for a reply-owned backup/live capture. False is a bounded same-chat
  // legacy-pointer preview synthesized only for read models. Omitted remains
  // compatible with older callers and is treated as captured.
  captured?: boolean;
  quotedSourceMessageId: string | null;
  quotedSourceChatId: string | null;
  quotedSenderSourceJid: string | null;
  quotedSenderDisplayName: string | null;
  quotedSenderNameIsPushName: boolean;
  quotedFromMe: boolean | null;
  timestampMs: number | null;
  messageType: string;
  body: string | null;
  caption: string | null;
  mediaMimeType: string | null;
  mediaName: string | null;
  // Exact coordinates and raw vCard bodies remain on the local captured
  // snapshot record; general message/evidence projections receive labels only.
  location: QuotedMessageStructuredLocationSummary | null;
  vcard: QuotedMessageStructuredVCardSummary | null;
  mentionedJids: string[];
  hasThumbnail: boolean;
  // Resolves only inside the reply's own chat. This intentionally stays null
  // for Reply Privately and deleted/unarchived originals.
  originalMessageId: number | null;
}

export interface ChatListItem {
  id: number;
  sourceChatId: string;
  jid: string;
  // Name or phone number; NULL means unresolved and the UI renders an explicit
  // state instead of a raw identifier. When the same label would render for a
  // different person elsewhere in the response, it arrives disambiguated with
  // a deterministic suffix (complete +E.164).
  displayName: string | null;
  chatType: ChatType;
  messageCount: number;
  participantCount: number;
  lastMessageAt: string | null;
  // Display-level annotation from a high-confidence pending person suggestion
  // ("possibly the same as … — unconfirmed"). Never influences claims,
  // evidence, or search — those paths do not read suggestions.
  unconfirmedHint?: string | null;
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

// A display-safe explanation for a verified system/history record owned by a
// thread message. Raw JIDs, phone endpoints, event keys, and binary metadata
// stay in the local canonical signal tables and never cross this DTO boundary.
export type MessageSystemEventKind = "number_change" | "membership" | "chat_metadata" | "generic";

export interface MessageSystemEventSummary {
  kind: MessageSystemEventKind;
  summary: string;
  captureVersion: number;
  detailAvailable?: boolean;
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
  linkPreview?: LinkPreviewSummary | null;
  // Local-only structured source signals. The vCard payload and other raw
  // source material stay behind focused repository reads; list consumers get
  // only display-safe summaries.
  structuredSignals?: MessageStructuredSignalSummary | null;
  // Verified history records rendered in the local thread. Unlike a generic
  // system-message interpretation, these are explicit, privacy-safe actions.
  systemEvents?: MessageSystemEventSummary[];
  quotedSnapshot: QuotedMessageSnapshotSummary | null;
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
  // Sender-embedded preview metadata only; thumbnail bytes remain on their
  // dedicated local endpoint and never enter prompt/evidence text.
  linkPreview: LinkPreviewSummary | null;
  // Evidence-pack fidelity: whether the row is a forward, the quoted message's
  // source id (resolved to a referent at prompt-assembly time), and reactions
  // targeting this message. Reactions carry the raw reactor identity so the
  // brain applies one owner/number labelling policy (see episodes.ts); the
  // final reactor label is not baked here.
  isForwarded: boolean;
  quotedSourceMessageId: string | null;
  quotedSnapshot: QuotedMessageSnapshotSummary | null;
  structuredSignals?: MessageStructuredSignals | null;
  reactions: MemoryEvidenceReaction[];
  // Label provenance (contract v2): true when senderDisplayName came from the
  // contact's self-set push name because no saved display name exists. The
  // pack labeler renders such labels with a leading tilde (~name) and the
  // episode stamps the JID for later repair.
  senderNameIsPushName: boolean;
}

export interface MemoryEvidenceReaction {
  emoji: string;
  reactorJid: string | null;
  reactorDisplayName: string | null;
  reactorNameIsPushName: boolean;
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
  // Relaxation acceptance threshold: looser ladder tiers run only while the
  // result count is below this (default 1 — i.e. only on zero hits). Internal
  // consumers (the future brain fast path) may demand more.
  minHits?: number | null;
  limit: number;
  offset: number;
}

// How strictly the returned results matched the query. "exact" = every term
// as typed (alias variants of a term still count as that term); "relaxed" =
// every term still required but prefix-loosened; "partial" = some terms were
// dropped (or only a subset is required) — degraded precision is always
// labelled, never silently blended.
export type SearchMatchTier = "exact" | "relaxed" | "partial";

export interface SearchRelaxationInfo {
  // Ladder tier that produced the results (1 prefix, 2 term-drop, 3 best-half, 4 ranked OR).
  tier: 1 | 2 | 3 | 4;
  droppedTerms: string[];
  totalTerms: number;
  requiredTerms: number;
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
  // Relevance after recency decay (plus any mention boost); higher is better,
  // comparable only within one result set.
  score: number;
  hasMedia: boolean;
  isDeleted: boolean;
  // Present on partial-tier responses: how many of the query's terms this row
  // covers ("matched m of n"). Display-grade, not a ranking input.
  termCoverage?: { matched: number; total: number };
  // True when the hit matched only through the sender's display identity —
  // a sent-by hit, not an about-hit.
  senderOnlyMatch?: boolean;
}

export interface SearchResponse {
  index: SearchIndexStatus;
  // Exact number of messages matching the query and filters across the whole
  // archive — always computed from the tier that produced `results`, so the
  // count describes what is actually shown.
  totalMatches: number;
  results: SearchResultItem[];
  // Precision honesty: which tier answered, and what was loosened to get it.
  matchTier: SearchMatchTier;
  relaxation?: SearchRelaxationInfo | null;
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

export type BrainTaskKind = "episode" | "regenerate" | "rollup" | "overview" | "merge_adjudicate" | "reindex" | "project_pages";
export type BrainTaskStatus = "pending" | "running" | "done" | "failed";
export type BrainRunKind = "nightly" | "catchup" | "manual" | "backfill" | "regenerate" | "lifecycle";
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
  // Rowid half of the compound watermark cursor: pack selection must resume
  // strictly after (assimilatedThroughMs, assimilatedThroughId) so a new
  // message sharing the boundary timestamp is not skipped.
  assimilatedThroughId: number;
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
  // Whether the active provider's reported token usage is exact or may fall
  // back to character estimates — surfaces offering a token budget disclose
  // this instead of presenting estimates as precise.
  tokenUsage: "exact" | "may-estimate" | "none";
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

// An additional number the archive owner has claimed as themself. Evidence
// labeling gives these ABSOLUTE precedence: they render as "Name (me)" even
// when the number is saved under another contact name. `currentLabel` is what
// the archive would otherwise call it — shown in the picker so selecting a
// different person by mistake is visible before saving.
export interface OwnerSelfIdentity {
  jid: string;
  number: string;
  currentLabel: string | null;
  messageCount: number;
}

// One row of the self-number autocomplete: plain substring matching over
// archived identities (no inference), always showing the current name.
export interface OwnerIdentitySuggestion {
  jid: string;
  number: string;
  label: string | null;
  messageCount: number;
  isSelf: boolean;
}

// One-call brain overview: coverage, queue, budget, runs. Provider health is
// attached by the server layer (it lives outside the repository).
export interface BrainStatusSummary {
  // The archive owner's display name (UI-settable): evidence and episodes
  // label the owner's messages with it instead of the confusing "Me".
  ownerName: string | null;
  // Additional self numbers with owner-label precedence in evidence packs.
  selfIdentities: OwnerSelfIdentity[];
  // Configured ledger caps, surfaced so the run console can validate budgets
  // against what the server will actually enforce.
  limits: { maxCallsPerHour: number; maxCallsPerDay: number };
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

// The /api/brain/status response: repository status + provider + scheduler,
// plus contract-v2 quality surfaces attached by the server layer.
export interface BrainOverview extends BrainStatusSummary {
  provider: BrainProviderStatus;
  scheduler: BrainSchedulerStatus;
  extractionVersion?: number;
  // Current episodes that are extractive-generated or carry a stale
  // extraction version — the `brain regenerate` queue size.
  regenerableEpisodes?: number;
  validationIssues?: BrainValidationIssueSummary;
  // The D13 media-demand stat: gap counts split by modality and impact.
  mediaGaps?: BrainMediaGapSummary[];
  // Identity late-resolution debt: episodes whose participants are still
  // labelled by a number, ranked so the highest-value contact saves surface.
  resolutionDebt?: BrainResolutionDebtSummary;
  // Eval harness free interim signal: per-(model, extraction_version) quality
  // rollup — fallback rates render even before any manual grades exist.
  modelQuality?: BrainModelQualityAggregate[];
}

// One unresolved identity in the resolution-debt surface: how much brain content
// saving its contact would repair, so the queue ranks by payoff.
export interface BrainResolutionDebtIdentity {
  jid: string;
  label: string;
  messageCount: number;
  episodeCount: number;
}

// The resolution-debt surface: how much of the brain still refers to people by
// number, and which saves would repair the most. Computed with no model call.
export interface BrainResolutionDebtSummary {
  episodesWithUnresolved: number;
  distinctIdentities: number;
  topIdentities: BrainResolutionDebtIdentity[];
}

// The outcome of a deterministic identity repair pass (zero model calls).
export interface IdentityRepairResult {
  episodesRepaired: number;
  tokensSubstituted: number;
  messagesRecomputed: number;
}

// --- Episodic tier ---

export type BrainClaimKind = "fact" | "decision" | "commitment" | "question" | "event";
export type BrainEpisodeGenerator = "model" | "extractive";
// Epistemic level of a claim (contract v2): 'stated' — the speaker directly
// asserts it; 'hedged' — the statement carries uncertainty markers; 'reported'
// — second-hand, or the claim's referent/subject was inferred by the model
// rather than explicit in the messages.
export type BrainClaimConfidence = "stated" | "hedged" | "reported";
export type BrainEntityKind = "person" | "org" | "place" | "project" | "other";

export interface BrainCitationRecord {
  sourceMessageKey: string;
  sourceChatId: string;
  messageId: number | null;
  senderSourceJid: string | null;
  timestampMs: number | null;
}

// A typed entity a claim mentions. `jid` is the canonical identity anchor,
// resolved at commit by matching the entity name against the pack's
// participant labels — never model-emitted. NULL for non-participants.
export interface BrainClaimEntityRecord {
  kind: BrainEntityKind;
  name: string;
  jid: string | null;
  role: string | null;
}

export interface BrainClaimRecord {
  id: string;
  kind: BrainClaimKind;
  text: string;
  eventAtMs: number | null;
  validUntilMs: number | null;
  confidence: BrainClaimConfidence;
  entities: BrainClaimEntityRecord[];
  citations: BrainCitationRecord[];
}

export interface BrainClaimInput {
  kind: BrainClaimKind;
  text: string;
  citations: string[];
  eventAtMs?: number | null;
  validUntilMs?: number | null;
  confidence?: BrainClaimConfidence;
  entities?: Array<{ kind: BrainEntityKind; name: string; jid?: string | null; role?: string | null }>;
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
  // When an intended model generation fell back to extractive, the privacy-safe
  // reason is stored per episode (not just logged) so run honesty is durable.
  fallbackReason?: string | null;
  // Contract v2: version stamp from the extraction code's named constant.
  extractionVersion: number;
  // Episode-level structured topics (never load-bearing in prose).
  topics?: string[];
  // Late-binding stamps, computed mechanically from the evidence pack:
  // participants labelled by a number token (unresolved identity), participants
  // labelled by a self-set push name (unverified identity), and media that
  // contributed neither text nor an interpretation label.
  unresolvedParticipants?: string[];
  pushNameParticipants?: string[];
  uninterpretedMediaCount?: number;
  quotedReplyAnchors?: QuotedReplyAnchor[];
  archiveSignalAnchors?: ArchiveSignalAnchor[];
  // When a model attempt fell back to extractive, the model that was attempted
  // — the truthful join for per-model fallback rates (eval harness). NULL on
  // model episodes and on no-provider extractive rows.
  attemptedModel?: string | null;
  // Regeneration commits pass false: the watermark already covers the window.
  advanceWatermark?: boolean;
  // Regeneration: mark this episode 'superseded' in the same transaction as
  // the replacement commit, so no crash window leaves both current.
  supersedesEpisodeId?: string | null;
  // Media-gap demand signal (D13), model episodes only; modality already
  // derived from the cited message by the extraction layer.
  mediaGaps?: BrainMediaGapRecord[];
  claims: BrainClaimInput[];
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
  fallbackReason: string | null;
  attemptedModel: string | null;
  extractionVersion: number;
  topics: string[];
  unresolvedParticipants: string[];
  pushNameParticipants: string[];
  uninterpretedMediaCount: number;
  quotedReplyAnchors: QuotedReplyAnchor[];
  archiveSignalAnchors?: ArchiveSignalAnchor[];
  mediaGaps: BrainMediaGapRecord[];
  createdAt: string;
  claims: BrainClaimRecord[];
}

export interface QuotedReplyAnchor {
  replySourceMessageKey: string;
  quotedSourceMessageId: string | null;
  quotedSourceChatId: string | null;
  snapshotPresent: boolean;
}

// --- Brain media-gap demand signal (contract v2, D13) ---
// Media content never reaches the model; the model instead records that an
// unavailable media message's content would have improved the episode. The
// aggregate is the demand stat that decides whether (and which modality first)
// media interpretation is worth building; per-episode rows are the
// materiality-aware regeneration selector once it exists.

export type BrainMediaGapImpact = "blocks" | "enriches";
export type BrainMediaGapModality = "image" | "audio" | "video" | "document" | "other";

export interface BrainMediaGapRecord {
  sourceMessageKey: string;
  // Derived at commit from the cited message's own type — never model-emitted.
  modality: BrainMediaGapModality;
  impact: BrainMediaGapImpact;
  note: string | null;
}

export interface BrainMediaGapSummary {
  modality: BrainMediaGapModality;
  impact: BrainMediaGapImpact;
  count: number;
}

// --- Brain validation issues (contract v2) ---
// Quality signals and salvage records: structural failures that exhausted the
// retry (severity 'error'), quality lints like the anchoring check ('warning'),
// and informational notes ('info'). Flag rows never block a commit.

export type BrainValidationSeverity = "info" | "warning" | "error";

export interface BrainValidationIssueInput {
  runId?: string | null;
  chatSourceId?: string | null;
  episodeId?: string | null;
  claimSequence?: number | null;
  code: string;
  severity: BrainValidationSeverity;
  detail?: string | null;
}

export interface BrainValidationIssueRecord {
  id: number;
  runId: string | null;
  chatSourceId: string | null;
  episodeId: string | null;
  claimSequence: number | null;
  code: string;
  severity: BrainValidationSeverity;
  detail: string | null;
  createdAt: string;
}

export interface BrainValidationIssueSummary {
  error: number;
  warning: number;
  info: number;
}

// --- Brain evaluation (eval harness) ---
// Measurement is user-authored ground truth, not derived data: golden queries
// live in a local file outside git, and eval runs + claim grades survive every
// brain wipe/regeneration by design.

// One golden retrieval query. `expect` holds stable source message keys
// (`wa|<chat>|<msgId>`), the same key space search results and citations use.
export interface BrainGoldenQuery {
  id: string;
  // Open vocabulary; the canonical five are paraphrase / person / commitment /
  // temporal / code-mixed. New classes are data, not schema.
  class: string;
  query: string;
  expect: string[];
  note?: string | null;
}

export interface BrainGoldenSet {
  version: number;
  readme?: string;
  queries: BrainGoldenQuery[];
}

// Identity of a loaded golden set: runs record version+hash so results are
// comparable only within the same golden content.
export interface BrainGoldenSetInfo {
  path: string;
  version: number;
  hash: string;
  queryCount: number;
  classes: string[];
}

// Per-query eval detail, persisted with the run for inspection.
export interface BrainEvalQueryResult {
  queryId: string;
  class: string;
  query: string;
  // Expected keys that resolve to archived messages (scored) and those that
  // don't (quarantined — a stale golden entry, never a retrieval miss).
  validExpected: string[];
  invalidExpected: string[];
  // 1-based rank within the ranked results for each valid expected key; null
  // when not found within the largest K.
  ranks: Record<string, number | null>;
  recallAtK: Record<string, number>;
}

export interface BrainEvalClassStat {
  class: string;
  queries: number;
  recallAtK: Record<string, number>;
}

export interface BrainEvalRunRecord {
  id: string;
  ranAtMs: number;
  // Retrieval target; 'archive-search' today, extensible to future brain
  // retrieval modes.
  target: string;
  goldenVersion: number;
  goldenHash: string;
  kValues: number[];
  queryCount: number;
  // Queries skipped entirely because no expected key resolved.
  skippedQueryIds: string[];
  perClass: BrainEvalClassStat[];
  perQuery: BrainEvalQueryResult[];
  totals: { queries: number; recallAtK: Record<string, number>; zeroHitQueries: number };
  notes: string | null;
}

// Gate verdict: a run vs a baseline run, per class at every K.
export interface BrainEvalGateRegression {
  class: string;
  k: number;
  run: number;
  baseline: number;
  offendingQueryIds: string[];
}

export interface BrainEvalGateVerdict {
  verdict: "pass" | "fail" | "no-baseline";
  runId: string;
  baselineRunId: string | null;
  // False when run and baseline carry different golden hashes — labelled
  // cross-version, never silently mixed.
  sameGolden: boolean;
  regressions: BrainEvalGateRegression[];
}

// Manual claim-citation grades. Stamps are denormalized at grade time so a
// grade outlives its claim's supersession or deletion.
export type BrainClaimGradeValue = "supported" | "partial" | "unsupported" | "unclear";

export interface BrainClaimGradeRecord {
  claimId: string;
  grade: BrainClaimGradeValue;
  gradedAtMs: number;
  episodeId: string;
  chatSourceId: string;
  generator: BrainEpisodeGenerator;
  model: string | null;
  extractionVersion: number;
  claimKind: BrainClaimKind;
  claimConfidence: BrainClaimConfidence;
  claimText: string;
  citationKeys: string[];
}

// One claim in the grading sample, with its cited messages' full text resolved
// server-side (deleted originals arrive as tombstones).
export interface BrainGradingCitation {
  sourceMessageKey: string;
  timestampMs: number | null;
  senderSourceJid: string | null;
  text: string | null;
  deleted: boolean;
  // False when the cited message no longer exists in the archive at all.
  present: boolean;
}

export interface BrainGradingSampleClaim {
  claimId: string;
  episodeId: string;
  chatSourceId: string;
  chatDisplayName: string | null;
  model: string | null;
  extractionVersion: number;
  kind: BrainClaimKind;
  confidence: BrainClaimConfidence;
  text: string;
  eventAtMs: number | null;
  grade: BrainClaimGradeValue | null;
  citations: BrainGradingCitation[];
}

// Deterministic stratified sample: per model stamp, ungraded first, claim-UUID
// order (stable unbiased shuffle — same archive state, same sample).
export interface BrainGradingSampleModel {
  model: string;
  eligibleClaims: number;
  gradedClaims: number;
  claims: BrainGradingSampleClaim[];
}

export interface BrainGradingSample {
  perModel: number;
  models: BrainGradingSampleModel[];
}

// Per-(model, extraction_version) quality aggregate. Every rate ships with its
// denominator — thin data must look thin. `model` is 'unknown' for historical
// fallback rows that predate attempted-model stamping.
export interface BrainModelQualityAggregate {
  model: string;
  extractionVersion: number;
  // generator='model' episodes committed under this stamp (all statuses —
  // superseded rows still evidence generation quality).
  modelEpisodes: number;
  // Model attempts that fell back to extractive (fallback_reason set),
  // attributed via attempted_model.
  fallbackEpisodes: number;
  attempted: number;
  fallbackRate: number | null;
  claims: number;
  unanchoredWarnings: number;
  validationErrors: number;
  grades: Record<BrainClaimGradeValue, number>;
  gradedTotal: number;
  // supported / (supported + partial + unsupported); 'unclear' is excluded
  // from the denominator. Null until at least one gradable grade exists.
  strictPrecision: number | null;
}

// In-memory progress of a manual/scheduled brain run (job + polling model).
export interface BrainRunProgress {
  state: "idle" | "running" | "completed" | "failed" | "budget_exceeded" | "interrupted";
  runId: string | null;
  // Which run flavor is executing: manual assimilation, historical backfill,
  // regeneration, or a lifecycle closure sweep. Null until the first run of
  // the process.
  kind: "manual" | "backfill" | "regenerate" | "lifecycle" | null;
  // Pending episode tasks in the durable queue, refreshed per task completion
  // during a backfill run (null for run kinds that do not drain the queue).
  queuedTasks: number | null;
  // Approximate total episodes THIS run will commit, precomputed at run start
  // (regeneration knows it exactly; assimilation/backfill estimate it from the
  // scope's pending messages ÷ observed pack size). Drives the progress bar;
  // null until computed. The denominator is a guide, not a guarantee.
  estimatedEpisodes: number | null;
  mode: BrainEpisodeGenerator;
  provider: string | null;
  model: string | null;
  processedChats: number;
  totalChats: number;
  currentChat: string | null;
  // Accumulated input+output tokens across this run's model calls — what the
  // per-run token budget (when set) is enforced against.
  tokensUsed: number;
  episodesCommitted: number;
  // Of episodesCommitted, how many fell back to extractive placeholders — the
  // honest "N/M extractive" breakdown surfaced in the completion notice.
  extractiveEpisodes: number;
  claimsCommitted: number;
  modelCalls: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  // Closure-sweep counters (kind 'lifecycle' only): what the sweep offered and
  // what the model resolved, so the run surface reads in lifecycle terms.
  lifecycle?: BrainLifecycleSweepProgress | null;
}

export interface BrainLifecycleSweepProgress {
  nodesOffered: number;
  fulfilled: number;
  dismissed: number;
  stillOpen: number;
  // Calls whose response failed validation twice — nodes stayed open.
  failedCalls: number;
}

// --- Historical backfill (historical-backfill) ---
// Server-computed dashboard for the pre-brain archive drain: coverage, queue,
// drain rate, honest ETA, per-model spend, and the extractive-fallback canary.
// All meaning lives server-side (downstream-consumer principle).

// Per-model ledger spend, all-time and today, keyed by the ledger's provider
// string (e.g. "codex/gpt-5.6-terra").
export interface BrainBackfillModelSpend {
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  callsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
}

// The no-silent-degradation canary: of current episodes where a model was
// attempted, how many are extractive placeholders — plus the running run's
// own rate and a server-computed warning flag (threshold after a minimum
// attempted-episode denominator, so tiny runs never cry wolf).
export interface BrainBackfillFallbackCanary {
  totalEpisodes: number;
  extractiveEpisodes: number;
  ratePercent: number;
  currentRunAttempted: number;
  currentRunExtractive: number;
  currentRunWarning: boolean;
  // Warning across either scope (all-time or the running run) — the strip
  // styles from this, never from client-side thresholds.
  warning: boolean;
}

export interface BrainBackfillStatus {
  coveragePercent: number;
  totalVisibleMessages: number;
  assimilatedVisibleMessages: number;
  pendingMessages: number;
  pendingChats: number;
  // Episode tasks waiting in (or retired from) the durable queue.
  queuedTasks: number;
  failedTasks: number;
  // The in-flight run's live progress; null when idle.
  running: BrainRunProgress | null;
  // Episodes committed in the trailing 60 minutes; null when idle.
  drainRatePerHour: number | null;
  // Approximate hours to full coverage at the current rate. Null until the
  // trailing hour holds enough episodes to ground it — an early ETA lies.
  etaHours: number | null;
  // Observed mean messages per episode (the ETA's pack-size denominator).
  avgEpisodeMessages: number | null;
  spendByModel: BrainBackfillModelSpend[];
  fallback: BrainBackfillFallbackCanary;
  // Current extractive episodes the one-click sweep would regenerate.
  sweepableExtractive: number;
}

// Repository-level rollups behind BrainBackfillStatus (the server layer folds
// in run progress and the derived rate/ETA/warning semantics).
export interface BrainBackfillDbStats {
  totalVisibleMessages: number;
  assimilatedVisibleMessages: number;
  pendingChats: number;
  queuedEpisodeTasks: number;
  failedEpisodeTasks: number;
  episodesLastHour: number;
  currentEpisodes: number;
  avgEpisodeMessages: number | null;
  modelAttemptedEpisodes: number;
  fallbackEpisodes: number;
  sweepableExtractive: number;
  spendByModel: BrainBackfillModelSpend[];
}

// --- Knowledge graph (knowledge-graph-foundation) ---
// Derived-of-derived semantic substrate: typed nodes/edges rebuilt from
// committed episodes + captured archive signals with zero model calls. All
// meaning is server-side; UI, CLI, and future MCP consume these DTOs.

export type BrainGraphNodeKind =
  | "person"
  | "chat"
  | "topic"
  | "org"
  | "place"
  | "project"
  | "other"
  | "commitment"
  | "question"
  | "event"
  | "fact";
export type BrainGraphEdgeKind =
  | "participates_in"
  | "mentions"
  | "about"
  | "involves"
  | "related_to"
  | "replies_to"
  | "derived_from"
  | "alias_of"
  | "resolves";
// 'merged' nodes are redirect stubs (held ids never dangle); 'dormant' hides
// from ranked surfaces but stays directly readable — dormancy never deletes.
export type BrainGraphNodeStatus = "active" | "dormant" | "merged";

export interface BrainGraphNodeRecord {
  id: string;
  kind: BrainGraphNodeKind;
  naturalKey: string;
  slug: string;
  // Server-resolved display label (identity/person layer for person nodes,
  // chat display name for chat nodes, stored title otherwise) — read-time, so
  // renames re-label with zero regeneration.
  label: string;
  title: string | null;
  jid: string | null;
  chatScope: string | null;
  payload: Record<string, unknown> | null;
  status: BrainGraphNodeStatus;
  mergedInto: string | null;
  salience: number;
  citationCount: number;
  evidenceDays: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
}

// One-hop edge as seen from an anchor node (entity view / future explorer).
export interface BrainGraphEdgeView {
  id: number;
  kind: BrainGraphEdgeKind;
  direction: "out" | "in";
  otherNode: Pick<BrainGraphNodeRecord, "id" | "kind" | "label" | "slug" | "status" | "salience" | "jid">;
  weight: number;
  evidenceCount: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
}

export interface BrainGraphEntityClaim {
  id: string;
  kind: BrainClaimKind;
  text: string;
  confidence: BrainClaimConfidence;
  eventAtMs: number | null;
  validUntilMs: number | null;
  episodeId: string;
  chatSourceId: string;
  chatDisplayName: string | null;
  // The member identity node that anchored this claim into the aggregate.
  viaJid: string | null;
  citations: BrainCitationRecord[];
}

// Person-aggregated entity read: membership resolves at READ time through
// person_members, so connect/disconnect re-derive this with zero graph writes.
export interface BrainGraphEntityView {
  node: BrainGraphNodeRecord;
  personId: string | null;
  memberJids: string[];
  memberNodes: BrainGraphNodeRecord[];
  claims: BrainGraphEntityClaim[];
  edges: BrainGraphEdgeView[];
  aliases: string[];
  // True when the requested node id resolved through a merged redirect stub.
  redirected: boolean;
}

export interface BrainGraphUnresolvedEntity {
  node: BrainGraphNodeRecord;
  chatSourceId: string | null;
  chatDisplayName: string | null;
  claimCount: number;
}

// Typeahead suggestion for anchoring the explorer: a real node id + its
// read-time label, so the chosen anchor is unambiguous (unlike a free-text
// name that can match several same-named nodes).
export interface BrainGraphNodeSuggestion {
  id: string;
  label: string;
  kind: BrainGraphNodeKind;
  jid: string | null;
}

// --- Bounded neighborhood read (graph-explorer) --------------------------
// The product primitive: an anchored ego-graph, never the whole graph. One
// server-side answer serves the explorer UI, the deep retrieval path, and a
// future MCP tool wrapper — meaning lives here, in shared types.
export interface BrainGraphNeighborhoodParams {
  // Anchor by node id (redirect-following), canonical JID, name/alias, or the
  // source chat id of a chat node (an episode anchors on its chat).
  nodeId?: string;
  jid?: string;
  name?: string;
  chat?: string;
  // Traversal depth from the anchor; clamped to 1..2 server-side.
  depth?: number;
  // Edge-kind allowlist; undefined/empty means all kinds.
  kinds?: BrainGraphEdgeKind[];
  // Time window over each edge's last-evidence time (ms), inclusive.
  since?: number | null;
  until?: number | null;
  // Minimum node salience for neighbors (the anchor is always included).
  minSalience?: number;
  // Include dormant neighbors (hidden by default; dormancy never deletes).
  includeDormant?: boolean;
  // Hard caps, clamped to server ceilings; truncation is disclosed.
  maxNodes?: number;
  maxEdges?: number;
}

// Concrete filters actually applied after server-side clamping — echoed back
// so a consumer can render "showing N of M" honestly.
export interface BrainGraphNeighborhoodFilters {
  depth: number;
  kinds: BrainGraphEdgeKind[] | null;
  since: number | null;
  until: number | null;
  minSalience: number;
  includeDormant: boolean;
  maxNodes: number;
  maxEdges: number;
}

export interface BrainGraphNeighborhoodNode extends BrainGraphNodeRecord {
  // Shortest number of qualifying edges from the anchor (0 = the anchor).
  hop: number;
}

// Undirected edge in the neighborhood. `evidenceCount` drives styling weight;
// `lastSeenAtMs` drives the time-scrub (fetched once, faded client-side).
export interface BrainGraphNeighborhoodEdge {
  id: number;
  srcId: string;
  dstId: string;
  kind: BrainGraphEdgeKind;
  evidenceCount: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
}

export interface BrainGraphNeighborhoodView {
  // Resolved anchor node id (after any merged-redirect hop).
  anchorId: string;
  redirected: boolean;
  nodes: BrainGraphNeighborhoodNode[];
  edges: BrainGraphNeighborhoodEdge[];
  // True when caps or the discovery ceiling clipped the neighborhood.
  truncated: boolean;
  // Pre-cap totals: distinct reachable nodes, and edges among the shown nodes.
  totalNodes: number;
  totalEdges: number;
  appliedFilters: BrainGraphNeighborhoodFilters;
}

// Per-edge evidence read (lazy, on selection): endpoint labels + the claims
// and citations behind the edge, each citation carrying the coordinates to
// open the thread at the exact cited message.
export interface BrainGraphEdgeCitation {
  sourceMessageKey: string;
  sourceChatId: string | null;
  // Numeric chat id for the thread deep link (`/chats/:id?at=<messageId>`);
  // null when the cited chat can't be resolved. `sourceChatId` stays for
  // display/identity.
  chatId: number | null;
  messageId: number | null;
  senderSourceJid: string | null;
  timestampMs: number | null;
  // Present for claim-derived evidence; null for direct message evidence.
  claimId: string | null;
  claimKind: BrainClaimKind | null;
  claimText: string | null;
}

export interface BrainGraphEdgeEvidenceView {
  edgeId: number;
  kind: BrainGraphEdgeKind;
  src: Pick<BrainGraphNodeRecord, "id" | "kind" | "label" | "jid">;
  dst: Pick<BrainGraphNodeRecord, "id" | "kind" | "label" | "jid">;
  evidenceCount: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  citations: BrainGraphEdgeCitation[];
}

export interface BrainGraphStats {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
  nodesByKind: Partial<Record<BrainGraphNodeKind, number>>;
  nodesByStatus: Partial<Record<BrainGraphNodeStatus, number>>;
  edgesByKind: Partial<Record<BrainGraphEdgeKind, number>>;
  unresolvedPersonNodes: number;
  openLifecycleNodes: number;
  lastRecomputeAt: string | null;
}

export interface BrainGraphRebuildResult {
  episodesReplayed: number;
  nodes: number;
  edges: number;
  evidence: number;
  durationMs: number;
}

export interface BrainGraphRecomputeResult {
  nodes: number;
  dormant: number;
  revived: number;
  exemptOpenLifecycle: number;
  durationMs: number;
}

export interface BrainGraphSyncResult {
  participationEdges: number;
  vcardMentionEdges: number;
  numberChangeAliases: number;
  engagementFactors: number;
}

// --- Commitment lifecycle (commitment-tracking) ---------------------------
// Durable truth is the append-only event log keyed by the LIFECYCLE CLAIM id
// (stable across graph wipes — node ids are not); node payload status is a
// mechanical projection of the fold. Meaning lives server-side: flags,
// ordering, and labels ship in these DTOs for the UI/CLI/MCP to render.

// Folded current status of a lifecycle node. `dismissed` = not fulfilled and
// no longer active (withdrawn, made moot, or not a real/relevant item).
export type BrainLifecycleStatus = "open" | "fulfilled" | "dismissed";
// A recorded transition: terminals, a reviewed-and-still-open stamp, or a
// reopen that undoes a terminal (so any terminal is reversible).
export type BrainLifecycleTransitionStatus = "fulfilled" | "dismissed" | "still_open" | "reopened";
export type BrainLifecycleSource = "model" | "user";

export interface BrainLifecycleEventCite {
  sourceMessageKey: string;
  // The offered candidate claim whose citations include this message, when one
  // does — the claim-level "resolves" link.
  resolvingClaimId: string | null;
  timestampMs: number | null;
  // Who provided the resolving evidence: the reactor for reaction evidence,
  // the reply sender for replies, the citing message's sender for claims. The
  // `resolves` edge projects from this identity's person node.
  actorJid: string | null;
}

export interface BrainLifecycleEventRecord {
  id: number;
  claimId: string;
  toStatus: BrainLifecycleTransitionStatus;
  source: BrainLifecycleSource;
  // When the resolving evidence happened (max cite timestamp for model
  // events); createdAtMs is when the event was recorded.
  evidenceAtMs: number | null;
  note: string | null;
  runId: string | null;
  model: string | null;
  // Set when regeneration could not re-key this event onto a replacement
  // claim; orphaned events are kept for audit but excluded from folds.
  orphanedAtMs: number | null;
  createdAtMs: number;
  cites: BrainLifecycleEventCite[];
}

// Writer input — one validated transition. Model-source terminals must cite
// offered, postdating evidence; user transitions need no cites.
export interface BrainLifecycleTransitionInput {
  claimId: string;
  toStatus: BrainLifecycleTransitionStatus;
  cites?: string[];
  note?: string | null;
}

export interface BrainLifecycleApplyResult {
  applied: number;
  events: BrainLifecycleEventRecord[];
}

// A cited message resolved for display: thread coordinates for click-through
// plus a read-time sender label and bounded snippet.
export interface BrainLifecycleCiteView {
  sourceMessageKey: string;
  chatId: number | null;
  messageId: number | null;
  timestampMs: number | null;
  senderLabel: string | null;
  snippet: string | null;
}

export interface BrainLifecycleResolutionView {
  status: BrainLifecycleTransitionStatus;
  source: BrainLifecycleSource;
  atMs: number;
  note: string | null;
  model: string | null;
  cites: BrainLifecycleCiteView[];
}

// One open/closed item on the L0 surface. Open-items semantics are pinned
// STATUS-driven: every node folding open appears regardless of salience or
// dormancy, with overdue/stale flags distinct from plain open.
export interface BrainLifecycleItem {
  nodeId: string;
  slug: string;
  kind: "commitment" | "question";
  claimId: string;
  text: string;
  chatSourceId: string;
  chatDisplayName: string | null;
  holderJid: string | null;
  holderLabel: string | null;
  // The anchor: max citation timestamp of the claim that minted the node —
  // resolutions must postdate this.
  openedAtMs: number | null;
  dueMs: number | null;
  lastEvidenceAtMs: number | null;
  lastReviewedAtMs: number | null;
  status: BrainLifecycleStatus;
  overdue: boolean;
  stale: boolean;
  // Deterministic closure candidates newer than the last review (sweep fuel).
  candidateCount: number;
  salience: number;
  dormant: boolean;
  resolution: BrainLifecycleResolutionView | null;
}

export interface BrainLifecycleCounts {
  open: number;
  overdue: number;
  stale: number;
  fulfilled: number;
  dismissed: number;
  // Open nodes with unreviewed candidate evidence (or a due date passed since
  // the last review) — what a closure sweep would actually spend calls on.
  sweepDue: number;
  // Events left keyed to superseded claims that could not be re-keyed.
  orphanedEvents: number;
}

// The unified surface filter: the count chips double as filter buttons. The
// flag views (overdue/stale/sweep_due) narrow the OPEN set; fulfilled/dismissed
// are the closed views; open shows all open; all shows everything.
export type BrainLifecycleView = "open" | "overdue" | "stale" | "sweep_due" | "fulfilled" | "dismissed" | "all";

// User-selectable ordering. `smart` keeps the pinned default (overdue-first for
// open views, most-recently-resolved for closed views); the rest are explicit.
export type BrainLifecycleSort =
  | "smart"
  | "due_asc"
  | "due_desc"
  | "opened_asc"
  | "opened_desc"
  | "evidence_desc"
  | "recent_activity";

// One source group present in the current status view, with how many items it
// holds — powers the include/exclude group filter (focus / ignore groups).
export interface BrainLifecycleChatFacet {
  chatSourceId: string;
  chatDisplayName: string | null;
  count: number;
}

export interface BrainLifecycleListResponse {
  items: BrainLifecycleItem[];
  counts: BrainLifecycleCounts;
  // Groups that have items in the current status+kind scope (before flag/hide/
  // include/exclude narrowing), ranked by count — the group-filter picker.
  chatFacets: BrainLifecycleChatFacet[];
  asOfMs: number;
  staleDays: number;
}

// A candidate evidence line enriched with thread coordinates for the detail
// modal's click-through (the list DTO carries only the count).
export interface BrainLifecycleDetailCandidate extends BrainLifecycleCandidate {
  chatId: number | null;
  messageId: number | null;
}

// Full context for one lifecycle item (the detail modal): the item itself, the
// messages the commitment/question was extracted FROM (origin), all later
// evidence gathered for it, and the transition history.
export interface BrainLifecycleItemDetail {
  item: BrainLifecycleItem;
  // The claim's own citations — the conversation where it was made ("why this
  // exists"), with thread coordinates.
  origin: BrainLifecycleCiteView[];
  // Every postdating candidate (not just since-last-review), so the modal shows
  // the complete evidence picture.
  candidates: BrainLifecycleDetailCandidate[];
  // Recorded transitions (reviews, closures, reopens) newest-last.
  events: BrainLifecycleEventRecord[];
}

// One candidate evidence line for the sweep prompt (deterministic, pure SQL).
export type BrainLifecycleCandidateKind = "reaction" | "reply" | "claim";

export interface BrainLifecycleCandidate {
  kind: BrainLifecycleCandidateKind;
  sourceMessageKey: string;
  timestampMs: number | null;
  senderJid: string | null;
  senderLabel: string | null;
  // Reaction emoji, reply/message text, or the candidate claim's text.
  text: string;
  // For 'claim' candidates: the claim whose citations back this line.
  claimId: string | null;
}

// One sweep-due node with its rendered evidence, grouped per chat by the
// repository so the run loop can batch calls chat-by-chat.
export interface BrainLifecycleSweepNode {
  nodeId: string;
  claimId: string;
  kind: "commitment" | "question";
  text: string;
  holderLabel: string | null;
  openedAtMs: number | null;
  dueMs: number | null;
  candidates: BrainLifecycleCandidate[];
}

export interface BrainLifecycleSweepBatch {
  chatSourceId: string;
  chatDisplayName: string | null;
  nodes: BrainLifecycleSweepNode[];
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

// See server/import/waContacts.ts — a lightweight, read-only viewer for a
// wa.db/wa.db.crypt15 contacts sidecar, independent of a full msgstore import.
export interface WaContactRow {
  jid: string;
  lid: string | null;
  number: string | null;
  displayName: string | null;
  resolved: boolean;
}

export interface WaContactsSummary {
  table: string;
  decryptedDuringInspect: boolean;
  totalContacts: number;
  resolvedCount: number;
  unresolvedCount: number;
  contacts: WaContactRow[];
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
  | "signals"
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
