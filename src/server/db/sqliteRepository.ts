import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  BrainChatBacklogItem,
  BrainLlmUsageSummary,
  BrainRunSummary,
  BrainStatusSummary,
  BrainTaskInput,
  BrainTaskRecord,
  BrainTaskSummary,
  CapturedLinkPreview,
  ChatListItem,
  ChatListOptions,
  ChatRecord,
  ChatSyncStateRecord,
  ContactRecord,
  ImportRunSummary,
  ImportTotals,
  ImportWarning,
  LinkPreviewSummary,
  LiveChatCheckpointRecord,
  LiveEventReceiptRecord,
  LiveGapReason,
  LiveGapStatus,
  LiveGapWindowRecord,
  LiveHealthState,
  LiveMaintainerStatusSummary,
  LiveMessageUpdateRecord,
  LiveMessageUpdateResult,
  LiveSessionSummary,
  LiveSyncRunSummary,
  LiveSyncTotals,
  MediaAssetRecord,
  MediaAvailabilityState,
  MediaDownloadDescriptor,
  MediaDownloadQueueRecord,
  MediaDownloadStatus,
  MediaQueueSummary,
  MessageEditRevisionRecord,
  MessageMediaSummary,
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
  RecoveryAnchorRecord,
  RetainedPayloadRecord,
  SearchIndexState,
  SearchIndexStatus,
  SearchQueryOptions,
  SearchResponse,
  SearchResultItem,
  StatusSummary
} from "../../shared/types";
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "../../shared/types";
import { config } from "../config";
import { baselineFromStatus } from "../live/baseline";
import { messageIdFromKey, messageKey } from "../identity/keys";
import { applyMentionLabels, appliedMentionLabels, extractMentionDigits, mentionJidCandidates } from "../identity/mentions";
import { mergeInteractionMetadata } from "./interactions";
import { interpretMessage } from "../interpretation/messageInterpretation";
import { normalizeJid } from "../import/jid";
import { getMemoryProviderStatus } from "../memory/provider";
import { PublicError } from "../privacy";
import type { ArchiveRepository, ArchiveRestorePoint } from "./repository";

const TOOL_VERSION = "0.1.0";
// Bumped when identity keying changes incompatibly; archives with data written
// under an older scheme are refused (user-approved: re-import instead of migrate).
const IDENTITY_VERSION = "2";
const LEGACY_ARCHIVE_MESSAGE =
  "This archive predates canonical identity keys. Run a Clear-and-replace import of your latest backup (or delete the archive file and run init-db), then re-pair live sync.";
const SQLITE_IN_QUERY_BATCH_SIZE = 500;
const ARCHIVE_TABLES = [
  "import_runs",
  "identity_links",
  "contacts",
  "chats",
  "chat_participants",
  "messages",
  "message_mentions",
  "import_warnings",
  "live_sessions",
  "live_sync_runs",
  "live_chat_checkpoints",
  "live_gap_windows",
  "live_event_receipts",
  "live_message_updates",
  "memory_runs",
  "memory_source_windows",
  "memory_evidence_packs",
  "memory_pages",
  "memory_page_revisions",
  "memory_citations",
  "memory_validation_issues",
  "memory_job_locks",
  "brain_chat_watermarks",
  "brain_tasks",
  "brain_runs",
  "brain_llm_ledger"
] as const;
const DELETE_TABLE_ORDER = [
  "identity_links",
  "brain_llm_ledger",
  "brain_runs",
  "brain_tasks",
  "brain_chat_watermarks",
  "memory_job_locks",
  "memory_validation_issues",
  "memory_citations",
  "memory_page_revisions",
  "memory_pages",
  "memory_evidence_packs",
  "memory_source_windows",
  "memory_runs",
  "live_message_updates",
  "live_event_receipts",
  "live_gap_windows",
  "live_chat_checkpoints",
  "live_sync_runs",
  "live_sessions",
  "message_mentions",
  "messages",
  "chat_participants",
  "chats",
  "contacts",
  "import_warnings",
  "import_runs"
] as const;

const LIVE_SESSION_STATUSES = ["not_configured", "pairing", "connected", "disconnected", "stopped", "error", "logged_out"] as const;
const MESSAGE_UPDATE_TYPES = ["delete", "edit", "reaction", "poll_vote", "event_response", "receipt", "call", "unknown"] as const;

// Shared per-message media-state projection: the asset (bytes stored) and the
// download-queue row, from which every read path derives the same honest
// availability. Expects the messages table aliased as `m`.
const MEDIA_STATE_SELECT = `ma.id AS media_asset_id, ma.mime_type AS media_mime, ma.byte_size AS media_byte_size,
                ma.width AS media_width, ma.height AS media_height, ma.duration_ms AS media_duration_ms,
                ma.is_view_once AS media_asset_view_once, (ma.thumbnail IS NOT NULL) AS media_has_thumbnail,
                q.status AS media_queue_status, q.is_view_once AS media_queue_view_once`;
const MEDIA_STATE_JOINS = `LEFT JOIN media_assets ma
           ON ma.id = (SELECT id FROM media_assets pick WHERE pick.message_key = m.source_message_key ORDER BY pick.id ASC LIMIT 1)
         LEFT JOIN media_download_queue q ON q.message_key = m.source_message_key`;

// The full thread-view row projection, shared by offset paging and
// anchor-centered context windows.
function messageListSelectSql(whereClause: string, orderClause: string, limitClause: string): string {
  return `SELECT m.id, m.source_message_id,
                COALESCE(NULLIF(TRIM(COALESCE(c.display_name, '')), ''), NULLIF(TRIM(COALESCE(c.push_name, '')), ''), c.phone_number) AS sender_display_name,
                m.sender_source_jid, m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.body, m.caption,
                m.has_media, m.media_mime_type, m.media_name, m.is_deleted, m.is_forwarded, m.is_starred,
                m.source_table,
                COALESCE(json_extract(m.raw_metadata_json, '$.edited'), 0) AS edited_flag,
                (SELECT COUNT(*) FROM message_edit_revisions r WHERE r.message_key = m.source_message_key) AS edit_revision_count,
                ${MEDIA_STATE_SELECT},
                lp.title AS preview_title, lp.description AS preview_description, lp.canonical_url AS preview_url,
                (lp.thumbnail IS NOT NULL) AS preview_has_thumbnail
         FROM messages m
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         ${MEDIA_STATE_JOINS}
         LEFT JOIN message_link_previews lp ON lp.message_key = m.source_message_key
         ${whereClause}
         ${orderClause}
         ${limitClause}`;
}

interface SqliteMediaStateColumns {
  has_media: number;
  source_table: string;
  media_asset_id: number | null;
  media_mime?: string | null;
  media_byte_size?: number | null;
  media_width?: number | null;
  media_height?: number | null;
  media_duration_ms?: number | null;
  media_asset_view_once?: number | null;
  media_has_thumbnail?: number | null;
  media_queue_status: string | null;
  media_queue_view_once?: number | null;
}

// One derivation of availability for every consumer: stored beats everything;
// queued work reports its live state; otherwise the absence is explained by
// where the message came from (live → not captured while offline; backup →
// missing from the import folder).
function deriveMediaAvailability(row: SqliteMediaStateColumns): MediaAvailabilityState | null {
  if (row.media_asset_id != null) {
    return "stored";
  }
  if (!row.has_media) {
    return null;
  }
  switch (row.media_queue_status) {
    case "pending":
      return "pending";
    case "downloading":
    case "retry":
      return "downloading";
    case "failed":
    case "expired_unrecoverable":
      return "expired_unrecoverable";
  }
  return row.source_table.startsWith("wa-web") ? "not_captured" : "import_missing";
}

function deriveMediaSummary(row: SqliteMediaStateColumns, messageType: string): MessageMediaSummary | null {
  const availability = deriveMediaAvailability(row);
  if (!availability) {
    return null;
  }
  const isViewOnceType = messageType.startsWith("view_once");
  if (availability === "stored") {
    return {
      availability,
      assetId: Number(row.media_asset_id),
      mimeType: row.media_mime ?? null,
      byteSize: nullableNumber(row.media_byte_size),
      width: nullableNumber(row.media_width),
      height: nullableNumber(row.media_height),
      durationMs: nullableNumber(row.media_duration_ms),
      hasThumbnail: Boolean(row.media_has_thumbnail),
      isViewOnce: Boolean(row.media_asset_view_once) || isViewOnceType
    };
  }
  return {
    availability,
    assetId: null,
    mimeType: null,
    byteSize: null,
    width: null,
    height: null,
    durationMs: null,
    hasThumbnail: false,
    isViewOnce: Boolean(row.media_queue_view_once) || isViewOnceType
  };
}

interface SqliteMediaQueueRow {
  id: number;
  message_key: string;
  chat_source_id: string;
  source_message_id: string;
  descriptor_json: string | null;
  thumbnail: Buffer | null;
  is_view_once: number;
  status: MediaDownloadStatus;
  attempts: number;
  reupload_attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  priority: number;
}

function rowToMediaQueueRecord(row: SqliteMediaQueueRow): MediaDownloadQueueRecord | null {
  if (!row.descriptor_json) {
    return null;
  }
  return {
    id: Number(row.id),
    messageKey: row.message_key,
    chatSourceId: row.chat_source_id,
    sourceMessageId: row.source_message_id,
    descriptor: JSON.parse(row.descriptor_json) as MediaDownloadDescriptor,
    thumbnail: row.thumbnail ?? null,
    isViewOnce: Boolean(row.is_view_once),
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    reuploadAttempts: Number(row.reupload_attempts ?? 0),
    nextAttemptAtMs: nullableNumber(row.next_attempt_at_ms),
    lastError: row.last_error,
    priority: Number(row.priority ?? 0)
  };
}

interface SqliteMediaAssetRow {
  id: number;
  message_key: string;
  chat_source_id: string;
  sha256: string;
  storage_path: string;
  mime_type: string | null;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbnail: Buffer | null;
  source: MediaAssetRecord["source"];
  is_view_once: number;
  created_at: string;
}

function rowToMediaAsset(row: SqliteMediaAssetRow): MediaAssetRecord {
  return {
    id: Number(row.id),
    messageKey: row.message_key,
    chatSourceId: row.chat_source_id,
    sha256: row.sha256,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    durationMs: nullableNumber(row.duration_ms),
    thumbnail: row.thumbnail ?? null,
    source: row.source,
    isViewOnce: Boolean(row.is_view_once),
    createdAt: row.created_at
  };
}

function liveMessageUpdatesTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    event_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    update_type TEXT NOT NULL CHECK (update_type IN (${MESSAGE_UPDATE_TYPES.map((type) => `'${type}'`).join(",")})),
    occurred_at_ms INTEGER NULL,
    applied INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
}

function liveSessionsTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (${LIVE_SESSION_STATUSES.map((status) => `'${status}'`).join(",")})),
    client_name TEXT NOT NULL,
    linked_device_jid TEXT NULL,
    last_connected_at TEXT NULL,
    last_disconnected_at TEXT NULL,
    last_error TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS identity_links (
    lid TEXT PRIMARY KEY,
    pn TEXT NOT NULL,
    source TEXT NULL,
    learned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS import_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    tool_version TEXT NOT NULL,
    source_summary_json TEXT NULL,
    totals_json TEXT NULL,
    warning_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS import_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_run_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
    code TEXT NOT NULL,
    entity_type TEXT NULL,
    source_table TEXT NULL,
    source_row_id TEXT NULL,
    message TEXT NOT NULL,
    context_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (import_run_id) REFERENCES import_runs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_jid TEXT NOT NULL UNIQUE,
    phone_number TEXT NULL,
    display_name TEXT NULL,
    push_name TEXT NULL,
    raw_metadata_json TEXT NULL,
    first_seen_import_id TEXT NULL,
    last_seen_import_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_chat_id TEXT NOT NULL UNIQUE,
    jid TEXT NOT NULL,
    display_name TEXT NULL,
    chat_type TEXT NOT NULL DEFAULT 'unknown' CHECK (chat_type IN ('dm','group','community','broadcast','status','unknown')),
    message_count INTEGER NOT NULL DEFAULT 0,
    participant_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT NULL,
    last_message_at_ms INTEGER NULL,
    platform_recency_ms INTEGER NULL,
    raw_metadata_json TEXT NULL,
    first_seen_import_id TEXT NULL,
    last_seen_import_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id INTEGER NOT NULL,
    source_jid TEXT NOT NULL,
    contact_id INTEGER NULL,
    display_name TEXT NULL,
    first_seen_at_ms INTEGER NULL,
    last_seen_at_ms INTEGER NULL,
    membership_source TEXT NOT NULL DEFAULT 'inferred' CHECK (membership_source IN ('source','inferred')),
    raw_metadata_json TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (chat_id, source_jid),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_message_key TEXT NOT NULL UNIQUE,
    source_message_id TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_row_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    sender_contact_id INTEGER NULL,
    sender_source_jid TEXT NULL,
    timestamp_ms INTEGER NULL,
    sent_at TEXT NULL,
    direction TEXT NOT NULL DEFAULT 'unknown' CHECK (direction IN ('incoming','outgoing','system','unknown')),
    from_me INTEGER NULL,
    message_type TEXT NOT NULL DEFAULT 'unknown',
    raw_type_code TEXT NULL,
    body TEXT NULL,
    caption TEXT NULL,
    has_media INTEGER NOT NULL DEFAULT 0,
    media_mime_type TEXT NULL,
    media_name TEXT NULL,
    quoted_source_message_id TEXT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    is_forwarded INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    raw_metadata_json TEXT NULL,
    -- Derived search text: body/caption with mentions swapped for display
    -- names, plus media file name and sender label. Recomputed by write paths
    -- and the reindex job; stored raw content is never touched.
    resolved_text TEXT NULL,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  )`,

  // Canonicalized mentioned identities per message (identity-aware inference):
  // explicit transport mentions unioned with text-token "@digits" mentions.
  `CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL,
    mentioned_jid TEXT NOT NULL,
    PRIMARY KEY (message_id, mentioned_jid),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,

  liveSessionsTableDdl("live_sessions"),

  `CREATE TABLE IF NOT EXISTS live_sync_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    client_name TEXT NOT NULL,
    source_summary_json TEXT NULL,
    totals_json TEXT NULL,
    warning_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS live_chat_checkpoints (
    chat_source_id TEXT PRIMARY KEY,
    chat_id INTEGER NULL,
    latest_archived_message_key TEXT NULL,
    latest_archived_at_ms INTEGER NULL,
    earliest_archived_message_key TEXT NULL,
    earliest_archived_at_ms INTEGER NULL,
    latest_live_message_key TEXT NULL,
    latest_live_at_ms INTEGER NULL,
    oldest_verified_message_key TEXT NULL,
    oldest_verified_at_ms INTEGER NULL,
    health TEXT NOT NULL CHECK (health IN ('healthy','catching_up','uncertain','disconnected','needs_user_action')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_recovery_at TEXT NULL,
    last_audit_at TEXT NULL,
    raw_metadata_json TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS live_gap_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_source_id TEXT NOT NULL,
    chat_id INTEGER NULL,
    reason TEXT NOT NULL CHECK (reason IN ('late_start','disconnect','watermark_mismatch','history_sync_stalled','manual_retry')),
    status TEXT NOT NULL CHECK (status IN ('open','retrying','closed','uncertain','needs_user_action')),
    start_at_ms INTEGER NULL,
    end_at_ms INTEGER NULL,
    required_lower_bound_at_ms INTEGER NULL,
    anchor_message_key TEXT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
    notes TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS live_event_receipts (
    event_key TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    chat_source_id TEXT NULL,
    message_key TEXT NULL,
    occurred_at_ms INTEGER NULL,
    processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    metadata_json TEXT NULL
  )`,

  liveMessageUpdatesTableDdl("live_message_updates"),

  `CREATE TABLE IF NOT EXISTS message_secrets (
    message_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    secret BLOB NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('live','backup')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS retained_encrypted_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    target_message_key TEXT NOT NULL,
    chat_source_id TEXT NOT NULL,
    target_message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('poll_vote','event_response','secret_encrypted')),
    actor_jid TEXT NULL,
    enc_payload BLOB NOT NULL,
    enc_iv BLOB NULL,
    occurred_at_ms INTEGER NULL,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_retained_payloads_target ON retained_encrypted_payloads (target_message_key)`,

  // Message→asset linkage with provenance. One row per (message, content
  // hash); identical media across messages shares the blob (and may share the
  // hash across rows) — the blob store is the dedupe layer. Retained across
  // deletes/revokes and across clear-and-replace: rows re-attach to re-imported
  // messages through the canonical message key.
  `CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL,
    chat_source_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER NULL,
    height INTEGER NULL,
    duration_ms INTEGER NULL,
    thumbnail BLOB NULL,
    source TEXT NOT NULL CHECK (source IN ('live-download','media-retry','import-folder')),
    is_view_once INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (message_key, sha256)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_media_assets_message ON media_assets (message_key)`,
  `CREATE INDEX IF NOT EXISTS idx_media_assets_sha ON media_assets (sha256)`,

  // Durable media download work: the captured descriptor lives here (never on
  // the messages table) until the asset is stored, then it is dropped.
  `CREATE TABLE IF NOT EXISTS media_download_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL UNIQUE,
    chat_source_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    descriptor_json TEXT NULL,
    thumbnail BLOB NULL,
    is_view_once INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending','downloading','stored','retry','expired_unrecoverable','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    reupload_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NULL,
    last_error TEXT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_media_queue_due ON media_download_queue (status, priority DESC, next_attempt_at_ms)`,

  // Sender-embedded link previews captured with live text messages; thumbnail
  // bytes are embedded message content, never fetched from the link target.
  `CREATE TABLE IF NOT EXISTS message_link_previews (
    message_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    title TEXT NULL,
    description TEXT NULL,
    canonical_url TEXT NULL,
    thumbnail BLOB NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Prior versions of live-edited messages, snapshotted before each edit
  // overwrites content. Backup imports never fabricate rows here.
  `CREATE TABLE IF NOT EXISTS message_edit_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL,
    revision_index INTEGER NOT NULL,
    body TEXT NULL,
    caption TEXT NULL,
    edited_at_ms INTEGER NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (message_key, revision_index)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_edit_revisions_message ON message_edit_revisions (message_key, revision_index)`,

  `CREATE TABLE IF NOT EXISTS memory_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','blocked')),
    kind TEXT NOT NULL CHECK (kind IN ('rem','manual','rebuild','validate')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    source_start_at_ms INTEGER NULL,
    source_end_at_ms INTEGER NULL,
    source_summary_json TEXT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    citation_count INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS memory_source_windows (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','committed','skipped','stale')),
    start_at_ms INTEGER NULL,
    end_at_ms INTEGER NULL,
    chat_source_ids_json TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT NOT NULL UNIQUE,
    committed_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_evidence_packs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared','generated','validated','failed')),
    sequence INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    citation_labels_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (window_id) REFERENCES memory_source_windows(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_pages (
    page_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    page_path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current','stale')),
    current_revision_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS memory_page_revisions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    title TEXT NOT NULL,
    page_path TEXT NOT NULL,
    summary TEXT NOT NULL,
    markdown TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('current','superseded','stale')),
    source_start_at_ms INTEGER NULL,
    source_end_at_ms INTEGER NULL,
    citation_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (window_id) REFERENCES memory_source_windows(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revision_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    citation_label TEXT NOT NULL,
    message_id INTEGER NULL,
    source_message_key TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_chat_id TEXT NOT NULL,
    sender_source_jid TEXT NULL,
    timestamp_ms INTEGER NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (revision_id) REFERENCES memory_page_revisions(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_validation_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    pack_id TEXT NULL,
    page_id TEXT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('warning','error')),
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    context_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (run_id) REFERENCES memory_runs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS memory_job_locks (
    name TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,

  // --- Brain substrate (tiered assimilation) ---
  // Coverage truth: per-chat watermark advanced only when an episode commits.
  // Pending work is always DERIVED from messages newer than the watermark —
  // no stored counter that can drift from reality.
  `CREATE TABLE IF NOT EXISTS brain_chat_watermarks (
    chat_source_id TEXT PRIMARY KEY,
    assimilated_through_ms INTEGER NOT NULL DEFAULT 0,
    last_episode_at TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Durable work queue (cloned from media_download_queue semantics): unique
  // dedupe keys make enqueues idempotent; claim/backoff/priority make
  // interruption free — the next tick re-claims stale work.
  `CREATE TABLE IF NOT EXISTS brain_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('episode','rollup','overview','merge_adjudicate','reindex','project_pages')),
    chat_source_id TEXT NULL,
    payload_json TEXT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NULL,
    claimed_at_ms INTEGER NULL,
    last_error TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS brain_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('nightly','catchup','manual','backfill')),
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted','budget_exceeded')),
    started_at TEXT NOT NULL,
    finished_at TEXT NULL,
    timezone TEXT NULL,
    totals_json TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Every model call's cost, by UTC day and purpose: budgets are enforced
  // from this ledger as hard named blocks, never silent degradation.
  `CREATE TABLE IF NOT EXISTS brain_llm_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    at_ms INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_import_warnings_run ON import_warnings (import_run_id, severity, code)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone_number)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats (last_message_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_type ON chats (chat_type)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_contact ON chat_participants (contact_id, chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp_ms, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_jid ON messages (sender_source_jid)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_source_jid ON chat_participants (source_jid)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages (chat_id, sender_contact_id, timestamp_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_type_time ON messages (message_type, timestamp_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_live_runs_status ON live_sync_runs (status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_live_gap_status ON live_gap_windows (status, chat_source_id, end_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_live_receipts_chat ON live_event_receipts (chat_source_id, occurred_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_live_updates_pending ON live_message_updates (applied, chat_source_id, occurred_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_runs_status ON memory_runs (status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_windows_hash ON memory_source_windows (source_hash, status)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_windows_end ON memory_source_windows (status, end_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_revisions_page ON memory_page_revisions (page_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_citations_message ON memory_citations (source_message_key, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_issues_run ON memory_validation_issues (run_id, severity, code)`,
  `CREATE INDEX IF NOT EXISTS idx_message_mentions_jid ON message_mentions (mentioned_jid, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_tasks_due ON brain_tasks (status, next_attempt_at_ms, priority, id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_ledger_day ON brain_llm_ledger (day, purpose)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_runs_status ON brain_runs (status, started_at)`
];

// Full-text search over messages (brain hot tier): a content-storing FTS5
// table kept in sync by rowid-keyed triggers, so every write path — imports,
// live ingest, edits, tombstones, merges, collapses — maintains the index
// without call-site code. Deliberately NOT external-content: external-content
// deletes must replay the exact previously-indexed values, and any mismatch
// (e.g. rows that predate the index) corrupts the FTS shadow tables — observed
// as "database disk image is malformed" on a real archive. Rowid-keyed deletes
// on a content-storing table are no-ops when the row is absent, which makes
// the triggers safe in every index state, at the cost of duplicating message
// text inside the private archive file. Created after additive column
// migration because the triggers reference messages.resolved_text.
const searchSchemaStatements = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    resolved_text, body, caption,
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  )`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = new.id;
    INSERT INTO messages_fts(rowid, resolved_text, body, caption)
    VALUES (new.id, new.resolved_text, new.body, new.caption);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF resolved_text, body, caption ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = new.id;
    INSERT INTO messages_fts(rowid, resolved_text, body, caption)
    VALUES (new.id, new.resolved_text, new.body, new.caption);
  END`
];

export function initializeSqliteArchive(dbPath = config.archive.sqlitePath): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    configureDatabase(db);
    ensureSchema(db);
  } finally {
    db.close();
  }
}

export function isSqliteArchiveInitialized(dbPath = config.archive.sqlitePath): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'table' AND name IN ('import_runs', 'contacts', 'chats', 'messages')`
      )
      .get() as { count: number };
    return Number(rows.count ?? 0) >= 4;
  } finally {
    db.close();
  }
}

export class SqliteArchiveRepository implements ArchiveRepository {
  private readonly db: Database.Database;
  private legacyArchive = false;
  private readonly identityLinks = new Map<string, string>();
  private cachedFtsState: SearchIndexState | null = null;

  constructor(private readonly dbPath = config.archive.sqlitePath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureDatabase(this.db);
    ensureSchema(this.db);
    this.initializeIdentityState();
  }

  private initializeIdentityState(): void {
    const stored = (this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'identity_version'`).get() as { value: string } | undefined)?.value;
    if (stored === IDENTITY_VERSION) {
      this.legacyArchive = false;
    } else {
      const messageCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
      if (messageCount === 0) {
        this.stampIdentityVersion();
      } else {
        this.legacyArchive = true;
      }
    }
    this.identityLinks.clear();
    const rows = this.db.prepare(`SELECT lid, pn FROM identity_links`).all() as Array<{ lid: string; pn: string }>;
    for (const row of rows) {
      this.identityLinks.set(row.lid, row.pn);
    }
  }

  private stampIdentityVersion(): void {
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ('identity_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(IDENTITY_VERSION, currentIso());
    this.legacyArchive = false;
  }

  private assertWritableIdentityVersion(): void {
    if (this.legacyArchive) {
      throw new PublicError("ARCHIVE_LEGACY_IDENTITY", LEGACY_ARCHIVE_MESSAGE);
    }
  }

  // Canonical form for any JID: normalized, then LID mapped to its phone form
  // when a persisted link exists. Every write path funnels through this.
  private canonicalJid(jid: string | null | undefined): string | null {
    const normalized = normalizeJid(jid);
    if (!normalized) {
      return null;
    }
    return this.identityLinks.get(normalized) ?? normalized;
  }

  async resolveIdentityJid(jid: string): Promise<string> {
    return this.canonicalJid(jid) ?? jid;
  }

  async getIdentityLidsForJid(jid: string): Promise<string[]> {
    const normalized = normalizeJid(jid);
    if (!normalized) {
      return [];
    }
    if (isLidFormJid(normalized)) {
      return [normalized];
    }
    const rows = this.db.prepare(`SELECT lid FROM identity_links WHERE pn = ?`).all(normalized) as Array<{ lid: string }>;
    return rows.map((row) => row.lid);
  }

  async recordIdentityLinks(links: Array<{ lid: string; pn: string; source?: string | null }>): Promise<string[]> {
    const insert = this.db.prepare(
      `INSERT INTO identity_links (lid, pn, source, learned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(lid) DO NOTHING`
    );
    const learned: string[] = [];
    for (const link of links) {
      const lid = normalizeJid(link.lid);
      const pn = normalizeJid(link.pn);
      // Links are irrevocable (first write wins) and trigger destructive merges;
      // both sides must be strictly well-formed.
      if (!lid || !pn || lid === pn || !isLidFormJid(lid) || !pn.endsWith("@s.whatsapp.net")) {
        continue;
      }
      const result = insert.run(lid, pn, link.source ?? null, currentIso());
      if (result.changes > 0) {
        this.identityLinks.set(lid, pn);
        learned.push(lid);
      }
    }
    return learned;
  }

  // Identity health scans distinct senders across the whole archive; the UI
  // polls status on every archive change, so cache with a short TTL to keep
  // heavy sync periods responsive (health is advisory, not transactional).
  private identityHealthCache: { atMs: number; value: { unnamedGroups: number; unresolvedLids: number; samples: string[] } } | null = null;

  private async getIdentityHealth(): Promise<{ unnamedGroups: number; unresolvedLids: number; samples: string[] }> {
    const now = Date.now();
    if (this.identityHealthCache && now - this.identityHealthCache.atMs < 15_000) {
      return this.identityHealthCache.value;
    }
    const samples = await this.listUnnamedGroupChats(5);
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM chats WHERE chat_type = 'group' AND (display_name IS NULL OR TRIM(display_name) = '' OR display_name = jid)) AS unnamed_groups,
          (SELECT COUNT(*) FROM (
             SELECT source_chat_id AS j FROM chats WHERE source_chat_id LIKE '%@lid' OR source_chat_id LIKE '%@hosted.lid'
             UNION
             SELECT jid AS j FROM (SELECT DISTINCT sender_source_jid AS jid FROM messages WHERE sender_source_jid IS NOT NULL)
             WHERE jid LIKE '%@lid' OR jid LIKE '%@hosted.lid'
           ) WHERE j NOT IN (SELECT lid FROM identity_links)) AS unresolved_lids`
      )
      .get() as { unnamed_groups: number; unresolved_lids: number };
    const value = {
      unnamedGroups: Number(counts.unnamed_groups ?? 0),
      unresolvedLids: Number(counts.unresolved_lids ?? 0),
      samples
    };
    this.identityHealthCache = { atMs: now, value };
    return value;
  }

  // Display-time mention resolution: digits → phone/LID candidates → canonical
  // identity → contact display chain. Unresolved tokens stay unchanged.
  private resolveMentionLabels(texts: Array<string | null>): Map<string, string> {
    const digitsSet = extractMentionDigits(texts);
    if (digitsSet.size === 0) {
      return new Map();
    }
    const digitsByJid = new Map<string, string>();
    for (const digits of digitsSet) {
      for (const candidate of mentionJidCandidates(digits)) {
        const canonical = this.canonicalJid(candidate) ?? candidate;
        if (!digitsByJid.has(canonical)) {
          digitsByJid.set(canonical, digits);
        }
      }
    }
    const jids = [...digitsByJid.keys()];
    const labels = new Map<string, string>();
    for (let index = 0; index < jids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = jids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(
          `SELECT source_jid,
                  COALESCE(NULLIF(TRIM(COALESCE(display_name, '')), ''), NULLIF(TRIM(COALESCE(push_name, '')), ''), phone_number) AS label
           FROM contacts
           WHERE source_jid IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch) as Array<{ source_jid: string; label: string | null }>;
      for (const row of rows) {
        const digits = digitsByJid.get(row.source_jid);
        if (digits && row.label && !labels.has(digits)) {
          labels.set(digits, row.label);
        }
      }
    }
    return labels;
  }

  // Write-time mention resolution: digits → the canonical identity the mention
  // most plausibly refers to. A candidate that is a known contact wins;
  // otherwise the phone-form candidate stands in until identity links improve.
  private resolveMentionJids(texts: Array<string | null>): Map<string, string> {
    const digitsSet = extractMentionDigits(texts);
    if (digitsSet.size === 0) {
      return new Map();
    }
    const candidatesByDigits = new Map<string, string[]>();
    const allJids = new Set<string>();
    for (const digits of digitsSet) {
      const canonicals = [...new Set(mentionJidCandidates(digits).map((candidate) => this.canonicalJid(candidate) ?? candidate))];
      candidatesByDigits.set(digits, canonicals);
      for (const jid of canonicals) {
        allJids.add(jid);
      }
    }
    const known = new Set<string>();
    const jids = [...allJids];
    for (let index = 0; index < jids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = jids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(`SELECT source_jid FROM contacts WHERE source_jid IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as Array<{ source_jid: string }>;
      for (const row of rows) {
        known.add(row.source_jid);
      }
    }
    const resolved = new Map<string, string>();
    for (const [digits, canonicals] of candidatesByDigits) {
      const hit = canonicals.find((jid) => known.has(jid));
      resolved.set(digits, hit ?? canonicals[0]);
    }
    return resolved;
  }

  // Contact display chain (saved name → push name → phone) for a JID batch.
  private resolveContactLabels(jids: string[]): Map<string, string> {
    const labels = new Map<string, string>();
    const unique = [...new Set(jids)].filter(Boolean);
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      const rows = this.db
        .prepare(
          `SELECT source_jid,
                  COALESCE(NULLIF(TRIM(COALESCE(display_name, '')), ''), NULLIF(TRIM(COALESCE(push_name, '')), ''), phone_number) AS label
           FROM contacts
           WHERE source_jid IN (${batch.map(() => "?").join(",")})`
        )
        .all(...batch) as Array<{ source_jid: string; label: string | null }>;
      for (const row of rows) {
        if (row.label) {
          labels.set(row.source_jid, row.label);
        }
      }
    }
    return labels;
  }

  // Recompute derived search state (resolved_text + message_mentions) for a
  // set of messages from their FINAL stored content. Runs inside the caller's
  // transaction; FTS follows via the update trigger. Rows whose derived state
  // is already correct are left untouched (no index churn).
  private syncMessageDerivedState(messageIds: number[], explicitMentionsById?: Map<number, string[]>): void {
    if (messageIds.length === 0) {
      return;
    }
    const rows: Array<{
      id: number;
      body: string | null;
      caption: string | null;
      media_name: string | null;
      sender_source_jid: string | null;
      resolved_text: string | null;
    }> = [];
    const unique = [...new Set(messageIds)];
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const batch = unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      rows.push(
        ...(this.db
          .prepare(
            `SELECT id, body, caption, media_name, sender_source_jid, resolved_text
             FROM messages WHERE id IN (${batch.map(() => "?").join(",")})`
          )
          .all(...batch) as typeof rows)
      );
    }
    const texts = rows.flatMap((row) => [row.body, row.caption]);
    const mentionLabels = this.resolveMentionLabels(texts);
    const mentionJids = this.resolveMentionJids(texts);
    const senderLabels = this.resolveContactLabels(
      rows.map((row) => row.sender_source_jid).filter((jid): jid is string => Boolean(jid))
    );
    const updateResolved = this.db.prepare(`UPDATE messages SET resolved_text = ? WHERE id = ?`);
    const selectMentions = this.db.prepare(`SELECT mentioned_jid FROM message_mentions WHERE message_id = ?`);
    const deleteMentions = this.db.prepare(`DELETE FROM message_mentions WHERE message_id = ?`);
    const insertMention = this.db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, mentioned_jid) VALUES (?, ?)`);
    for (const row of rows) {
      const senderLabel = row.sender_source_jid
        ? senderLabels.get(row.sender_source_jid) ?? displayPhoneFromJid(row.sender_source_jid)
        : null;
      const resolved = composeResolvedText(row.body, row.caption, row.media_name, senderLabel, mentionLabels);
      if ((resolved ?? null) !== (row.resolved_text ?? null)) {
        updateResolved.run(resolved, row.id);
      }
      const desired = new Set<string>(explicitMentionsById?.get(row.id) ?? []);
      for (const digits of extractMentionDigits([row.body, row.caption])) {
        const jid = mentionJids.get(digits);
        if (jid) {
          desired.add(jid);
        }
      }
      const existing = (selectMentions.all(row.id) as Array<{ mentioned_jid: string }>).map((mention) => mention.mentioned_jid);
      if (existing.length !== desired.size || existing.some((jid) => !desired.has(jid))) {
        deleteMentions.run(row.id);
        for (const jid of desired) {
          insertMention.run(row.id, jid);
        }
      }
    }
  }

  private getFtsState(): SearchIndexState {
    if (this.cachedFtsState === null) {
      const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'fts_state'`).get() as { value: string } | undefined;
      this.cachedFtsState = row?.value === "ready" ? "ready" : "needs_rebuild";
    }
    return this.cachedFtsState;
  }

  private setFtsState(state: SearchIndexState): void {
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES ('fts_state', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(state, currentIso());
    this.cachedFtsState = state;
  }

  async getSearchIndexStatus(): Promise<SearchIndexStatus> {
    const totals = this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number };
    return { state: this.getFtsState(), totalMessages: Number(totals.count ?? 0) };
  }

  async searchMessages(options: SearchQueryOptions): Promise<SearchResponse> {
    const index = await this.getSearchIndexStatus();
    if (index.state !== "ready") {
      throw new PublicError(
        "SEARCH_INDEX_NOT_BUILT",
        "The search index has not been built for this archive yet. Run the search reindex to enable global search."
      );
    }
    const match = buildFtsMatchQuery(options.query);
    if (!match) {
      return { index, totalMatches: 0, results: [] };
    }
    const where = ["messages_fts MATCH ?"];
    const params: unknown[] = [match];
    if (options.chatId != null) {
      where.push("m.chat_id = ?");
      params.push(options.chatId);
    }
    if (options.sender) {
      const sender = options.sender.trim();
      if (sender.includes("@")) {
        where.push("m.sender_source_jid = ?");
        params.push(this.canonicalJid(sender) ?? sender);
      } else {
        where.push("(c.display_name LIKE ? OR c.push_name LIKE ? OR c.phone_number LIKE ?)");
        params.push(`%${sender}%`, `%${sender}%`, `%${sender.replace(/\D/g, "") || sender}%`);
      }
    }
    if (options.afterMs != null) {
      where.push("m.timestamp_ms >= ?");
      params.push(options.afterMs);
    }
    if (options.beforeMs != null) {
      where.push("m.timestamp_ms <= ?");
      params.push(options.beforeMs);
    }
    if (options.type === "text") {
      where.push("m.has_media = 0 AND m.message_type <> 'call'");
    } else if (options.type === "media") {
      where.push("(m.has_media = 1 OR m.message_type IN ('image','video','audio','document','sticker','view_once','ptv'))");
    } else if (options.type === "call") {
      where.push("m.message_type = 'call'");
    }
    if (options.direction) {
      where.push("m.direction = ?");
      params.push(options.direction);
    }
    if (!options.includeNoise) {
      where.push(visibleExchangePredicate("m"));
    }
    // Exact archive-wide match count (same predicate, no ranking work).
    const totalMatches = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             JOIN chats ch ON ch.id = m.chat_id
             LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
             WHERE ${where.join(" AND ")}`
          )
          .get(...params) as { count: number }
      ).count ?? 0
    );
    // Candidate pool: top matches by BM25, reranked in JS with recency decay.
    // Deterministic paging inside the pool; offsets beyond it return empty.
    const rows = this.db
      .prepare(
        `SELECT m.id, m.source_message_key, m.source_message_id, m.chat_id, m.sender_source_jid,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.is_deleted, m.has_media, m.body,
                ch.source_chat_id AS chat_source_id, ch.display_name AS chat_display_name, ch.chat_type,
                COALESCE(NULLIF(TRIM(COALESCE(c.display_name, '')), ''), NULLIF(TRIM(COALESCE(c.push_name, '')), ''), c.phone_number) AS sender_display_name,
                bm25(messages_fts, 3.0, 2.0, 1.0) AS rank,
                snippet(messages_fts, 0, ?, ?, '…', 14) AS snip_resolved,
                snippet(messages_fts, 1, ?, ?, '…', 14) AS snip_body,
                snippet(messages_fts, 2, ?, ?, '…', 14) AS snip_caption
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN chats ch ON ch.id = m.chat_id
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         WHERE ${where.join(" AND ")}
         ORDER BY rank
         LIMIT ${SEARCH_CANDIDATE_POOL}`
      )
      .all(
        SEARCH_HIGHLIGHT_START,
        SEARCH_HIGHLIGHT_END,
        SEARCH_HIGHLIGHT_START,
        SEARCH_HIGHLIGHT_END,
        SEARCH_HIGHLIGHT_START,
        SEARCH_HIGHLIGHT_END,
        ...params
      ) as SqliteSearchRow[];
    const nowMs = Date.now();
    const mentionLabels = this.resolveMentionLabels(rows.map((row) => row.body));
    const scored = rows.map((row) => {
      // FTS5 bm25() is negative for matches; smaller = better.
      const relevance = Math.max(0, -Number(row.rank));
      const ageDays = row.timestamp_ms != null ? Math.max(0, (nowMs - Number(row.timestamp_ms)) / 86_400_000) : 365;
      const recency = 0.2 + 0.8 * Math.pow(0.5, ageDays / 90);
      const snippetRaw = pickSnippet(row);
      return {
        item: {
          layer: "message" as const,
          messageId: Number(row.id),
          sourceMessageKey: row.source_message_key,
          sourceMessageId: row.source_message_id,
          chatId: Number(row.chat_id),
          chatSourceId: row.chat_source_id,
          chatDisplayName:
            row.chat_display_name && row.chat_display_name !== row.chat_source_id
              ? row.chat_display_name
              : displayPhoneFromJid(row.chat_source_id),
          chatType: row.chat_type as SearchResultItem["chatType"],
          senderDisplayName: row.sender_display_name ?? displayPhoneFromJid(row.sender_source_jid),
          senderSourceJid: row.sender_source_jid,
          timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
          sentAt: row.sent_at,
          direction: row.direction as SearchResultItem["direction"],
          messageType: row.message_type,
          interpretation: interpretMessage({
            messageType: row.message_type,
            isDeleted: Boolean(row.is_deleted),
            hasHeldContent: Boolean(row.body?.trim() || row.has_media),
            mediaAvailability: null
          }),
          snippet: applyMentionLabels(snippetRaw, mentionLabels) ?? snippetRaw,
          score: relevance * recency,
          hasMedia: Boolean(row.has_media),
          isDeleted: Boolean(row.is_deleted)
        },
        score: relevance * recency
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(options.offset, options.offset + options.limit).map((entry) => entry.item);
    return { index, totalMatches, results };
  }

  async rebuildSearchIndex(onProgress?: (processedMessages: number, totalMessages: number) => void): Promise<{ indexedMessages: number }> {
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
    onProgress?.(0, total);
    // Honest state while the index is incomplete; searches refuse instead of
    // answering from a half-built index.
    this.setFtsState("needs_rebuild");
    // Start from a fresh table: erases any prior index state wholesale,
    // including shadow-table corruption left by the retired external-content
    // design. Triggers keep rows written during the rebuild indexed (rowid-
    // keyed writes are safe in any state), and the ascending id cursor
    // re-covers them idempotently.
    this.db.exec(
      `DROP TABLE IF EXISTS messages_fts;
       ${searchSchemaStatements[0]}`
    );
    let processed = 0;
    let lastId = 0;
    const pageStmt = this.db.prepare(`SELECT id FROM messages WHERE id > ? ORDER BY id LIMIT ${SEARCH_REINDEX_CHUNK}`);
    for (;;) {
      const ids = (pageStmt.all(lastId) as Array<{ id: number }>).map((row) => Number(row.id));
      if (ids.length === 0) {
        break;
      }
      this.db.transaction(() => {
        this.syncMessageDerivedState(ids);
        for (let index = 0; index < ids.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
          const batch = ids.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM messages_fts WHERE rowid IN (${placeholders})`).run(...batch);
          this.db
            .prepare(
              `INSERT INTO messages_fts(rowid, resolved_text, body, caption)
               SELECT id, resolved_text, body, caption FROM messages WHERE id IN (${placeholders})`
            )
            .run(...batch);
        }
      })();
      processed += ids.length;
      lastId = ids[ids.length - 1];
      onProgress?.(Math.min(processed, total), total);
      // Yield between chunks so live ingestion and HTTP stay responsive.
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.setFtsState("ready");
    onProgress?.(total, total);
    return { indexedMessages: total };
  }

  // --- Brain substrate ---

  async getBrainChatBacklog(options: { limit: number; minPending?: number }): Promise<BrainChatBacklogItem[]> {
    const rows = this.db
      .prepare(
        `SELECT ch.source_chat_id AS chat_source_id,
                COALESCE(NULLIF(TRIM(COALESCE(ch.display_name, '')), ''), NULL) AS chat_display_name,
                COALESCE(w.assimilated_through_ms, 0) AS assimilated_through_ms,
                w.last_episode_at AS last_episode_at,
                COUNT(m.id) AS pending,
                MAX(m.timestamp_ms) AS newest_ms
         FROM chats ch
         LEFT JOIN brain_chat_watermarks w ON w.chat_source_id = ch.source_chat_id
         JOIN messages m ON m.chat_id = ch.id
         WHERE COALESCE(m.timestamp_ms, 0) > COALESCE(w.assimilated_through_ms, 0)
           AND ${visibleExchangePredicate("m")}
         GROUP BY ch.id
         HAVING COUNT(m.id) >= ?
         ORDER BY pending DESC
         LIMIT ?`
      )
      .all(Math.max(1, options.minPending ?? 1), options.limit) as Array<{
      chat_source_id: string;
      chat_display_name: string | null;
      assimilated_through_ms: number;
      last_episode_at: string | null;
      pending: number;
      newest_ms: number | null;
    }>;
    return rows.map((row) => ({
      chatSourceId: row.chat_source_id,
      chatDisplayName: row.chat_display_name,
      assimilatedThroughMs: Number(row.assimilated_through_ms ?? 0),
      lastEpisodeAt: row.last_episode_at,
      pendingVisibleMessages: Number(row.pending),
      newestVisibleMs: row.newest_ms == null ? null : Number(row.newest_ms)
    }));
  }

  // Watermarks never regress: a replayed commit can only move coverage forward.
  async advanceBrainWatermark(chatSourceId: string, throughMs: number): Promise<void> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    this.db
      .prepare(
        `INSERT INTO brain_chat_watermarks (chat_source_id, assimilated_through_ms, last_episode_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_source_id) DO UPDATE SET
           assimilated_through_ms = MAX(brain_chat_watermarks.assimilated_through_ms, excluded.assimilated_through_ms),
           last_episode_at = excluded.last_episode_at,
           updated_at = excluded.updated_at`
      )
      .run(canonical, throughMs, currentIso(), currentIso());
  }

  async enqueueBrainTasks(tasks: BrainTaskInput[]): Promise<number> {
    if (tasks.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO brain_tasks (kind, chat_source_id, payload_json, dedupe_key, priority)
       VALUES (?, ?, ?, ?, ?)`
    );
    let enqueued = 0;
    const transaction = this.db.transaction(() => {
      for (const task of tasks) {
        const result = insert.run(task.kind, task.chatSourceId ?? null, stringifyJson(task.payload ?? null), task.dedupeKey, task.priority ?? 0);
        enqueued += result.changes;
      }
    });
    transaction();
    return enqueued;
  }

  async claimDueBrainTasks(limit: number, nowMs = Date.now()): Promise<BrainTaskRecord[]> {
    const claimed: BrainTaskRecord[] = [];
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, kind, chat_source_id, payload_json, dedupe_key, status, priority, attempts, next_attempt_at_ms, last_error
           FROM brain_tasks
           WHERE status = 'pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
           ORDER BY priority DESC, id ASC
           LIMIT ?`
        )
        .all(nowMs, limit) as SqliteBrainTaskRow[];
      const claim = this.db.prepare(`UPDATE brain_tasks SET status = 'running', claimed_at_ms = ?, updated_at = ? WHERE id = ?`);
      for (const row of rows) {
        claim.run(nowMs, currentIso(), row.id);
        claimed.push(rowToBrainTask(row));
      }
    });
    transaction();
    return claimed;
  }

  async completeBrainTask(id: number): Promise<void> {
    this.db.prepare(`UPDATE brain_tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).run(currentIso(), id);
  }

  async failBrainTask(id: number, error: string, options?: { retryInMs?: number | null }): Promise<void> {
    if (options?.retryInMs != null) {
      this.db
        .prepare(
          `UPDATE brain_tasks
           SET status = 'pending', attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ?, claimed_at_ms = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(Date.now() + options.retryInMs, error, currentIso(), id);
    } else {
      this.db
        .prepare(`UPDATE brain_tasks SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(error, currentIso(), id);
    }
  }

  async resetInFlightBrainTasks(staleClaimMs = 30 * 60_000): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE brain_tasks SET status = 'pending', claimed_at_ms = NULL, updated_at = ?
         WHERE status = 'running' AND (claimed_at_ms IS NULL OR claimed_at_ms < ?)`
      )
      .run(currentIso(), Date.now() - staleClaimMs);
    return result.changes;
  }

  async getBrainTaskSummary(): Promise<BrainTaskSummary> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM brain_tasks GROUP BY status`).all() as Array<{
      status: string;
      count: number;
    }>;
    const summary: BrainTaskSummary = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const row of rows) {
      if (row.status in summary) {
        summary[row.status as keyof BrainTaskSummary] = Number(row.count);
      }
    }
    return summary;
  }

  async startBrainRun(kind: BrainRunSummary["kind"], timezone?: string | null): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(`INSERT INTO brain_runs (id, kind, status, started_at, timezone) VALUES (?, ?, 'running', ?, ?)`)
      .run(id, kind, currentIso(), timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
    return id;
  }

  async completeBrainRun(runId: string, totals: Record<string, number>): Promise<void> {
    this.db
      .prepare(`UPDATE brain_runs SET status = 'completed', finished_at = ?, totals_json = ? WHERE id = ?`)
      .run(currentIso(), stringifyJson(totals), runId);
  }

  async failBrainRun(runId: string, status: "failed" | "interrupted" | "budget_exceeded", message: string): Promise<void> {
    this.db
      .prepare(`UPDATE brain_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?`)
      .run(status, currentIso(), message, runId);
  }

  async recordBrainLlmUsage(entry: { purpose: string; provider: string; inputTokens: number; outputTokens: number }): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO brain_llm_ledger (day, purpose, provider, input_tokens, output_tokens, at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(new Date(now).toISOString().slice(0, 10), entry.purpose, entry.provider, entry.inputTokens, entry.outputTokens, now);
  }

  async getBrainLlmUsage(options: { sinceMs: number }): Promise<BrainLlmUsageSummary> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM brain_llm_ledger WHERE at_ms >= ?`
      )
      .get(options.sinceMs) as { calls: number; input_tokens: number; output_tokens: number };
    return { calls: Number(row.calls), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) };
  }

  async getBrainStatus(): Promise<BrainStatusSummary> {
    const coverage = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN COALESCE(m.timestamp_ms, 0) <= COALESCE(w.assimilated_through_ms, 0) THEN 1 ELSE 0 END), 0) AS assimilated
         FROM messages m
         JOIN chats ch ON ch.id = m.chat_id
         LEFT JOIN brain_chat_watermarks w ON w.chat_source_id = ch.source_chat_id
         WHERE ${visibleExchangePredicate("m")}`
      )
      .get() as { total: number; assimilated: number };
    const chatsWithBacklog = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT ch.id
           FROM chats ch
           LEFT JOIN brain_chat_watermarks w ON w.chat_source_id = ch.source_chat_id
           JOIN messages m ON m.chat_id = ch.id
           WHERE COALESCE(m.timestamp_ms, 0) > COALESCE(w.assimilated_through_ms, 0)
             AND ${visibleExchangePredicate("m")}
           GROUP BY ch.id
         )`
      )
      .get() as { count: number };
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const runs = this.db.prepare(`SELECT * FROM brain_runs ORDER BY started_at DESC LIMIT 5`).all() as SqliteBrainRunRow[];
    const total = Number(coverage.total ?? 0);
    const assimilated = Number(coverage.assimilated ?? 0);
    return {
      totalVisibleMessages: total,
      assimilatedVisibleMessages: assimilated,
      coveragePercent: total > 0 ? Math.round((assimilated / total) * 1000) / 10 : 100,
      chatsWithBacklog: Number(chatsWithBacklog.count ?? 0),
      backlogSample: await this.getBrainChatBacklog({ limit: 8 }),
      tasks: await this.getBrainTaskSummary(),
      usageToday: await this.getBrainLlmUsage({ sinceMs: utcMidnight.getTime() }),
      latestRun: runs[0] ? rowToBrainRun(runs[0]) : null,
      activeRun: runs.find((run) => run.status === "running") ? rowToBrainRun(runs.find((run) => run.status === "running")!) : null
    };
  }

  async collapseSupersededMessages(
    pairs: Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>
  ): Promise<number> {
    this.assertWritableIdentityVersion();
    if (pairs.length === 0) {
      return 0;
    }
    // The stale row is a previous import of the same message under its edit
    // key; the canonical row (just upserted) already carries the final text,
    // and live-derived state always targeted the canonical identity.
    const remove = this.db.prepare(
      `DELETE FROM messages
       WHERE source_message_key = ?
         AND EXISTS (SELECT 1 FROM messages canonical WHERE canonical.source_message_key = ?)`
    );
    let collapsed = 0;
    const transaction = this.db.transaction(() => {
      for (const pair of pairs) {
        const chatSourceId = this.canonicalJid(pair.chatSourceId) ?? pair.chatSourceId;
        const result = remove.run(messageKey(chatSourceId, pair.staleMessageId), messageKey(chatSourceId, pair.canonicalMessageId));
        collapsed += result.changes;
      }
    });
    transaction();
    if (collapsed > 0) {
      await this.markStaleMemoryForMissingMessages();
    }
    return collapsed;
  }

  async listUnknownTypeCodes(): Promise<Array<{ code: string; count: number; examples: Array<{ chatLabel: string; timestampMs: number | null }> }>> {
    const codes = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(COALESCE(raw_type_code, '')), ''), REPLACE(message_type, 'unknown_', '')) AS code, COUNT(*) AS n
         FROM messages
         WHERE message_type LIKE 'unknown%'
         GROUP BY 1
         ORDER BY n DESC, code ASC`
      )
      .all() as Array<{ code: string; n: number }>;
    const exampleStmt = this.db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(COALESCE(c.display_name, '')), ''), '') AS display_name, c.jid AS jid, m.timestamp_ms AS timestamp_ms
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.message_type LIKE 'unknown%'
         AND COALESCE(NULLIF(TRIM(COALESCE(m.raw_type_code, '')), ''), REPLACE(m.message_type, 'unknown_', '')) = ?
       ORDER BY m.timestamp_ms DESC
       LIMIT 3`
    );
    return codes.map((row) => ({
      code: String(row.code),
      count: Number(row.n),
      examples: (exampleStmt.all(String(row.code)) as Array<{ display_name: string; jid: string; timestamp_ms: number | null }>).map(
        (example) => ({
          // Display rule: name, else phone digits, never a raw identifier.
          chatLabel:
            example.display_name ||
            displayPhoneFromJid(example.jid) ||
            (example.jid.endsWith("@g.us") ? "Unnamed group" : "Unresolved chat"),
          timestampMs: example.timestamp_ms == null ? null : Number(example.timestamp_ms)
        })
      )
    }));
  }

  // One-time hygiene for rows written before identity-derived names were
  // rejected at the write boundary.
  async clearIdentityDerivedChatNames(): Promise<number> {
    const rows = this.db
      .prepare(`SELECT id, display_name, jid FROM chats WHERE display_name IS NOT NULL AND TRIM(display_name) <> ''`)
      .all() as Array<{ id: number; display_name: string; jid: string }>;
    const clear = this.db.prepare(`UPDATE chats SET display_name = NULL, updated_at = ? WHERE id = ?`);
    let cleared = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (isIdentityDerivedName(row.display_name, row.jid)) {
          clear.run(currentIso(), row.id);
          cleared += 1;
        }
      }
    });
    transaction();
    return cleared;
  }

  // Rows created from Signal-protocol transport envelopes before normalization
  // filtered them: no user content by construction, safe to remove as noise.
  async removeProtocolNoiseMessages(): Promise<number> {
    // Live artifacts that were archived as standalone rows before normalization
    // filtered them: Signal-protocol transport envelopes, and secret-encrypted
    // edit envelopes (now applied in place as edits, so their placeholder card
    // is stale). Both are never user messages of their own.
    const noiseTypes = ["unknown_senderKeyDistributionMessage", "encrypted_update"];
    const placeholders = noiseTypes.map(() => "?").join(",");
    const affectedChats = this.db
      .prepare(
        `SELECT DISTINCT c.source_chat_id AS id
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.source_table LIKE 'wa-web%' AND m.message_type IN (${placeholders})`
      )
      .all(...noiseTypes) as Array<{ id: string }>;
    if (affectedChats.length === 0) {
      return 0;
    }
    const result = this.db
      .prepare(`DELETE FROM messages WHERE source_table LIKE 'wa-web%' AND message_type IN (${placeholders})`)
      .run(...noiseTypes);
    if (result.changes > 0) {
      await this.refreshChatStats(affectedChats.map((chat) => chat.id));
      await this.markStaleMemoryForMissingMessages();
    }
    return result.changes;
  }

  async listUnnamedGroupChats(limit = 20): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT source_chat_id FROM chats
         WHERE chat_type = 'group' AND (display_name IS NULL OR TRIM(display_name) = '' OR display_name = jid)
         ORDER BY last_message_at_ms IS NULL, last_message_at_ms DESC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{ source_chat_id: string }>;
    return rows.map((row) => row.source_chat_id);
  }

  async listUnmergedLidIdentities(limit = 20): Promise<Array<{ lid: string; pn: string }>> {
    return this.db
      .prepare(
        `SELECT l.lid, l.pn FROM identity_links l
         WHERE EXISTS (SELECT 1 FROM chats WHERE chats.source_chat_id = l.lid)
            OR EXISTS (SELECT 1 FROM contacts WHERE contacts.source_jid = l.lid)
            OR EXISTS (SELECT 1 FROM messages WHERE messages.sender_source_jid = l.lid)
            OR EXISTS (SELECT 1 FROM chat_participants WHERE chat_participants.source_jid = l.lid)
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{ lid: string; pn: string }>;
  }

  async mergeIdentity(lid: string, pn: string): Promise<{ chatsMerged: number; contactsMerged: number; messagesCollapsed: number }> {
    const result = { chatsMerged: 0, contactsMerged: 0, messagesCollapsed: 0 };
    // The vast majority of learned links have nothing archived under the LID
    // form (history sync ships mappings for every contact); skip the merge
    // machinery entirely unless the LID actually appears somewhere.
    const hasPresence = this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM chats WHERE source_chat_id = ?)
             OR EXISTS (SELECT 1 FROM contacts WHERE source_jid = ?)
             OR EXISTS (SELECT 1 FROM messages WHERE sender_source_jid = ?)
             OR EXISTS (SELECT 1 FROM chat_participants WHERE source_jid = ?)
             OR EXISTS (SELECT 1 FROM live_chat_checkpoints WHERE chat_source_id = ?)
             OR EXISTS (SELECT 1 FROM live_gap_windows WHERE chat_source_id = ?) AS present`
      )
      .get(lid, lid, lid, lid, lid, lid) as { present: number };
    if (!hasPresence.present) {
      return result;
    }
    const transaction = this.db.transaction(() => {
      // Chats: rename when the canonical chat is absent; otherwise move
      // messages across and collapse (chat, id) conflicts onto the richer row.
      const lidChat = this.db.prepare(`SELECT id FROM chats WHERE source_chat_id = ?`).get(lid) as { id: number } | undefined;
      const pnChat = this.db.prepare(`SELECT id FROM chats WHERE source_chat_id = ?`).get(pn) as { id: number } | undefined;
      if (lidChat && !pnChat) {
        this.db.prepare(`UPDATE chats SET source_chat_id = ?, jid = ?, updated_at = ? WHERE id = ?`).run(pn, pn, currentIso(), lidChat.id);
        this.rekeyChatMessages(lidChat.id, pn);
        result.chatsMerged += 1;
      } else if (lidChat && pnChat) {
        const moveTargets = this.db
          .prepare(`SELECT id, source_message_id FROM messages WHERE chat_id = ?`)
          .all(lidChat.id) as Array<{ id: number; source_message_id: string }>;
        const findConflict = this.db.prepare(`SELECT id FROM messages WHERE chat_id = ? AND source_message_id = ?`);
        const moveOne = this.db.prepare(`UPDATE messages SET chat_id = ?, source_message_key = ? WHERE id = ?`);
        for (const message of moveTargets) {
          const conflict = findConflict.get(pnChat.id, message.source_message_id) as { id: number } | undefined;
          if (conflict) {
            this.collapseMessagePair(conflict.id, message.id);
            result.messagesCollapsed += 1;
          } else {
            moveOne.run(pnChat.id, messageKey(pn, message.source_message_id), message.id);
          }
        }
        this.db
          .prepare(
            `UPDATE chats SET
               display_name = COALESCE(NULLIF(chats.display_name, ''), (SELECT NULLIF(display_name, '') FROM chats c2 WHERE c2.id = ?)),
               platform_recency_ms = MAX(COALESCE(chats.platform_recency_ms, 0), COALESCE((SELECT platform_recency_ms FROM chats c2 WHERE c2.id = ?), 0)),
               updated_at = ?
             WHERE id = ?`
          )
          .run(lidChat.id, lidChat.id, currentIso(), pnChat.id);
        this.db.prepare(`DELETE FROM chat_participants WHERE chat_id = ? AND source_jid IN (SELECT source_jid FROM chat_participants WHERE chat_id = ?)`).run(lidChat.id, pnChat.id);
        this.db.prepare(`UPDATE chat_participants SET chat_id = ? WHERE chat_id = ?`).run(pnChat.id, lidChat.id);
        this.db.prepare(`DELETE FROM chats WHERE id = ?`).run(lidChat.id);
        result.chatsMerged += 1;
      }

      // Contacts: keep the canonical row, absorb missing fields, delete the husk.
      const lidContact = this.db.prepare(`SELECT id FROM contacts WHERE source_jid = ?`).get(lid) as { id: number } | undefined;
      const pnContact = this.db.prepare(`SELECT id FROM contacts WHERE source_jid = ?`).get(pn) as { id: number } | undefined;
      if (lidContact && !pnContact) {
        this.db.prepare(`UPDATE contacts SET source_jid = ?, updated_at = ? WHERE id = ?`).run(pn, currentIso(), lidContact.id);
        result.contactsMerged += 1;
      } else if (lidContact && pnContact) {
        this.db
          .prepare(
            `UPDATE contacts SET
               display_name = COALESCE(NULLIF(contacts.display_name, ''), (SELECT NULLIF(display_name, '') FROM contacts c2 WHERE c2.id = ?)),
               push_name = COALESCE(NULLIF(contacts.push_name, ''), (SELECT NULLIF(push_name, '') FROM contacts c2 WHERE c2.id = ?)),
               phone_number = COALESCE(contacts.phone_number, (SELECT phone_number FROM contacts c2 WHERE c2.id = ?)),
               updated_at = ?
             WHERE id = ?`
          )
          .run(lidContact.id, lidContact.id, lidContact.id, currentIso(), pnContact.id);
        this.db.prepare(`UPDATE messages SET sender_contact_id = ? WHERE sender_contact_id = ?`).run(pnContact.id, lidContact.id);
        this.db.prepare(`UPDATE chat_participants SET contact_id = ? WHERE contact_id = ?`).run(pnContact.id, lidContact.id);
        this.db.prepare(`DELETE FROM contacts WHERE id = ?`).run(lidContact.id);
        result.contactsMerged += 1;
      }
      this.db.prepare(`UPDATE messages SET sender_source_jid = ? WHERE sender_source_jid = ?`).run(pn, lid);
      this.db
        .prepare(`DELETE FROM chat_participants WHERE source_jid = ? AND EXISTS (SELECT 1 FROM chat_participants p2 WHERE p2.chat_id = chat_participants.chat_id AND p2.source_jid = ?)`)
        .run(lid, pn);
      this.db.prepare(`UPDATE chat_participants SET source_jid = ? WHERE source_jid = ?`).run(pn, lid);
      // Mentions recorded under the LID collapse onto the canonical identity;
      // rows that would duplicate an existing canonical mention just drop.
      this.db.prepare(`UPDATE OR IGNORE message_mentions SET mentioned_jid = ? WHERE mentioned_jid = ?`).run(pn, lid);
      this.db.prepare(`DELETE FROM message_mentions WHERE mentioned_jid = ?`).run(lid);

      // Live bookkeeping follows the merge.
      const pnCheckpoint = this.db.prepare(`SELECT chat_source_id FROM live_chat_checkpoints WHERE chat_source_id = ?`).get(pn);
      if (pnCheckpoint) {
        this.db.prepare(`DELETE FROM live_chat_checkpoints WHERE chat_source_id = ?`).run(lid);
      } else {
        this.db.prepare(`UPDATE live_chat_checkpoints SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);
      }
      // Anchor keys embed the old chat form; recovery recomputes them anyway.
      this.db.prepare(`UPDATE live_gap_windows SET chat_source_id = ?, anchor_message_key = NULL WHERE chat_source_id = ?`).run(pn, lid);
      this.db.prepare(`UPDATE live_message_updates SET chat_source_id = ? WHERE chat_source_id = ?`).run(pn, lid);
    });
    transaction();
    await this.refreshChatStats([pn]);
    await this.markStaleMemoryForMissingMessages();
    // The merge may have improved name resolution for this identity: refresh
    // derived search text for its messages and the messages that mention it,
    // chunked with yields so a heavy sender never stalls ingestion.
    const affected = (
      this.db
        .prepare(
          `SELECT id FROM messages WHERE sender_source_jid = ?
           UNION
           SELECT message_id AS id FROM message_mentions WHERE mentioned_jid = ?`
        )
        .all(pn, pn) as Array<{ id: number }>
    ).map((row) => Number(row.id));
    for (let index = 0; index < affected.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      const chunk = affected.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
      this.db.transaction(() => this.syncMessageDerivedState(chunk))();
      if (index + SQLITE_IN_QUERY_BATCH_SIZE < affected.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return result;
  }

  // Re-derive message keys after their chat's canonical JID changed.
  private rekeyChatMessages(chatId: number, canonicalChatJid: string): void {
    const rows = this.db.prepare(`SELECT id, source_message_id FROM messages WHERE chat_id = ?`).all(chatId) as Array<{
      id: number;
      source_message_id: string;
    }>;
    const update = this.db.prepare(`UPDATE messages SET source_message_key = ? WHERE id = ?`);
    for (const row of rows) {
      update.run(messageKey(canonicalChatJid, row.source_message_id), row.id);
    }
  }

  // Merge two rows representing the same WhatsApp message: tombstones stick,
  // richer content wins, and the dropped row's unique metadata is absorbed.
  private collapseMessagePair(keepId: number, dropId: number): void {
    const richness = this.db.prepare(
      `SELECT id, (NULLIF(TRIM(COALESCE(body, '')), '') IS NOT NULL) + (NULLIF(TRIM(COALESCE(caption, '')), '') IS NOT NULL) + has_media AS score
       FROM messages WHERE id IN (?, ?)`
    );
    const scores = new Map((richness.all(keepId, dropId) as Array<{ id: number; score: number }>).map((row) => [row.id, row.score]));
    const contentSource = (scores.get(dropId) ?? 0) > (scores.get(keepId) ?? 0) ? dropId : keepId;
    this.db
      .prepare(
        `UPDATE messages SET
           is_deleted = MAX(is_deleted, (SELECT is_deleted FROM messages m2 WHERE m2.id = ?)),
           is_starred = MAX(is_starred, (SELECT is_starred FROM messages m2 WHERE m2.id = ?)),
           is_forwarded = MAX(is_forwarded, (SELECT is_forwarded FROM messages m2 WHERE m2.id = ?)),
           timestamp_ms = COALESCE(timestamp_ms, (SELECT timestamp_ms FROM messages m2 WHERE m2.id = ?)),
           sent_at = COALESCE(sent_at, (SELECT sent_at FROM messages m2 WHERE m2.id = ?)),
           sender_source_jid = COALESCE(sender_source_jid, (SELECT sender_source_jid FROM messages m2 WHERE m2.id = ?)),
           quoted_source_message_id = COALESCE(quoted_source_message_id, (SELECT quoted_source_message_id FROM messages m2 WHERE m2.id = ?)),
           raw_metadata_json = COALESCE(raw_metadata_json, (SELECT raw_metadata_json FROM messages m2 WHERE m2.id = ?)),
           body = (SELECT body FROM messages m2 WHERE m2.id = ?),
           caption = (SELECT caption FROM messages m2 WHERE m2.id = ?),
           has_media = MAX(has_media, (SELECT has_media FROM messages m2 WHERE m2.id = ?)),
           media_mime_type = COALESCE(media_mime_type, (SELECT media_mime_type FROM messages m2 WHERE m2.id = ?)),
           media_name = COALESCE(media_name, (SELECT media_name FROM messages m2 WHERE m2.id = ?)),
           message_type = (SELECT message_type FROM messages m2 WHERE m2.id = ?)
         WHERE id = ?`
      )
      .run(dropId, dropId, dropId, dropId, dropId, dropId, dropId, dropId, contentSource, contentSource, dropId, dropId, dropId, contentSource, keepId);
    // Merged tombstones keep their held content: deletion is a state marker,
    // never a content eraser (backup-store semantics).
    this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(dropId);
  }

  async createRestorePoint(label: string): Promise<ArchiveRestorePoint> {
    const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "archive";
    const snapshotPath = path.resolve(config.workDir, "import-staging", `${safeLabel}-${crypto.randomUUID()}.sqlite`);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    await this.db.backup(snapshotPath);
    let disposed = false;
    return {
      restore: async () => {
        if (disposed || !fs.existsSync(snapshotPath)) {
          return;
        }
        this.restoreFromSnapshot(snapshotPath);
      },
      dispose: async () => {
        disposed = true;
        await fs.promises.rm(snapshotPath, { force: true });
      }
    };
  }

  async startImportRun(sourceSummary: Record<string, unknown>): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO import_runs (id, status, started_at, tool_version, source_summary_json, totals_json)
         VALUES (?, 'running', ?, ?, ?, ?)`
      )
      .run(id, currentIso(), TOOL_VERSION, stringifyJson(sourceSummary), stringifyJson(totalsOrEmpty(null)));
    return id;
  }

  async completeImportRun(runId: string, totals: ImportTotals, warningCount: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE import_runs
         SET status = 'completed', finished_at = ?, totals_json = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, runId);
  }

  async failImportRun(
    runId: string,
    code: string,
    message: string,
    totals: ImportTotals = totalsOrEmpty(null),
    warningCount = 0
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE import_runs
         SET status = 'failed', finished_at = ?, totals_json = ?, warning_count = ?, error_code = ?, error_message = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, code, message.slice(0, 500), runId);
  }

  async addWarnings(runId: string, warnings: ImportWarning[]): Promise<void> {
    if (warnings.length === 0) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO import_warnings
       (import_run_id, severity, code, entity_type, source_table, source_row_id, message, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction(() => {
      for (const warning of warnings) {
        insert.run(
          runId,
          warning.severity,
          warning.code,
          warning.entityType ?? null,
          warning.sourceTable ?? null,
          warning.sourceRowId ?? null,
          warning.message.slice(0, 500),
          stringifyJson(warning.context ?? null)
        );
      }
    });
    transaction();
  }

  async upsertContacts(runId: string, contacts: ContactRecord[]): Promise<Map<string, number>> {
    this.assertWritableIdentityVersion();
    const unique = new Map<string, ContactRecord>();
    for (const contact of contacts) {
      const sourceJid = this.canonicalJid(contact.sourceJid);
      if (!sourceJid) {
        continue;
      }
      // Two records can canonicalize onto one identity within a batch (LID stub
      // + real contact); merge field-wise so a stub cannot clobber a name.
      const existing = unique.get(sourceJid);
      unique.set(sourceJid, {
        ...contact,
        sourceJid,
        displayName: existing?.displayName?.trim() || contact.displayName || null,
        pushName: existing?.pushName?.trim() || contact.pushName || null,
        phoneNumber: existing?.phoneNumber || contact.phoneNumber || null
      });
    }
    if (unique.size === 0) {
      return new Map();
    }

    const upsert = this.db.prepare(
      `INSERT INTO contacts
       (source_jid, phone_number, display_name, push_name, raw_metadata_json, first_seen_import_id, last_seen_import_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_jid) DO UPDATE SET
         phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
         display_name = COALESCE(NULLIF(excluded.display_name, ''), contacts.display_name),
         push_name = COALESCE(NULLIF(excluded.push_name, ''), contacts.push_name),
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, contacts.raw_metadata_json),
         last_seen_import_id = excluded.last_seen_import_id,
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const contact of unique.values()) {
        upsert.run(
          contact.sourceJid,
          contact.phoneNumber ?? null,
          contact.displayName ?? null,
          contact.pushName ?? null,
          stringifyJson(contact.rawMetadata ?? null),
          runId,
          runId,
          currentIso()
        );
      }
    });
    transaction();
    this.propagateContactNamesToDmChats([...unique.values()]);

    return this.getContactIds([...unique.keys()]);
  }

  async upsertChats(runId: string, chats: ChatRecord[]): Promise<Map<string, number>> {
    this.assertWritableIdentityVersion();
    const unique = new Map<string, ChatRecord>();
    for (const chat of chats) {
      const sourceChatId = this.canonicalJid(chat.sourceChatId);
      if (!sourceChatId) {
        continue;
      }
      // Platform chat metadata sometimes carries the bare number/LID digits as
      // the "name"; identity-derived names must never become display labels.
      const displayName = chat.displayName && !isIdentityDerivedName(chat.displayName, sourceChatId) ? chat.displayName : null;
      unique.set(sourceChatId, { ...chat, sourceChatId, jid: sourceChatId, displayName });
    }
    if (unique.size === 0) {
      return new Map();
    }

    const upsert = this.db.prepare(
      `INSERT INTO chats
       (source_chat_id, jid, display_name, chat_type, platform_recency_ms, raw_metadata_json, first_seen_import_id, last_seen_import_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_chat_id) DO UPDATE SET
         jid = excluded.jid,
         display_name = CASE
           WHEN excluded.chat_type = 'unknown' AND chats.display_name IS NOT NULL THEN chats.display_name
           ELSE COALESCE(NULLIF(excluded.display_name, ''), chats.display_name)
         END,
         chat_type = CASE
           WHEN excluded.chat_type = 'unknown' THEN chats.chat_type
           ELSE excluded.chat_type
         END,
         platform_recency_ms = CASE
           WHEN excluded.platform_recency_ms IS NULL THEN chats.platform_recency_ms
           WHEN chats.platform_recency_ms IS NULL THEN excluded.platform_recency_ms
           ELSE MAX(chats.platform_recency_ms, excluded.platform_recency_ms)
         END,
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, chats.raw_metadata_json),
         last_seen_import_id = excluded.last_seen_import_id,
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const chat of unique.values()) {
        upsert.run(
          chat.sourceChatId,
          chat.jid,
          chat.displayName ?? null,
          chat.chatType,
          chat.platformRecencyMs ?? null,
          stringifyJson(chat.rawMetadata ?? null),
          runId,
          runId,
          currentIso()
        );
      }
    });
    transaction();

    return this.getChatIds([...unique.keys()]);
  }

  async upsertParticipants(participants: ParticipantRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    const unique = new Map<string, ParticipantRecord>();
    for (const participant of participants) {
      const chatSourceId = this.canonicalJid(participant.chatSourceId);
      const sourceJid = this.canonicalJid(participant.sourceJid);
      if (!chatSourceId || !sourceJid) {
        continue;
      }
      unique.set(`${chatSourceId}\u0000${sourceJid}`, { ...participant, chatSourceId, sourceJid });
    }
    if (unique.size === 0) {
      return 0;
    }

    const chats = this.getChatIds([...new Set([...unique.values()].map((p) => p.chatSourceId))]);
    const contacts = this.getContactIds([...new Set([...unique.values()].map((p) => p.sourceJid))]);
    const rows = [...unique.values()]
      .map((participant) => {
        const chatId = chats.get(participant.chatSourceId);
        if (!chatId) {
          return null;
        }
        return {
          chatId,
          sourceJid: participant.sourceJid,
          contactId: contacts.get(participant.sourceJid) ?? null,
          displayName: participant.displayName ?? null,
          firstSeenAtMs: participant.firstSeenAtMs ?? null,
          lastSeenAtMs: participant.lastSeenAtMs ?? null,
          membershipSource: participant.membershipSource,
          rawMetadata: stringifyJson(participant.rawMetadata ?? null)
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) {
      return 0;
    }

    const upsert = this.db.prepare(
      `INSERT INTO chat_participants
       (chat_id, source_jid, contact_id, display_name, first_seen_at_ms, last_seen_at_ms, membership_source, raw_metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, source_jid) DO UPDATE SET
         contact_id = COALESCE(excluded.contact_id, chat_participants.contact_id),
         display_name = COALESCE(NULLIF(excluded.display_name, ''), chat_participants.display_name),
         first_seen_at_ms = CASE
           WHEN chat_participants.first_seen_at_ms IS NULL THEN excluded.first_seen_at_ms
           WHEN excluded.first_seen_at_ms IS NULL THEN chat_participants.first_seen_at_ms
           ELSE MIN(chat_participants.first_seen_at_ms, excluded.first_seen_at_ms)
         END,
         last_seen_at_ms = CASE
           WHEN chat_participants.last_seen_at_ms IS NULL THEN excluded.last_seen_at_ms
           WHEN excluded.last_seen_at_ms IS NULL THEN chat_participants.last_seen_at_ms
           ELSE MAX(chat_participants.last_seen_at_ms, excluded.last_seen_at_ms)
         END,
         membership_source = CASE
           WHEN chat_participants.membership_source = 'source' THEN chat_participants.membership_source
           ELSE excluded.membership_source
         END,
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, chat_participants.raw_metadata_json),
         updated_at = excluded.updated_at`
    );
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.chatId,
          row.sourceJid,
          row.contactId,
          row.displayName,
          row.firstSeenAtMs,
          row.lastSeenAtMs,
          row.membershipSource,
          row.rawMetadata,
          currentIso()
        );
      }
    });
    transaction();
    return rows.length;
  }

  async upsertMessages(messages: MessageRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (messages.length === 0) {
      return 0;
    }

    // Canonicalize identities and re-derive the message key so every source
    // converges on (canonical chat, key_id) no matter what the producer built.
    const canonical = messages
      .map((message) => {
        const chatSourceId = this.canonicalJid(message.chatSourceId);
        if (!chatSourceId || !message.sourceMessageId) {
          return null;
        }
        const senderSourceJid =
          message.senderSourceJid === "me" ? "me" : this.canonicalJid(message.senderSourceJid) ?? message.senderSourceJid ?? null;
        return { ...message, chatSourceId, senderSourceJid, sourceMessageKey: messageKey(chatSourceId, message.sourceMessageId) } as MessageRecord;
      })
      .filter((message): message is MessageRecord => message !== null);

    const chatIds = this.getChatIds([...new Set(canonical.map((message) => message.chatSourceId))]);
    const senderIds = this.getContactIds([
      ...new Set(canonical.map((message) => message.senderSourceJid).filter((jid): jid is string => Boolean(jid)))
    ]);
    // Derived search text for the insert path, computed from the incoming
    // values; conflict-merged rows are recomputed from final state below.
    const incomingMentionLabels = this.resolveMentionLabels(canonical.flatMap((message) => [message.body ?? null, message.caption ?? null]));
    const incomingSenderLabels = this.resolveContactLabels(
      canonical.map((message) => message.senderSourceJid).filter((jid): jid is string => Boolean(jid))
    );
    const rows = canonical
      .map((message) => {
        const chatId = chatIds.get(message.chatSourceId);
        if (!chatId) {
          return null;
        }
        const senderLabel = message.senderSourceJid
          ? incomingSenderLabels.get(message.senderSourceJid) ?? displayPhoneFromJid(message.senderSourceJid)
          : null;
        return {
          sourceMessageKey: message.sourceMessageKey,
          sourceMessageId: message.sourceMessageId,
          sourceTable: message.sourceTable,
          sourceRowId: message.sourceRowId,
          chatId,
          senderContactId: message.senderSourceJid ? senderIds.get(message.senderSourceJid) ?? null : null,
          senderSourceJid: message.senderSourceJid ?? null,
          timestampMs: message.timestampMs ?? null,
          sentAt: isoFromMs(message.timestampMs),
          direction: message.direction,
          fromMe: message.fromMe == null ? null : Number(message.fromMe),
          messageType: message.messageType,
          rawTypeCode: message.rawTypeCode == null ? null : String(message.rawTypeCode),
          body: message.body ?? null,
          caption: message.caption ?? null,
          hasMedia: Number(message.hasMedia),
          mediaMimeType: message.mediaMimeType ?? null,
          mediaName: message.mediaName ?? null,
          quotedSourceMessageId: message.quotedSourceMessageId ?? null,
          isDeleted: Number(message.isDeleted),
          isForwarded: Number(message.isForwarded),
          isStarred: Number(message.isStarred),
          rawMetadata: stringifyJson(message.rawMetadata ?? null),
          resolvedText: composeResolvedText(
            message.body ?? null,
            message.caption ?? null,
            message.mediaName ?? null,
            senderLabel,
            incomingMentionLabels
          ),
          mentionedJids: [
            ...new Set((message.mentionedJids ?? []).map((jid) => this.canonicalJid(jid)).filter((jid): jid is string => Boolean(jid)))
          ]
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) {
      return 0;
    }

    const upsert = this.db.prepare(
      `INSERT INTO messages
       (source_message_key, source_message_id, source_table, source_row_id, chat_id, sender_contact_id, sender_source_jid,
        timestamp_ms, sent_at, direction, from_me, message_type, raw_type_code, body, caption, has_media, media_mime_type,
        media_name, quoted_source_message_id, is_deleted, is_forwarded, is_starred, raw_metadata_json, resolved_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_message_key) DO UPDATE SET
         chat_id = excluded.chat_id,
         sender_contact_id = COALESCE(excluded.sender_contact_id, messages.sender_contact_id),
         sender_source_jid = COALESCE(excluded.sender_source_jid, messages.sender_source_jid),
         timestamp_ms = COALESCE(excluded.timestamp_ms, messages.timestamp_ms),
         sent_at = COALESCE(excluded.sent_at, messages.sent_at),
         direction = excluded.direction,
         from_me = COALESCE(excluded.from_me, messages.from_me),
         message_type = CASE
           WHEN (excluded.message_type = 'system' OR excluded.message_type LIKE 'unknown%')
                AND messages.message_type <> 'system' AND messages.message_type NOT LIKE 'unknown%' THEN messages.message_type
           -- A contentless unknown re-delivery (e.g. an empty placeholder
           -- response) must not erase a system stub's classification either.
           WHEN excluded.message_type LIKE 'unknown%' AND messages.message_type = 'system' THEN messages.message_type
           ELSE excluded.message_type
         END,
         raw_type_code = COALESCE(excluded.raw_type_code, messages.raw_type_code),
         body = CASE
           WHEN messages.is_deleted = 1
                AND NOT (messages.message_type LIKE 'unknown%' AND messages.body IS NULL AND messages.caption IS NULL
                         AND excluded.is_deleted = 0)
           THEN messages.body
           ELSE COALESCE(NULLIF(excluded.body, ''), messages.body)
         END,
         caption = CASE
           WHEN messages.is_deleted = 1
                AND NOT (messages.message_type LIKE 'unknown%' AND messages.body IS NULL AND messages.caption IS NULL
                         AND excluded.is_deleted = 0)
           THEN messages.caption
           ELSE COALESCE(NULLIF(excluded.caption, ''), messages.caption)
         END,
         has_media = MAX(messages.has_media, excluded.has_media),
         media_mime_type = COALESCE(excluded.media_mime_type, messages.media_mime_type),
         media_name = COALESCE(excluded.media_name, messages.media_name),
         quoted_source_message_id = COALESCE(excluded.quoted_source_message_id, messages.quoted_source_message_id),
         -- A textless unknown-typed row flagged deleted is the retired
         -- inference heuristic, not evidence; a re-import bearing a fresh
         -- not-deleted verdict heals it. Real tombstones (typed rows) keep
         -- their sticky deletion.
         is_deleted = CASE
           WHEN messages.message_type LIKE 'unknown%' AND messages.body IS NULL AND messages.caption IS NULL
                AND excluded.is_deleted = 0
           THEN 0
           ELSE MAX(messages.is_deleted, excluded.is_deleted)
         END,
         is_forwarded = MAX(messages.is_forwarded, excluded.is_forwarded),
         is_starred = MAX(messages.is_starred, excluded.is_starred),
         raw_metadata_json = COALESCE(excluded.raw_metadata_json, messages.raw_metadata_json)`
    );
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        upsert.run(
          row.sourceMessageKey,
          row.sourceMessageId,
          row.sourceTable,
          row.sourceRowId,
          row.chatId,
          row.senderContactId,
          row.senderSourceJid,
          row.timestampMs,
          row.sentAt,
          row.direction,
          row.fromMe,
          row.messageType,
          row.rawTypeCode,
          row.body,
          row.caption,
          row.hasMedia,
          row.mediaMimeType,
          row.mediaName,
          row.quotedSourceMessageId,
          row.isDeleted,
          row.isForwarded,
          row.isStarred,
          row.rawMetadata,
          row.resolvedText
        );
      }
      // Conflict-merged rows may have kept older body/caption (tombstones,
      // contentless re-deliveries); recompute derived search state from the
      // FINAL stored content so the index never diverges from the row.
      const keys = rows.map((row) => row.sourceMessageKey);
      const explicitMentionsById = new Map<number, string[]>();
      const idsByKey = new Map<string, number>();
      for (let index = 0; index < keys.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
        const batch = keys.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
        const found = this.db
          .prepare(`SELECT id, source_message_key FROM messages WHERE source_message_key IN (${batch.map(() => "?").join(",")})`)
          .all(...batch) as Array<{ id: number; source_message_key: string }>;
        for (const row of found) {
          idsByKey.set(row.source_message_key, Number(row.id));
        }
      }
      for (const row of rows) {
        const id = idsByKey.get(row.sourceMessageKey);
        if (id != null && row.mentionedJids.length > 0) {
          explicitMentionsById.set(id, row.mentionedJids);
        }
      }
      this.syncMessageDerivedState([...idsByKey.values()], explicitMentionsById);
    });
    transaction();
    return rows.length;
  }

  async refreshChatStats(chatSourceIds?: string[]): Promise<void> {
    // Chat recency mirrors WhatsApp: only user-visible conversation messages
    // advance a chat's position/date; system, status, and reaction events do not.
    const statsSql = `UPDATE chats
       SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.chat_id = chats.id),
           participant_count = (SELECT COUNT(*) FROM chat_participants WHERE chat_participants.chat_id = chats.id),
           last_message_at_ms = (
             SELECT MAX(timestamp_ms) FROM messages
             WHERE messages.chat_id = chats.id AND ${visibleExchangePredicate("messages")}
           ),
           last_message_at = (
             SELECT sent_at FROM messages
             WHERE messages.chat_id = chats.id AND ${visibleExchangePredicate("messages")}
             ORDER BY timestamp_ms DESC, id DESC
             LIMIT 1
           )`;
    if (!chatSourceIds) {
      this.db.exec(statsSql);
      return;
    }
    const unique = [...new Set(chatSourceIds)].filter(Boolean);
    if (unique.length === 0) {
      return;
    }
    const scoped = this.db.prepare(`${statsSql} WHERE chats.source_chat_id IN (${unique.map(() => "?").join(",")})`);
    for (let index = 0; index < unique.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
      scoped.run(...unique.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE));
    }
  }

  async clearArchiveData(): Promise<void> {
    this.db.transaction(() => {
      for (const table of DELETE_TABLE_ORDER) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.clearSqliteSequence();
    })();
    // A cleared archive is a valid fresh start under the current identity scheme.
    this.stampIdentityVersion();
    // Deleting messages emptied the FTS index through its triggers, so a
    // cleared archive is consistent and searchable from the start.
    this.setFtsState("ready");
    this.identityLinks.clear();
  }

  async getStatus(): Promise<StatusSummary> {
    if (!this.isInitialized()) {
      return emptyStatus(false);
    }
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM chats) AS chats,
          (SELECT COUNT(*) FROM contacts) AS contacts,
          (SELECT COUNT(*) FROM chat_participants) AS participants,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM import_warnings) AS warnings`
      )
      .get() as Record<string, number>;
    const latestRun = this.db
      .prepare(
        `SELECT id, status, started_at, finished_at, totals_json, warning_count, error_message
         FROM import_runs
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get() as SqliteImportRunRow | undefined;
    const latestImport = latestRun ? rowToImportSummary(latestRun) : null;
    const latestWarnings = latestImport ? this.getLatestWarnings(latestImport.id) : [];

    return {
      database: {
        configured: true,
        initialized: true,
        adapter: "sqlite",
        location: path.basename(this.dbPath),
        ...(this.legacyArchive ? { error: LEGACY_ARCHIVE_MESSAGE } : {})
      },
      counts: {
        chats: Number(counts.chats ?? 0),
        contacts: Number(counts.contacts ?? 0),
        participants: Number(counts.participants ?? 0),
        messages: Number(counts.messages ?? 0),
        warnings: Number(counts.warnings ?? 0)
      },
      latestImport,
      latestWarnings,
      live: await this.getLiveStatus(),
      memory: await this.getMemoryStatus(await getMemoryProviderStatus())
    };
  }

  async upsertLiveSession(session: Partial<LiveSessionSummary> & { id: string; status: LiveSessionSummary["status"]; clientName: string }): Promise<void> {
    const existing = this.db
      .prepare(`SELECT created_at FROM live_sessions WHERE id = ?`)
      .get(session.id) as { created_at: string } | undefined;
    const now = currentIso();
    this.db
      .prepare(
        `INSERT INTO live_sessions
         (id, status, client_name, linked_device_jid, last_connected_at, last_disconnected_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           client_name = excluded.client_name,
           linked_device_jid = COALESCE(excluded.linked_device_jid, live_sessions.linked_device_jid),
           last_connected_at = COALESCE(excluded.last_connected_at, live_sessions.last_connected_at),
           last_disconnected_at = COALESCE(excluded.last_disconnected_at, live_sessions.last_disconnected_at),
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(
        session.id,
        session.status,
        session.clientName,
        session.linkedDeviceJid ?? null,
        session.lastConnectedAt ?? null,
        session.lastDisconnectedAt ?? null,
        session.lastError ?? null,
        existing?.created_at ?? session.createdAt ?? now,
        now
      );
  }

  async startLiveSyncRun(sourceSummary: Record<string, unknown>): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO live_sync_runs (id, status, started_at, client_name, source_summary_json, totals_json)
         VALUES (?, 'running', ?, ?, ?, ?)`
      )
      .run(id, currentIso(), String(sourceSummary.client ?? "baileys"), stringifyJson(sourceSummary), stringifyJson(emptyLiveTotals()));
    return id;
  }

  async completeLiveSyncRun(runId: string, totals: LiveSyncTotals, warningCount: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE live_sync_runs
         SET status = 'completed', finished_at = ?, totals_json = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, runId);
  }

  async failLiveSyncRun(
    runId: string,
    code: string,
    message: string,
    totals: LiveSyncTotals = emptyLiveTotals(),
    warningCount = 0
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE live_sync_runs
         SET status = 'failed', finished_at = ?, totals_json = ?, warning_count = ?, error_code = ?, error_message = ?
         WHERE id = ?`
      )
      .run(currentIso(), stringifyJson(totals), warningCount, code, message.slice(0, 500), runId);
  }

  async upsertLiveCheckpoint(checkpoint: LiveChatCheckpointRecord): Promise<void> {
    const chatId = checkpoint.chatId ?? this.getChatIds([checkpoint.chatSourceId]).get(checkpoint.chatSourceId) ?? null;
    this.db
      .prepare(
        `INSERT INTO live_chat_checkpoints
         (chat_source_id, chat_id, latest_archived_message_key, latest_archived_at_ms, earliest_archived_message_key,
          earliest_archived_at_ms, latest_live_message_key, latest_live_at_ms, oldest_verified_message_key,
          oldest_verified_at_ms, health, retry_count, next_recovery_at, last_audit_at, raw_metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_source_id) DO UPDATE SET
           chat_id = COALESCE(excluded.chat_id, live_chat_checkpoints.chat_id),
           latest_archived_message_key = excluded.latest_archived_message_key,
           latest_archived_at_ms = excluded.latest_archived_at_ms,
           earliest_archived_message_key = excluded.earliest_archived_message_key,
           earliest_archived_at_ms = excluded.earliest_archived_at_ms,
           latest_live_message_key = excluded.latest_live_message_key,
           latest_live_at_ms = excluded.latest_live_at_ms,
           oldest_verified_message_key = excluded.oldest_verified_message_key,
           oldest_verified_at_ms = excluded.oldest_verified_at_ms,
           health = excluded.health,
           retry_count = excluded.retry_count,
           next_recovery_at = excluded.next_recovery_at,
           last_audit_at = excluded.last_audit_at,
           raw_metadata_json = excluded.raw_metadata_json,
           updated_at = excluded.updated_at`
      )
      .run(
        checkpoint.chatSourceId,
        chatId,
        checkpoint.latestArchivedMessageKey ?? null,
        checkpoint.latestArchivedAtMs ?? null,
        checkpoint.earliestArchivedMessageKey ?? null,
        checkpoint.earliestArchivedAtMs ?? null,
        checkpoint.latestLiveMessageKey ?? null,
        checkpoint.latestLiveAtMs ?? null,
        checkpoint.oldestVerifiedMessageKey ?? null,
        checkpoint.oldestVerifiedAtMs ?? null,
        checkpoint.health,
        checkpoint.retryCount,
        checkpoint.nextRecoveryAt ?? null,
        checkpoint.lastAuditAt ?? null,
        stringifyJson(checkpoint.rawMetadata ?? null),
        currentIso()
      );
  }

  async listLiveCheckpoints(chatSourceIds?: string[]): Promise<LiveChatCheckpointRecord[]> {
    const unique = chatSourceIds ? [...new Set(chatSourceIds)].filter(Boolean) : null;
    if (unique && unique.length === 0) {
      return [];
    }
    const where = unique ? `WHERE chat_source_id IN (${unique.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM live_chat_checkpoints ${where} ORDER BY updated_at DESC`)
      .all(...(unique ?? [])) as SqliteLiveCheckpointRow[];
    return rows.map(rowToLiveCheckpoint);
  }

  async listChatSyncStates(chatSourceIds?: string[]): Promise<ChatSyncStateRecord[]> {
    const unique = chatSourceIds ? [...new Set(chatSourceIds)].filter(Boolean) : null;
    if (unique && unique.length === 0) {
      return [];
    }
    const where = unique ? `WHERE chats.source_chat_id IN (${unique.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `SELECT chats.source_chat_id,
                chats.platform_recency_ms,
                latest.timestamp_ms AS latest_at_ms,
                latest.source_message_id AS latest_message_id,
                earliest.timestamp_ms AS earliest_at_ms,
                earliest.source_message_id AS earliest_message_id
         FROM chats
         LEFT JOIN (
           SELECT chat_id, timestamp_ms, source_message_id,
                  ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp_ms DESC, id DESC) AS rn
           FROM messages
         ) latest ON latest.chat_id = chats.id AND latest.rn = 1
         LEFT JOIN (
           SELECT chat_id, timestamp_ms, source_message_id,
                  ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp_ms ASC, id ASC) AS rn
           FROM messages
         ) earliest ON earliest.chat_id = chats.id AND earliest.rn = 1
         ${where}`
      )
      .all(...(unique ?? [])) as Array<{
      source_chat_id: string;
      platform_recency_ms: number | null;
      latest_at_ms: number | null;
      latest_message_id: string | null;
      earliest_at_ms: number | null;
      earliest_message_id: string | null;
    }>;
    return rows.map((row) => ({
      chatSourceId: row.source_chat_id,
      latestArchivedAtMs: row.latest_at_ms == null ? null : Number(row.latest_at_ms),
      latestArchivedMessageId: row.latest_message_id ?? null,
      earliestArchivedAtMs: row.earliest_at_ms == null ? null : Number(row.earliest_at_ms),
      earliestArchivedMessageId: row.earliest_message_id ?? null,
      platformRecencyMs: row.platform_recency_ms == null ? null : Number(row.platform_recency_ms)
    }));
  }

  async getRecoveryAnchor(chatSourceId: string, afterMs: number | null): Promise<RecoveryAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT m.source_message_id, m.timestamp_ms, m.from_me, m.sender_source_jid
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE c.source_chat_id = ?
           AND m.timestamp_ms IS NOT NULL
           AND (? IS NULL OR m.timestamp_ms > ?)
         ORDER BY m.timestamp_ms ASC, m.id ASC
         LIMIT 1`
      )
      .get(chatSourceId, afterMs ?? null, afterMs ?? null) as
      | { source_message_id: string; timestamp_ms: number; from_me: number | null; sender_source_jid: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      sourceMessageId: row.source_message_id,
      timestampMs: Number(row.timestamp_ms),
      fromMe: row.from_me == null ? null : Boolean(row.from_me),
      senderSourceJid: row.sender_source_jid ?? null
    };
  }

  async upsertLiveGap(gap: LiveGapWindowRecord): Promise<number> {
    const chatId = gap.chatId ?? this.getChatIds([gap.chatSourceId]).get(gap.chatSourceId) ?? null;
    if (gap.id) {
      this.db
        .prepare(
          `UPDATE live_gap_windows
           SET chat_source_id = ?, chat_id = ?, reason = ?, status = ?, start_at_ms = ?, end_at_ms = ?,
               required_lower_bound_at_ms = ?, anchor_message_key = ?, request_count = ?, last_attempt_at = ?,
               confidence = ?, notes = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          gap.chatSourceId,
          chatId,
          gap.reason,
          gap.status,
          gap.startAtMs ?? null,
          gap.endAtMs ?? null,
          gap.requiredLowerBoundAtMs ?? null,
          gap.anchorMessageKey ?? null,
          gap.requestCount,
          gap.lastAttemptAt ?? null,
          gap.confidence,
          gap.notes ?? null,
          currentIso(),
          gap.id
        );
      return gap.id;
    }
    const result = this.db
      .prepare(
        `INSERT INTO live_gap_windows
         (chat_source_id, chat_id, reason, status, start_at_ms, end_at_ms, required_lower_bound_at_ms,
          anchor_message_key, request_count, last_attempt_at, confidence, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        gap.chatSourceId,
        chatId,
        gap.reason,
        gap.status,
        gap.startAtMs ?? null,
        gap.endAtMs ?? null,
        gap.requiredLowerBoundAtMs ?? null,
        gap.anchorMessageKey ?? null,
        gap.requestCount,
        gap.lastAttemptAt ?? null,
        gap.confidence,
        gap.notes ?? null,
        currentIso()
      );
    return Number(result.lastInsertRowid);
  }

  async updateLiveGapStatus(id: number, status: LiveGapStatus, notes?: string | null): Promise<void> {
    this.db
      .prepare(`UPDATE live_gap_windows SET status = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`)
      .run(status, notes ?? null, currentIso(), id);
  }

  async listLiveGaps(statuses?: LiveGapStatus[]): Promise<LiveGapWindowRecord[]> {
    const where = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM live_gap_windows ${where} ORDER BY updated_at DESC`)
      .all(...(statuses ?? [])) as SqliteLiveGapRow[];
    return rows.map(rowToLiveGap);
  }

  async recordLiveEventReceipt(receipt: LiveEventReceiptRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO live_event_receipts
         (event_key, event_type, chat_source_id, message_key, occurred_at_ms, processed_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_key) DO UPDATE SET processed_at = excluded.processed_at`
      )
      .run(
        receipt.eventKey,
        receipt.eventType,
        receipt.chatSourceId ?? null,
        receipt.messageKey ?? null,
        receipt.occurredAtMs ?? null,
        receipt.processedAt ?? currentIso(),
        stringifyJson(receipt.metadata ?? null)
      );
  }

  async hasLiveEventReceipt(eventKey: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT 1 AS found FROM live_event_receipts WHERE event_key = ?`).get(eventKey) as { found: number } | undefined;
    return Boolean(row);
  }

  async applyLiveMessageUpdates(rawUpdates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult> {
    this.assertWritableIdentityVersion();
    // Updates may target a LID-form chat; canonicalize and re-derive the key.
    const updates = rawUpdates.map((update) => {
      const chatSourceId = this.canonicalJid(update.chatSourceId) ?? update.chatSourceId;
      const targetId = messageIdFromKey(update.sourceMessageKey);
      return {
        ...update,
        chatSourceId,
        sourceMessageKey: targetId ? messageKey(chatSourceId, targetId) : update.sourceMessageKey
      };
    });
    let applied = 0;
    let pending = 0;
    const insert = this.db.prepare(
      `INSERT INTO live_message_updates
       (event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO UPDATE SET
         applied = MAX(live_message_updates.applied, excluded.applied),
         metadata_json = COALESCE(excluded.metadata_json, live_message_updates.metadata_json),
         updated_at = excluded.updated_at`
    );
    // Deletion tombstones only: held body/caption (and stored media) stay —
    // the archive is a backup store, and blanking captured content would
    // silently destroy it. The "Deleted message" placeholder appears only when
    // nothing was ever captured.
    const markDeleted = this.db.prepare(
      `UPDATE messages
       SET is_deleted = 1,
           raw_metadata_json = COALESCE(raw_metadata_json, ?)
       WHERE source_message_key = ?`
    );
    const applyEdit = this.db.prepare(
      `UPDATE messages
       SET body = ?,
           raw_metadata_json = json_set(COALESCE(raw_metadata_json, '{}'), '$.edited', 1)
       WHERE source_message_key = ?`
    );
    // Edit history: snapshot the current content as a retained revision before
    // the edit overwrites it, so pre-edit text is never lost.
    const readCurrentContent = this.db.prepare(`SELECT body, caption FROM messages WHERE source_message_key = ?`);
    const nextRevisionIndex = this.db.prepare(
      `SELECT COALESCE(MAX(revision_index), -1) + 1 AS next FROM message_edit_revisions WHERE message_key = ?`
    );
    const insertRevision = this.db.prepare(
      `INSERT INTO message_edit_revisions (message_key, revision_index, body, caption, edited_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_key, revision_index) DO NOTHING`
    );
    const readMetadata = this.db.prepare(`SELECT raw_metadata_json FROM messages WHERE source_message_key = ?`);
    const writeMetadata = this.db.prepare(`UPDATE messages SET raw_metadata_json = ? WHERE source_message_key = ?`);
    const exists = this.db.prepare(`SELECT 1 AS found FROM messages WHERE source_message_key = ?`);
    // Update targets may have been archived from backup (different key format) or
    // with a different participant/fromMe composition; fall back to matching by
    // chat + WhatsApp message id, which is stable across sources.
    const fallbackKey = this.db.prepare(
      `SELECT m.source_message_key AS key
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.source_chat_id = ? AND m.source_message_id = ?
       LIMIT 1`
    );
    const editedKeys: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const update of updates) {
        let targetKey: string | null = update.sourceMessageKey;
        if (!exists.get(targetKey)) {
          const messageId = messageIdFromKey(update.sourceMessageKey);
          const fallback = messageId ? (fallbackKey.get(update.chatSourceId, messageId) as { key: string } | undefined) : undefined;
          targetKey = fallback?.key ?? null;
        }
        const hasBase = Boolean(targetKey);
        if (targetKey) {
          if (update.updateType === "delete") {
            markDeleted.run(stringifyJson({ liveUpdate: "delete" }), targetKey);
          }
          if (update.updateType === "edit" && typeof update.metadata?.body === "string") {
            const current = readCurrentContent.get(targetKey) as { body: string | null; caption: string | null } | undefined;
            // Snapshot only real content changes; replayed identical edits and
            // empty originals produce no fabricated revision.
            if (current && current.body != null && current.body !== update.metadata.body) {
              const next = (nextRevisionIndex.get(targetKey) as { next: number }).next;
              insertRevision.run(targetKey, Number(next), current.body, current.caption, update.occurredAtMs ?? null);
            }
            applyEdit.run(update.metadata.body, targetKey);
            editedKeys.push(targetKey);
          }
          if (update.updateType === "poll_vote" || update.updateType === "event_response") {
            const row = readMetadata.get(targetKey) as { raw_metadata_json: string | null } | undefined;
            const metadata = (parseJson(row?.raw_metadata_json ?? null) as Record<string, unknown> | null) ?? {};
            const merged = mergeInteractionMetadata(metadata, update);
            if (merged) {
              writeMetadata.run(stringifyJson(merged), targetKey);
            }
          }
          applied += 1;
        } else {
          pending += 1;
        }
        insert.run(
          update.eventKey,
          update.chatSourceId,
          update.sourceMessageKey,
          update.updateType,
          update.occurredAtMs ?? null,
          Number(hasBase),
          stringifyJson(update.metadata ?? null),
          currentIso()
        );
      }
      // Edits changed stored body: bring derived search text and mentions back
      // in line with the final content inside the same transaction.
      if (editedKeys.length > 0) {
        const editedIds: number[] = [];
        const lookup = this.db.prepare(`SELECT id FROM messages WHERE source_message_key = ?`);
        for (const key of new Set(editedKeys)) {
          const row = lookup.get(key) as { id: number } | undefined;
          if (row) {
            editedIds.push(Number(row.id));
          }
        }
        this.syncMessageDerivedState(editedIds);
      }
    });
    transaction();
    return { applied, pending };
  }

  async recordMessageSecrets(secrets: MessageSecretRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (secrets.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO message_secrets (message_key, chat_source_id, source_message_id, secret, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO NOTHING`
    );
    let recorded = 0;
    const transaction = this.db.transaction(() => {
      for (const entry of secrets) {
        const chatSourceId = this.canonicalJid(entry.chatSourceId) ?? entry.chatSourceId;
        if (!chatSourceId || !entry.sourceMessageId || entry.secret.length === 0) {
          continue;
        }
        const result = insert.run(
          messageKey(chatSourceId, entry.sourceMessageId),
          chatSourceId,
          entry.sourceMessageId,
          Buffer.from(entry.secret),
          entry.source
        );
        recorded += result.changes;
      }
    });
    transaction();
    return recorded;
  }

  async getMessageSecret(chatSourceId: string, sourceMessageId: string): Promise<Uint8Array | null> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    const row = this.db
      .prepare(`SELECT secret FROM message_secrets WHERE message_key = ?`)
      .get(messageKey(canonical, sourceMessageId)) as { secret: Buffer } | undefined;
    return row?.secret ?? null;
  }

  async countMessageSecrets(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM message_secrets`).get() as { n: number };
    return Number(row.n ?? 0);
  }

  async retainEncryptedPayloads(payloads: RetainedPayloadRecord[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (payloads.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO retained_encrypted_payloads
       (event_key, target_message_key, chat_source_id, target_message_id, kind, actor_jid, enc_payload, enc_iv, occurred_at_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO NOTHING`
    );
    let retained = 0;
    const transaction = this.db.transaction(() => {
      for (const payload of payloads) {
        const chatSourceId = this.canonicalJid(payload.chatSourceId) ?? payload.chatSourceId;
        if (!chatSourceId || !payload.targetMessageId || payload.encPayload.length === 0) {
          continue;
        }
        const result = insert.run(
          payload.eventKey,
          messageKey(chatSourceId, payload.targetMessageId),
          chatSourceId,
          payload.targetMessageId,
          payload.kind,
          payload.actorJid ?? null,
          Buffer.from(payload.encPayload),
          payload.encIv ? Buffer.from(payload.encIv) : null,
          payload.occurredAtMs ?? null,
          stringifyJson(payload.metadata ?? null)
        );
        retained += result.changes;
      }
    });
    transaction();
    return retained;
  }

  async listRetainedEncryptedPayloads(limit = 500): Promise<RetainedPayloadRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, event_key, chat_source_id, target_message_id, kind, actor_jid, enc_payload, enc_iv, occurred_at_ms, metadata_json
         FROM retained_encrypted_payloads
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{
      id: number;
      event_key: string;
      chat_source_id: string;
      target_message_id: string;
      kind: RetainedPayloadRecord["kind"];
      actor_jid: string | null;
      enc_payload: Buffer;
      enc_iv: Buffer | null;
      occurred_at_ms: number | null;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      eventKey: row.event_key,
      chatSourceId: row.chat_source_id,
      targetMessageId: row.target_message_id,
      kind: row.kind,
      actorJid: row.actor_jid,
      encPayload: row.enc_payload,
      encIv: row.enc_iv,
      occurredAtMs: row.occurred_at_ms == null ? null : Number(row.occurred_at_ms),
      metadata: (parseJson(row.metadata_json) as Record<string, unknown> | null) ?? null
    }));
  }

  async deleteRetainedEncryptedPayload(id: number): Promise<void> {
    this.db.prepare(`DELETE FROM retained_encrypted_payloads WHERE id = ?`).run(id);
  }

  async getMessageInterpretationContext(
    chatSourceId: string,
    sourceMessageId: string
  ): Promise<{ senderSourceJid: string | null; fromMe: boolean | null; rawMetadata: Record<string, unknown> | null } | null> {
    const canonical = this.canonicalJid(chatSourceId) ?? chatSourceId;
    const row = this.db
      .prepare(
        `SELECT m.sender_source_jid, m.from_me, m.raw_metadata_json
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE c.source_chat_id = ? AND m.source_message_id = ?
         LIMIT 1`
      )
      .get(canonical, sourceMessageId) as
      | { sender_source_jid: string | null; from_me: number | null; raw_metadata_json: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      senderSourceJid: row.sender_source_jid,
      fromMe: row.from_me == null ? null : Boolean(row.from_me),
      rawMetadata: (parseJson(row.raw_metadata_json) as Record<string, unknown> | null) ?? null
    };
  }

  async enqueueMediaDownloads(
    items: Array<Pick<MediaDownloadQueueRecord, "messageKey" | "chatSourceId" | "sourceMessageId" | "descriptor" | "thumbnail" | "isViewOnce" | "priority">>
  ): Promise<number> {
    this.assertWritableIdentityVersion();
    if (items.length === 0) {
      return 0;
    }
    // First capture wins; a re-delivered message must not restart a stored or
    // terminal download, but may raise priority of a still-pending one.
    const insert = this.db.prepare(
      `INSERT INTO media_download_queue
       (message_key, chat_source_id, source_message_id, descriptor_json, thumbnail, is_view_once, status, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(message_key) DO UPDATE SET
         priority = MAX(media_download_queue.priority, excluded.priority),
         updated_at = excluded.updated_at
       WHERE media_download_queue.status IN ('pending','retry')`
    );
    let enqueued = 0;
    const transaction = this.db.transaction(() => {
      for (const item of items) {
        const chatSourceId = this.canonicalJid(item.chatSourceId) ?? item.chatSourceId;
        if (!chatSourceId || !item.sourceMessageId) {
          continue;
        }
        const result = insert.run(
          messageKey(chatSourceId, item.sourceMessageId),
          chatSourceId,
          item.sourceMessageId,
          JSON.stringify(item.descriptor),
          item.thumbnail?.length ? Buffer.from(item.thumbnail) : null,
          Number(item.isViewOnce),
          item.priority,
          currentIso()
        );
        enqueued += result.changes;
      }
    });
    transaction();
    return enqueued;
  }

  async claimDueMediaDownloads(limit: number, nowMs = Date.now()): Promise<MediaDownloadQueueRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, message_key, chat_source_id, source_message_id, descriptor_json, thumbnail, is_view_once,
                status, attempts, reupload_attempts, next_attempt_at_ms, last_error, priority
         FROM media_download_queue
         WHERE status IN ('pending','retry') AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
         ORDER BY priority DESC, id ASC
         LIMIT ?`
      )
      .all(nowMs, Math.max(1, limit)) as SqliteMediaQueueRow[];
    if (rows.length === 0) {
      return [];
    }
    const claim = this.db.prepare(`UPDATE media_download_queue SET status = 'downloading', updated_at = ? WHERE id = ?`);
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        claim.run(currentIso(), row.id);
      }
    });
    transaction();
    return rows.map(rowToMediaQueueRecord).filter((record): record is MediaDownloadQueueRecord => record !== null);
  }

  async completeMediaDownload(queueId: number, asset: MediaAssetRecord): Promise<number> {
    let assetId = 0;
    const transaction = this.db.transaction(() => {
      assetId = this.upsertMediaAssetRow(asset);
      // Stored is terminal: the descriptor (and its copy of the media key) has
      // served its purpose and is dropped from the row.
      this.db
        .prepare(
          `UPDATE media_download_queue
           SET status = 'stored', descriptor_json = NULL, thumbnail = NULL, last_error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(currentIso(), queueId);
    });
    transaction();
    return assetId;
  }

  async markMediaDownloadRetry(queueId: number, error: string, nextAttemptAtMs: number, options: { countReupload?: boolean } = {}): Promise<void> {
    this.db
      .prepare(
        `UPDATE media_download_queue
         SET status = 'retry', attempts = attempts + 1, reupload_attempts = reupload_attempts + ?,
             next_attempt_at_ms = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(options.countReupload ? 1 : 0, nextAttemptAtMs, error.slice(0, 300), currentIso(), queueId);
  }

  async markMediaDownloadTerminal(queueId: number, status: "expired_unrecoverable" | "failed", error: string | null): Promise<void> {
    this.db
      .prepare(
        `UPDATE media_download_queue
         SET status = ?, descriptor_json = NULL, thumbnail = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, error ? error.slice(0, 300) : null, currentIso(), queueId);
  }

  async linkMediaAsset(asset: MediaAssetRecord): Promise<number> {
    this.assertWritableIdentityVersion();
    return this.upsertMediaAssetRow(asset);
  }

  private upsertMediaAssetRow(asset: MediaAssetRecord): number {
    const chatSourceId = this.canonicalJid(asset.chatSourceId) ?? asset.chatSourceId;
    this.db
      .prepare(
        `INSERT INTO media_assets
         (message_key, chat_source_id, sha256, storage_path, mime_type, byte_size, width, height, duration_ms, thumbnail, source, is_view_once)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_key, sha256) DO UPDATE SET
           mime_type = COALESCE(media_assets.mime_type, excluded.mime_type),
           width = COALESCE(media_assets.width, excluded.width),
           height = COALESCE(media_assets.height, excluded.height),
           duration_ms = COALESCE(media_assets.duration_ms, excluded.duration_ms),
           thumbnail = COALESCE(media_assets.thumbnail, excluded.thumbnail),
           is_view_once = MAX(media_assets.is_view_once, excluded.is_view_once)`
      )
      .run(
        asset.messageKey,
        chatSourceId,
        asset.sha256,
        asset.storagePath,
        asset.mimeType ?? null,
        asset.byteSize,
        asset.width ?? null,
        asset.height ?? null,
        asset.durationMs ?? null,
        asset.thumbnail?.length ? Buffer.from(asset.thumbnail) : null,
        asset.source,
        Number(asset.isViewOnce)
      );
    const row = this.db
      .prepare(`SELECT id FROM media_assets WHERE message_key = ? AND sha256 = ?`)
      .get(asset.messageKey, asset.sha256) as { id: number };
    return Number(row.id);
  }

  async getMediaAsset(assetId: number): Promise<MediaAssetRecord | null> {
    const row = this.db.prepare(`SELECT * FROM media_assets WHERE id = ?`).get(assetId) as SqliteMediaAssetRow | undefined;
    return row ? rowToMediaAsset(row) : null;
  }

  async getMediaAssetForMessage(messageId: number): Promise<MediaAssetRecord | null> {
    const row = this.db
      .prepare(
        `SELECT a.* FROM media_assets a
         JOIN messages m ON m.source_message_key = a.message_key
         WHERE m.id = ?
         ORDER BY a.id ASC
         LIMIT 1`
      )
      .get(messageId) as SqliteMediaAssetRow | undefined;
    return row ? rowToMediaAsset(row) : null;
  }

  async getMediaQueueSummary(): Promise<MediaQueueSummary> {
    const counts = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM media_download_queue GROUP BY status`)
      .all() as Array<{ status: MediaDownloadStatus; n: number }>;
    const byStatus = new Map(counts.map((row) => [row.status, Number(row.n)]));
    const assets = this.db.prepare(`SELECT COUNT(*) AS n FROM media_assets`).get() as { n: number };
    return {
      assets: Number(assets.n ?? 0),
      pending: byStatus.get("pending") ?? 0,
      downloading: byStatus.get("downloading") ?? 0,
      retry: byStatus.get("retry") ?? 0,
      stored: byStatus.get("stored") ?? 0,
      failed: byStatus.get("failed") ?? 0,
      expiredUnrecoverable: byStatus.get("expired_unrecoverable") ?? 0
    };
  }

  async retryStuckMediaDownloads(): Promise<number> {
    // Terminal rows whose descriptor was already dropped cannot be retried —
    // only rows still holding a descriptor go back to pending.
    const result = this.db
      .prepare(
        `UPDATE media_download_queue
         SET status = 'pending', attempts = 0, reupload_attempts = 0, next_attempt_at_ms = NULL, updated_at = ?
         WHERE status IN ('failed','expired_unrecoverable','retry') AND descriptor_json IS NOT NULL`
      )
      .run(currentIso());
    return result.changes;
  }

  async resetInFlightMediaDownloads(): Promise<number> {
    const result = this.db
      .prepare(`UPDATE media_download_queue SET status = 'pending', updated_at = ? WHERE status = 'downloading'`)
      .run(currentIso());
    return result.changes;
  }

  async recordLinkPreviews(previews: CapturedLinkPreview[]): Promise<number> {
    this.assertWritableIdentityVersion();
    if (previews.length === 0) {
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO message_link_previews (message_key, chat_source_id, title, description, canonical_url, thumbnail)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO NOTHING`
    );
    let recorded = 0;
    const transaction = this.db.transaction(() => {
      for (const preview of previews) {
        const chatSourceId = this.canonicalJid(preview.chatSourceId) ?? preview.chatSourceId;
        if (!chatSourceId || !preview.sourceMessageId) {
          continue;
        }
        const result = insert.run(
          messageKey(chatSourceId, preview.sourceMessageId),
          chatSourceId,
          preview.title ?? null,
          preview.description ?? null,
          preview.canonicalUrl ?? null,
          preview.thumbnail?.length ? Buffer.from(preview.thumbnail) : null
        );
        recorded += result.changes;
      }
    });
    transaction();
    return recorded;
  }

  async getLinkPreviewThumbnail(messageId: number): Promise<Uint8Array | null> {
    const row = this.db
      .prepare(
        `SELECT p.thumbnail FROM message_link_previews p
         JOIN messages m ON m.source_message_key = p.message_key
         WHERE m.id = ?`
      )
      .get(messageId) as { thumbnail: Buffer | null } | undefined;
    return row?.thumbnail ?? null;
  }

  async listMessageEditRevisions(messageId: number): Promise<MessageEditRevisionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.message_key, r.revision_index, r.body, r.caption, r.edited_at_ms, r.created_at
         FROM message_edit_revisions r
         JOIN messages m ON m.source_message_key = r.message_key
         WHERE m.id = ?
         ORDER BY r.revision_index ASC`
      )
      .all(messageId) as Array<{
      id: number;
      message_key: string;
      revision_index: number;
      body: string | null;
      caption: string | null;
      edited_at_ms: number | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      messageKey: row.message_key,
      revisionIndex: Number(row.revision_index),
      body: row.body,
      caption: row.caption,
      editedAtMs: nullableNumber(row.edited_at_ms),
      createdAt: row.created_at
    }));
  }

  async listPendingLiveMessageUpdates(limit = 500): Promise<LiveMessageUpdateRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json
         FROM live_message_updates
         WHERE applied = 0
         ORDER BY updated_at ASC
         LIMIT ?`
      )
      .all(Math.max(1, limit)) as Array<{
      event_key: string;
      chat_source_id: string;
      source_message_key: string;
      update_type: LiveMessageUpdateRecord["updateType"];
      occurred_at_ms: number | null;
      applied: number;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      eventKey: row.event_key,
      chatSourceId: row.chat_source_id,
      sourceMessageKey: row.source_message_key,
      updateType: row.update_type,
      occurredAtMs: row.occurred_at_ms == null ? null : Number(row.occurred_at_ms),
      applied: Boolean(row.applied),
      metadata: (parseJson(row.metadata_json) as Record<string, unknown> | null) ?? null
    }));
  }

  async reconcileLiveState(): Promise<{ staleSessions: number; staleRuns: number }> {
    const now = currentIso();
    // Media downloads claimed by a previous process resume from pending; the
    // atomic blob write guarantees no partial file registered as stored.
    await this.resetInFlightMediaDownloads();
    const sessions = this.db
      .prepare(
        `UPDATE live_sessions
         SET status = 'stopped', last_error = NULL, updated_at = ?
         WHERE status IN ('connected','pairing')`
      )
      .run(now);
    const runs = this.db
      .prepare(
        `UPDATE live_sync_runs
         SET status = 'failed', finished_at = ?, error_code = 'INTERRUPTED_BY_RESTART',
             error_message = 'Live sync run was interrupted by a process restart.'
         WHERE status = 'running'`
      )
      .run(now);
    return { staleSessions: sessions.changes, staleRuns: runs.changes };
  }

  async getLiveStatus(): Promise<LiveMaintainerStatusSummary> {
    const sessionRow = this.db
      .prepare(`SELECT * FROM live_sessions ORDER BY updated_at DESC LIMIT 1`)
      .get() as SqliteLiveSessionRow | undefined;
    const currentRunRow = this.db
      .prepare(`SELECT * FROM live_sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
      .get() as SqliteLiveRunRow | undefined;
    const openGaps = await this.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);
    const gapGroupRows = this.db
      .prepare(
        `SELECT status, reason, COUNT(*) AS count
         FROM live_gap_windows
         WHERE status IN ('open','retrying','uncertain','needs_user_action')
         GROUP BY status, reason
         ORDER BY count DESC`
      )
      .all() as Array<{ status: LiveGapStatus; reason: LiveGapReason; count: number }>;
    const identityHealth = await this.getIdentityHealth();
    const healthRows = this.db
      .prepare(
        `SELECT c.chat_source_id, chats.display_name, c.health, c.latest_archived_at_ms, c.latest_live_at_ms,
                c.oldest_verified_at_ms, c.next_recovery_at,
                (SELECT COUNT(*) FROM live_gap_windows g
                 WHERE g.chat_source_id = c.chat_source_id
                   AND g.status IN ('open','retrying','uncertain','needs_user_action')) AS open_gap_count
         FROM live_chat_checkpoints c
         LEFT JOIN chats ON chats.source_chat_id = c.chat_source_id
         ORDER BY open_gap_count DESC, c.updated_at DESC
         LIMIT 20`
      )
      .all() as SqliteLiveHealthRow[];
    return {
      enabled: Boolean(sessionRow),
      baseline: baselineFromStatus(await this.getStatusWithoutLive(), this.getLatestArchiveMessageAt(), config.live.maxBackfillPerChatDays),
      session: sessionRow ? rowToLiveSession(sessionRow) : null,
      currentRun: currentRunRow ? rowToLiveRun(currentRunRow) : null,
      totals: currentRunRow ? totalsOrEmptyLive(parseJson(currentRunRow.totals_json) as LiveSyncTotals | null) : emptyLiveTotals(),
      openGapCount: openGaps.length,
      gapGroups: gapGroupRows.map((row) => ({ status: row.status, reason: row.reason, count: Number(row.count) })),
      identityHealth,
      chatHealth: healthRows.map((row) => ({
        chatSourceId: row.chat_source_id,
        chatDisplayName: row.display_name ?? null,
        health: row.health as LiveHealthState,
        latestArchivedAt: isoFromMs(row.latest_archived_at_ms),
        latestLiveAt: isoFromMs(row.latest_live_at_ms),
        oldestVerifiedAt: isoFromMs(row.oldest_verified_at_ms),
        openGapCount: Number(row.open_gap_count ?? 0),
        nextRecoveryAt: row.next_recovery_at ?? null
      })),
      media: await this.getMediaQueueSummary()
    };
  }

  private async getStatusWithoutLive(): Promise<StatusSummary> {
    if (!this.isInitialized()) {
      return emptyStatus(false);
    }
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM chats) AS chats,
          (SELECT COUNT(*) FROM contacts) AS contacts,
          (SELECT COUNT(*) FROM chat_participants) AS participants,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM import_warnings) AS warnings`
      )
      .get() as Record<string, number>;
    const latestRun = this.db
      .prepare(
        `SELECT id, status, started_at, finished_at, totals_json, warning_count, error_message
         FROM import_runs
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get() as SqliteImportRunRow | undefined;
    const latestImport = latestRun ? rowToImportSummary(latestRun) : null;
    const latestWarnings = latestImport ? this.getLatestWarnings(latestImport.id) : [];
    return {
      database: {
        configured: true,
        initialized: true,
        adapter: "sqlite",
        location: path.basename(this.dbPath),
        ...(this.legacyArchive ? { error: LEGACY_ARCHIVE_MESSAGE } : {})
      },
      counts: {
        chats: Number(counts.chats ?? 0),
        contacts: Number(counts.contacts ?? 0),
        participants: Number(counts.participants ?? 0),
        messages: Number(counts.messages ?? 0),
        warnings: Number(counts.warnings ?? 0)
      },
      latestImport,
      latestWarnings
    };
  }

  private getLatestArchiveMessageAt(): string | null {
    const row = this.db
      .prepare(
        `SELECT sent_at
         FROM messages
         WHERE timestamp_ms IS NOT NULL
         ORDER BY timestamp_ms DESC, id DESC
         LIMIT 1`
      )
      .get() as { sent_at: string | null } | undefined;
    return row?.sent_at ?? null;
  }

  async listChats(options: ChatListOptions): Promise<ChatListItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.search) {
      // Users search what they see: phone-fallback labels ("+1555...") must
      // match jids by their digits.
      const digits = options.search.replace(/\D/g, "");
      if (digits.length >= 4) {
        where.push("(display_name LIKE ? OR jid LIKE ? OR jid LIKE ?)");
        params.push(`%${options.search}%`, `%${options.search}%`, `%${digits}%`);
      } else {
        where.push("(display_name LIKE ? OR jid LIKE ?)");
        params.push(`%${options.search}%`, `%${options.search}%`);
      }
    }
    if (options.type && options.type !== "all") {
      where.push("chat_type = ?");
      params.push(options.type);
    }
    if (!options.includeEventOnly) {
      where.push(`EXISTS (
        SELECT 1
        FROM messages visible_messages
        WHERE visible_messages.chat_id = chats.id
          AND ${visibleExchangePredicate("visible_messages")}
      )`);
    }
    params.push(options.limit, options.offset);
    const rows = this.db
      .prepare(
        `SELECT id, source_chat_id, jid, NULLIF(TRIM(COALESCE(display_name, '')), '') AS display_name, chat_type,
                message_count, participant_count, last_message_at
         FROM chats
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY last_message_at_ms IS NULL, last_message_at_ms DESC, display_name ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params) as SqliteChatRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      sourceChatId: row.source_chat_id,
      jid: row.jid,
      // Name, else phone number, never a raw identifier; NULL means unresolved
      // and the client renders an explicit state.
      displayName: row.display_name && row.display_name !== row.jid ? row.display_name : displayPhoneFromJid(row.jid),
      chatType: row.chat_type as ChatListItem["chatType"],
      messageCount: Number(row.message_count ?? 0),
      participantCount: Number(row.participant_count ?? 0),
      lastMessageAt: row.last_message_at ?? null
    }));
  }

  async listMessages(
    chatId: number,
    options: { limit: number; offset: number; sender?: string; query?: string; order?: "asc" | "desc" }
  ): Promise<MessageListItem[]> {
    const where = ["m.chat_id = ?"];
    const params: unknown[] = [chatId];
    if (options.sender) {
      where.push("(m.sender_source_jid = ? OR c.display_name LIKE ?)");
      params.push(options.sender, `%${options.sender}%`);
    }
    if (options.query) {
      where.push("(m.body LIKE ? OR m.caption LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    params.push(options.limit, options.offset);
    const orderDirection = options.order === "desc" ? "DESC" : "ASC";
    // Legacy rows may carry the group's own JID as the sender (pre-fix history
    // sync); those senders are unknown, never "the group".
    const chat = this.db.prepare(`SELECT source_chat_id, chat_type FROM chats WHERE id = ?`).get(chatId) as
      | { source_chat_id: string; chat_type: string }
      | undefined;
    const rows = this.db
      .prepare(
        messageListSelectSql(
          `WHERE ${where.join(" AND ")}`,
          `ORDER BY m.timestamp_ms ${orderDirection}, m.id ${orderDirection}`,
          `LIMIT ? OFFSET ?`
        )
      )
      .all(...params) as SqliteMessageRow[];
    return this.mapMessageRows(rows, chat);
  }

  async listMessagesAround(chatId: number, messageId: number, radius: number): Promise<MessageContextWindow | null> {
    const anchor = this.db
      .prepare(`SELECT id, timestamp_ms FROM messages WHERE id = ? AND chat_id = ?`)
      .get(messageId, chatId) as { id: number; timestamp_ms: number | null } | undefined;
    if (!anchor) {
      return null;
    }
    const chat = this.db.prepare(`SELECT source_chat_id, chat_type FROM chats WHERE id = ?`).get(chatId) as
      | { source_chat_id: string; chat_type: string }
      | undefined;
    const anchorTs = anchor.timestamp_ms ?? 0;
    const newerPredicate = `m.chat_id = ? AND (COALESCE(m.timestamp_ms, 0) > ? OR (COALESCE(m.timestamp_ms, 0) = ? AND m.id > ?))`;
    const olderEqPredicate = `m.chat_id = ? AND (COALESCE(m.timestamp_ms, 0) < ? OR (COALESCE(m.timestamp_ms, 0) = ? AND m.id <= ?))`;
    const predicateParams = [chatId, anchorTs, anchorTs, messageId];
    // Anchor + up to `radius` older rows, and up to `radius` newer rows.
    const olderRows = this.db
      .prepare(messageListSelectSql(`WHERE ${olderEqPredicate}`, `ORDER BY m.timestamp_ms DESC, m.id DESC`, `LIMIT ?`))
      .all(...predicateParams, radius + 1) as SqliteMessageRow[];
    const newerRows = this.db
      .prepare(messageListSelectSql(`WHERE ${newerPredicate}`, `ORDER BY m.timestamp_ms ASC, m.id ASC`, `LIMIT ?`))
      .all(...predicateParams, radius) as SqliteMessageRow[];
    const newerTotal = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${newerPredicate}`).get(...predicateParams) as { count: number }
    ).count;
    // Chronological ascending window: reversed older block, then newer block.
    const rows = [...olderRows.reverse(), ...newerRows];
    return {
      messages: this.mapMessageRows(rows, chat),
      newerCount: Math.max(0, Number(newerTotal) - newerRows.length),
      anchorMessageId: messageId
    };
  }

  // Shared MessageListItem projection for thread pages and context windows.
  private mapMessageRows(
    rows: SqliteMessageRow[],
    chat: { source_chat_id: string; chat_type: string } | undefined
  ): MessageListItem[] {
    const groupSelfSender = chat?.chat_type === "group" ? chat.source_chat_id : null;
    const mentionLabels = this.resolveMentionLabels(rows.flatMap((row) => [row.body, row.caption]));
    return rows.map((row) => {
      const media = deriveMediaSummary(row, row.message_type);
      const hasHeldContent = Boolean(row.body?.trim() || row.caption?.trim() || media?.availability === "stored");
      return {
        id: Number(row.id),
        sourceMessageId: row.source_message_id,
        // Saved name, else push name, else phone number; a raw identifier is
        // never surfaced as the sender label (NULL = unresolved).
        senderDisplayName:
          groupSelfSender && row.sender_source_jid === groupSelfSender
            ? null
            : row.sender_display_name ?? displayPhoneFromJid(row.sender_source_jid),
        senderSourceJid: row.sender_source_jid,
        timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
        sentAt: row.sent_at,
        direction: row.direction as MessageListItem["direction"],
        messageType: row.message_type,
        interpretation: interpretMessage({
          messageType: row.message_type,
          isDeleted: Boolean(row.is_deleted),
          hasHeldContent,
          mediaAvailability: media?.availability ?? null
        }),
        body: applyMentionLabels(row.body, mentionLabels),
        caption: applyMentionLabels(row.caption, mentionLabels),
        mentions: appliedMentionLabels([row.body, row.caption], mentionLabels),
        hasMedia: Boolean(row.has_media),
        mediaMimeType: row.media_mime_type,
        mediaName: row.media_name,
        media,
        linkPreview:
          row.preview_title || row.preview_description || row.preview_url || row.preview_has_thumbnail
            ? {
                title: row.preview_title ?? null,
                description: row.preview_description ?? null,
                canonicalUrl: row.preview_url ?? null,
                hasThumbnail: Boolean(row.preview_has_thumbnail)
              }
            : null,
        isEdited: Boolean(row.edited_flag) || Number(row.edit_revision_count ?? 0) > 0,
        editRevisionCount: Number(row.edit_revision_count ?? 0),
        isDeleted: Boolean(row.is_deleted),
        isForwarded: Boolean(row.is_forwarded),
        isStarred: Boolean(row.is_starred)
      };
    });
  }

  async getMemoryStatus(provider: MemoryProviderStatus): Promise<MemoryStatusSummary> {
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM memory_pages WHERE status = 'current') AS pages,
          (SELECT COUNT(*) FROM memory_pages WHERE status = 'stale') AS stale_pages,
          (SELECT COUNT(*) FROM memory_citations) AS citations`
      )
      .get() as Record<string, number>;
    const latestRun = this.db
      .prepare(`SELECT * FROM memory_runs ORDER BY started_at DESC LIMIT 1`)
      .get() as SqliteMemoryRunRow | undefined;
    const activeRun = this.db
      .prepare(`SELECT * FROM memory_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
      .get() as SqliteMemoryRunRow | undefined;
    return {
      enabled: true,
      rootDir: config.memory.rootDir,
      pageCount: Number(counts.pages ?? 0),
      citationCount: Number(counts.citations ?? 0),
      stalePageCount: Number(counts.stale_pages ?? 0),
      latestRun: latestRun ? rowToMemoryRun(latestRun) : null,
      activeRun: activeRun ? rowToMemoryRun(activeRun) : null,
      latestCommittedAtMs: await this.getLatestCommittedMemoryEndAtMs(),
      provider
    };
  }

  async startMemoryRun(input: {
    kind: MemoryRunSummary["kind"];
    sourceStartAtMs?: number | null;
    sourceEndAtMs?: number | null;
    sourceSummary?: Record<string, unknown> | null;
  }): Promise<string> {
    this.assertWritableIdentityVersion();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_runs
         (id, status, kind, started_at, source_start_at_ms, source_end_at_ms, source_summary_json)
         VALUES (?, 'running', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        currentIso(),
        input.sourceStartAtMs ?? null,
        input.sourceEndAtMs ?? null,
        stringifyJson(input.sourceSummary ?? null)
      );
    return id;
  }

  async completeMemoryRun(runId: string, totals: { pages: number; citations: number; messages: number; warnings: number }): Promise<void> {
    this.db
      .prepare(
        `UPDATE memory_runs
         SET status = 'completed', finished_at = ?, page_count = ?, citation_count = ?, message_count = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(currentIso(), totals.pages, totals.citations, totals.messages, totals.warnings, runId);
  }

  async failMemoryRun(runId: string, status: "failed" | "blocked", message: string, warningCount = 0): Promise<void> {
    this.db
      .prepare(
        `UPDATE memory_runs
         SET status = ?, finished_at = ?, error_message = ?, warning_count = ?
         WHERE id = ?`
      )
      .run(status, currentIso(), message, warningCount, runId);
  }

  async getMemoryRun(runId: string): Promise<MemoryRunSummary | null> {
    const row = this.db.prepare(`SELECT * FROM memory_runs WHERE id = ?`).get(runId) as SqliteMemoryRunRow | undefined;
    return row ? rowToMemoryRun(row) : null;
  }

  async listMemoryRuns(limit: number): Promise<MemoryRunSummary[]> {
    const rows = this.db.prepare(`SELECT * FROM memory_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as SqliteMemoryRunRow[];
    return rows.map(rowToMemoryRun);
  }

  async tryAcquireMemoryLock(runId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memory_job_locks WHERE name = 'memory' AND expires_at_ms < ?`).run(now);
      const existing = this.db.prepare(`SELECT run_id FROM memory_job_locks WHERE name = 'memory'`).get() as { run_id: string } | undefined;
      if (existing && existing.run_id !== runId) {
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO memory_job_locks (name, run_id, acquired_at, expires_at_ms)
           VALUES ('memory', ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET run_id = excluded.run_id, acquired_at = excluded.acquired_at, expires_at_ms = excluded.expires_at_ms`
        )
        .run(runId, currentIso(), expiresAt);
      return true;
    });
    return transaction();
  }

  async releaseMemoryLock(runId: string): Promise<void> {
    this.db.prepare(`DELETE FROM memory_job_locks WHERE name = 'memory' AND run_id = ?`).run(runId);
  }

  async createMemorySourceWindow(input: Omit<MemorySourceWindowRecord, "id" | "createdAt">): Promise<MemorySourceWindowRecord> {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_source_windows
         (id, run_id, status, start_at_ms, end_at_ms, chat_source_ids_json, message_count, source_hash, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.status,
        input.startAtMs ?? null,
        input.endAtMs ?? null,
        stringifyJson(input.chatSourceIds) ?? "[]",
        input.messageCount,
        input.sourceHash,
        input.committedAt ?? null
      );
    const row = this.db.prepare(`SELECT * FROM memory_source_windows WHERE source_hash = ?`).get(input.sourceHash) as SqliteMemoryWindowRow;
    return rowToMemoryWindow(row);
  }

  async getCommittedMemoryWindow(sourceHash: string): Promise<MemorySourceWindowRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM memory_source_windows WHERE source_hash = ? AND status = 'committed' LIMIT 1`)
      .get(sourceHash) as SqliteMemoryWindowRow | undefined;
    return row ? rowToMemoryWindow(row) : null;
  }

  async commitMemorySourceWindow(windowId: string): Promise<void> {
    this.db
      .prepare(`UPDATE memory_source_windows SET status = 'committed', committed_at = ? WHERE id = ?`)
      .run(currentIso(), windowId);
  }

  async listMemoryEvidenceMessages(options: {
    startAtMs?: number | null;
    endAtMs?: number | null;
    chatSourceIds?: string[];
    limit: number;
  }): Promise<MemoryEvidenceMessage[]> {
    const where = ["m.timestamp_ms IS NOT NULL"];
    const params: unknown[] = [];
    if (options.startAtMs != null) {
      where.push("m.timestamp_ms >= ?");
      params.push(options.startAtMs);
    }
    if (options.endAtMs != null) {
      where.push("m.timestamp_ms <= ?");
      params.push(options.endAtMs);
    }
    if (options.chatSourceIds?.length) {
      const placeholders = options.chatSourceIds.map(() => "?").join(", ");
      where.push(`chats.source_chat_id IN (${placeholders})`);
      params.push(...options.chatSourceIds);
    }
    params.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.source_message_key, m.source_message_id, chats.source_chat_id, m.chat_id,
                NULLIF(TRIM(COALESCE(chats.display_name, '')), '') AS chat_display_name, chats.jid AS chat_jid,
                m.sender_source_jid,
                COALESCE(NULLIF(TRIM(COALESCE(c.display_name, '')), ''), NULLIF(TRIM(COALESCE(c.push_name, '')), ''), c.phone_number) AS sender_display_name,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.is_deleted, m.has_media, m.source_table,
                COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text,
                ${MEDIA_STATE_SELECT}
         FROM messages m
         JOIN chats ON chats.id = m.chat_id
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         ${MEDIA_STATE_JOINS}
         WHERE ${where.join(" AND ")}
         ORDER BY m.timestamp_ms ASC, m.id ASC
         LIMIT ?`
      )
      .all(...params) as SqliteMemoryEvidenceRow[];
    return rows.map((row, index) => rowToMemoryEvidence(row, index));
  }

  async getLatestCommittedMemoryEndAtMs(chatSourceId?: string | null): Promise<number | null> {
    const row = chatSourceId
      ? (this.db
          .prepare(
            `SELECT MAX(end_at_ms) AS end_at_ms
             FROM memory_source_windows
             WHERE status = 'committed'
               AND (chat_source_ids_json = '[]' OR chat_source_ids_json LIKE ?)`
          )
          .get(`%"${chatSourceId.replace(/"/g, '\\"')}"%`) as { end_at_ms: number | null })
      : (this.db
          .prepare(`SELECT MAX(end_at_ms) AS end_at_ms FROM memory_source_windows WHERE status = 'committed'`)
          .get() as { end_at_ms: number | null });
    return nullableNumber(row?.end_at_ms);
  }

  async recordMemoryEvidencePack(pack: MemoryEvidencePackRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memory_evidence_packs
         (id, run_id, window_id, status, sequence, message_count, citation_labels_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, message_count = excluded.message_count, citation_labels_json = excluded.citation_labels_json`
      )
      .run(pack.id, pack.runId, pack.windowId, pack.status, pack.sequence, pack.messageCount, stringifyJson(pack.citationLabels) ?? "[]", pack.createdAt);
  }

  async commitMemoryPageRevision(revision: MemoryPageRevisionRecord, citations: MemoryCitationRecord[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE memory_page_revisions SET status = 'superseded' WHERE page_id = ? AND status = 'current'`).run(revision.pageId);
      this.db
        .prepare(
          `INSERT INTO memory_page_revisions
           (id, page_id, run_id, window_id, title, page_path, summary, markdown, status, source_start_at_ms, source_end_at_ms, citation_count, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          revision.id,
          revision.pageId,
          revision.runId,
          revision.windowId,
          revision.title,
          revision.path,
          revision.summary,
          revision.markdown,
          revision.status,
          revision.sourceStartAtMs ?? null,
          revision.sourceEndAtMs ?? null,
          citations.length,
          stringifyJson(revision.metadata ?? null),
          revision.createdAt
        );
      this.db
        .prepare(
          `INSERT INTO memory_pages (page_id, title, page_path, status, current_revision_id, updated_at)
           VALUES (?, ?, ?, 'current', ?, ?)
           ON CONFLICT(page_id) DO UPDATE SET
             title = excluded.title,
             page_path = excluded.page_path,
             status = 'current',
             current_revision_id = excluded.current_revision_id,
             updated_at = excluded.updated_at`
        )
        .run(revision.pageId, revision.title, revision.path, revision.id, revision.createdAt);
      const insertCitation = this.db.prepare(
        `INSERT INTO memory_citations
         (revision_id, claim_id, citation_label, message_id, source_message_key, source_message_id, source_chat_id, sender_source_jid, timestamp_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const citation of citations) {
        insertCitation.run(
          revision.id,
          citation.claimId,
          citation.citationLabel,
          citation.messageId ?? null,
          citation.sourceMessageKey,
          citation.sourceMessageId,
          citation.sourceChatId,
          citation.senderSourceJid ?? null,
          citation.timestampMs ?? null
        );
      }
    });
    transaction();
  }

  async listMemoryPageRevisions(options: { query?: string; limit?: number } = {}): Promise<MemoryPageRevisionRecord[]> {
    const params: unknown[] = [];
    const where = ["r.status = 'current'"];
    if (options.query) {
      where.push("(r.title LIKE ? OR r.summary LIKE ? OR r.markdown LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`, `%${options.query}%`);
    }
    params.push(options.limit ?? 50);
    const rows = this.db
      .prepare(
        `SELECT r.*
         FROM memory_page_revisions r
         WHERE ${where.join(" AND ")}
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .all(...params) as SqliteMemoryRevisionRow[];
    return rows.map(rowToMemoryRevision);
  }

  async listMemoryCitations(revisionId?: string): Promise<MemoryCitationRecord[]> {
    const rows = revisionId
      ? (this.db.prepare(`SELECT * FROM memory_citations WHERE revision_id = ? ORDER BY id ASC`).all(revisionId) as SqliteMemoryCitationRow[])
      : (this.db.prepare(`SELECT * FROM memory_citations ORDER BY id ASC`).all() as SqliteMemoryCitationRow[]);
    return rows.map(rowToMemoryCitation);
  }

  async recordMemoryValidationIssues(issues: MemoryValidationIssue[]): Promise<void> {
    if (!issues.length) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO memory_validation_issues (run_id, pack_id, page_id, severity, code, message, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction(() => {
      for (const issue of issues) {
        insert.run(
          issue.runId,
          issue.packId ?? null,
          issue.pageId ?? null,
          issue.severity,
          issue.code,
          issue.message,
          stringifyJson(issue.context ?? null)
        );
      }
    });
    transaction();
  }

  async listMemoryValidationIssues(runId?: string): Promise<MemoryValidationIssue[]> {
    const rows = runId
      ? (this.db.prepare(`SELECT * FROM memory_validation_issues WHERE run_id = ? ORDER BY id ASC`).all(runId) as SqliteMemoryIssueRow[])
      : (this.db.prepare(`SELECT * FROM memory_validation_issues ORDER BY id ASC`).all() as SqliteMemoryIssueRow[]);
    return rows.map(rowToMemoryIssue);
  }

  async markStaleMemoryForMissingMessages(): Promise<number> {
    const missing = this.db
      .prepare(
        `SELECT DISTINCT r.page_id
         FROM memory_page_revisions r
         JOIN memory_citations c ON c.revision_id = r.id
         LEFT JOIN messages m ON m.source_message_key = c.source_message_key
         WHERE r.status = 'current' AND m.id IS NULL`
      )
      .all() as Array<{ page_id: string }>;
    if (!missing.length) {
      return 0;
    }
    const updatePages = this.db.prepare(`UPDATE memory_pages SET status = 'stale', updated_at = ? WHERE page_id = ?`);
    const updateRevisions = this.db.prepare(`UPDATE memory_page_revisions SET status = 'stale' WHERE page_id = ? AND status = 'current'`);
    const now = currentIso();
    const transaction = this.db.transaction(() => {
      for (const row of missing) {
        updatePages.run(now, row.page_id);
        updateRevisions.run(row.page_id);
      }
    });
    transaction();
    return missing.length;
  }

  async resolveMemoryCitation(citationLabelOrMessageKey: string): Promise<MemoryCitationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_citations
         WHERE citation_label = ? OR source_message_key = ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(citationLabelOrMessageKey, citationLabelOrMessageKey) as SqliteMemoryCitationRow | undefined;
    return row ? rowToMemoryCitation(row) : null;
  }

  async listNearbyMemoryMessages(messageId: number, radius: number): Promise<MemoryEvidenceMessage[]> {
    const base = this.db.prepare(`SELECT chat_id FROM messages WHERE id = ?`).get(messageId) as { chat_id: number } | undefined;
    if (!base) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.source_message_key, m.source_message_id, chats.source_chat_id, m.chat_id,
                NULLIF(TRIM(COALESCE(chats.display_name, '')), '') AS chat_display_name, chats.jid AS chat_jid,
                m.sender_source_jid,
                COALESCE(NULLIF(TRIM(COALESCE(c.display_name, '')), ''), NULLIF(TRIM(COALESCE(c.push_name, '')), ''), c.phone_number) AS sender_display_name,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.is_deleted, m.has_media, m.source_table,
                COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text,
                ${MEDIA_STATE_SELECT}
         FROM messages m
         JOIN chats ON chats.id = m.chat_id
         LEFT JOIN contacts c ON c.source_jid = m.sender_source_jid
         ${MEDIA_STATE_JOINS}
         WHERE m.chat_id = ? AND m.id BETWEEN ? AND ?
         ORDER BY m.timestamp_ms ASC, m.id ASC`
      )
      .all(base.chat_id, messageId - radius, messageId + radius) as SqliteMemoryEvidenceRow[];
    return rows.map((row, index) => rowToMemoryEvidence(row, index));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private getContactIds(jids: string[]): Map<string, number> {
    return getIds(this.db, "contacts", "source_jid", jids);
  }

  private propagateContactNamesToDmChats(contacts: ContactRecord[]): void {
    const updateDisplayName = this.db.prepare(
      `UPDATE chats
       SET display_name = ?, updated_at = ?
       WHERE source_chat_id = ?
         AND chat_type IN ('dm', 'unknown')`
    );
    const updatePushNameFallback = this.db.prepare(
      `UPDATE chats
       SET display_name = ?, updated_at = ?
       WHERE source_chat_id = ?
         AND chat_type IN ('dm', 'unknown')
         AND (
           display_name IS NULL
           OR TRIM(display_name) = ''
           OR display_name = jid
           OR display_name = source_chat_id
           OR display_name = ?
         )`
    );
    const transaction = this.db.transaction(() => {
      for (const contact of contacts) {
        const displayName = contact.displayName?.trim();
        const pushName = contact.pushName?.trim();
        if (!contact.sourceJid) {
          continue;
        }
        // Identity-derived "names" (bare digits of the JID) may fill an empty
        // slot but must never replace a real name.
        if (displayName && !isIdentityDerivedName(displayName, contact.sourceJid)) {
          updateDisplayName.run(displayName, currentIso(), contact.sourceJid);
        } else if (pushName && !isIdentityDerivedName(pushName, contact.sourceJid)) {
          updatePushNameFallback.run(pushName, currentIso(), contact.sourceJid, localPartFromJid(contact.sourceJid));
        }
      }
    });
    transaction();
  }

  private getChatIds(sourceChatIds: string[]): Map<string, number> {
    return getIds(this.db, "chats", "source_chat_id", sourceChatIds);
  }

  private getLatestWarnings(importRunId: string): ImportWarning[] {
    const rows = this.db
      .prepare(
        `SELECT id, severity, code, entity_type, source_table, source_row_id, message, context_json
         FROM import_warnings
         WHERE import_run_id = ?
         ORDER BY id DESC
         LIMIT 8`
      )
      .all(importRunId) as SqliteWarningRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      severity: row.severity as ImportWarning["severity"],
      code: row.code,
      entityType: row.entity_type,
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      message: row.message,
      context: parseJson(row.context_json)
    }));
  }

  private isInitialized(): boolean {
    return isSchemaPresent(this.db);
  }

  private restoreFromSnapshot(snapshotPath: string): void {
    const snapshotName = "import_restore_snapshot";
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.prepare(`ATTACH DATABASE ? AS ${snapshotName}`).run(snapshotPath);
      try {
        this.db.transaction(() => {
          for (const table of DELETE_TABLE_ORDER) {
            this.db.prepare(`DELETE FROM ${table}`).run();
          }
          for (const table of ARCHIVE_TABLES) {
            const columns = tableColumns(this.db, table);
            const columnList = columns.map(quoteIdentifier).join(", ");
            this.db.prepare(`INSERT INTO ${table} (${columnList}) SELECT ${columnList} FROM ${snapshotName}.${table}`).run();
          }
          // schema_meta must roll back too, or a failed clear-and-replace over a
          // legacy archive would leave the new identity stamp on legacy data.
          this.db.prepare(`DELETE FROM schema_meta`).run();
          this.db.prepare(`INSERT INTO schema_meta (key, value, updated_at) SELECT key, value, updated_at FROM ${snapshotName}.schema_meta`).run();
          this.clearSqliteSequence();
          this.db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT name, seq FROM import_restore_snapshot.sqlite_sequence").run();
        })();
      } finally {
        this.db.prepare(`DETACH DATABASE ${snapshotName}`).run();
      }
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
    // Recompute the legacy gate and rebuild the identity-link cache from the
    // restored tables, discarding anything learned during the aborted run.
    this.initializeIdentityState();
    // Re-read the restored fts_state stamp; if the index was invalid before the
    // restore, its garbage survived the replay and the stamp must stay honest.
    const stateBefore = this.cachedFtsState;
    this.cachedFtsState = null;
    if (stateBefore === "needs_rebuild") {
      this.setFtsState("needs_rebuild");
    }
  }

  private clearSqliteSequence(): void {
    const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`).get();
    if (row) {
      this.db.prepare("DELETE FROM sqlite_sequence").run();
    }
  }
}

function configureDatabase(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function ensureSchema(db: Database.Database): void {
  migrateLiveSessionStatuses(db);
  migrateLiveMessageUpdateTypes(db);
  db.exec(schemaStatements.join(";\n"));
  migrateAdditiveColumns(db);
  ensureSearchSchema(db);
  // Drop the removed view-once recovery queue if a prior build created it. It
  // only ever held transient request state (message keys, no content), so this
  // is safe cleanup, not a data migration.
  db.exec(`DROP TABLE IF EXISTS view_once_recovery`);
}

// SQLite cannot alter CHECK constraints in place; rebuild live_message_updates
// when an older archive lacks an update type the app now uses (poll_vote,
// event_response).
function migrateLiveMessageUpdateTypes(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_message_updates'`)
    .get() as { sql: string } | undefined;
  if (!existing?.sql || MESSAGE_UPDATE_TYPES.every((type) => existing.sql.includes(`'${type}'`))) {
    return;
  }
  db.transaction(() => {
    db.exec(liveMessageUpdatesTableDdl("live_message_updates_migrated"));
    db.exec(
      `INSERT INTO live_message_updates_migrated
       (event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json, created_at, updated_at)
       SELECT event_key, chat_source_id, source_message_key, update_type, occurred_at_ms, applied, metadata_json, created_at, updated_at
       FROM live_message_updates`
    );
    db.exec(`DROP TABLE live_message_updates`);
    db.exec(`ALTER TABLE live_message_updates_migrated RENAME TO live_message_updates`);
  })();
}

function migrateAdditiveColumns(db: Database.Database): void {
  const additions: Array<{ table: string; column: string; ddl: string }> = [
    { table: "chats", column: "platform_recency_ms", ddl: "ALTER TABLE chats ADD COLUMN platform_recency_ms INTEGER NULL" },
    { table: "messages", column: "resolved_text", ddl: "ALTER TABLE messages ADD COLUMN resolved_text TEXT NULL" }
  ];
  for (const addition of additions) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(addition.table) as Array<{ name: string }>;
    if (!columns.some((column) => column.name === addition.column)) {
      db.exec(addition.ddl);
    }
  }
}

// FTS + triggers land after column migration (they reference resolved_text).
// The state stamp is written once: an archive that already held messages when
// the index appeared must run a reindex before search answers — the empty
// index would otherwise silently pretend those messages do not exist.
function ensureSearchSchema(db: Database.Database): void {
  // Migration from the retired external-content design: drop it (including
  // any shadow-table corruption its delete-by-value triggers accumulated) and
  // force a rebuild under the rowid-keyed scheme.
  const existingFts = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
    .get() as { sql: string } | undefined;
  const legacyExternalContent = Boolean(existingFts?.sql && existingFts.sql.includes("content="));
  if (legacyExternalContent) {
    db.exec(
      `DROP TRIGGER IF EXISTS messages_fts_ai;
       DROP TRIGGER IF EXISTS messages_fts_ad;
       DROP TRIGGER IF EXISTS messages_fts_au;
       DROP TABLE IF EXISTS messages_fts;`
    );
  }
  db.exec(searchSchemaStatements.join(";\n"));
  const stamped = db.prepare(`SELECT value FROM schema_meta WHERE key = 'fts_state'`).get() as { value: string } | undefined;
  if (!stamped || legacyExternalContent) {
    const messageCount = (db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count;
    db.prepare(
      `INSERT INTO schema_meta (key, value, updated_at) VALUES ('fts_state', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(messageCount > 0 ? "needs_rebuild" : "ready", new Date().toISOString());
  }
}

// SQLite cannot alter CHECK constraints in place; rebuild live_sessions when an
// older archive lacks a status value the app now uses.
function migrateLiveSessionStatuses(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_sessions'`)
    .get() as { sql: string } | undefined;
  if (!existing?.sql || LIVE_SESSION_STATUSES.every((status) => existing.sql.includes(`'${status}'`))) {
    return;
  }
  db.transaction(() => {
    db.exec(liveSessionsTableDdl("live_sessions_migrated"));
    db.exec(
      `INSERT INTO live_sessions_migrated
       (id, status, client_name, linked_device_jid, last_connected_at, last_disconnected_at, last_error, created_at, updated_at)
       SELECT id, status, client_name, linked_device_jid, last_connected_at, last_disconnected_at, last_error, created_at, updated_at
       FROM live_sessions`
    );
    db.exec(`DROP TABLE live_sessions`);
    db.exec(`ALTER TABLE live_sessions_migrated RENAME TO live_sessions`);
  })();
}

function isSchemaPresent(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table' AND name IN ('import_runs', 'contacts', 'chats', 'messages')`
    )
    .get() as { count: number };
  return Number(row.count ?? 0) >= 4;
}

function getIds(db: Database.Database, table: string, column: string, values: string[]): Map<string, number> {
  const uniqueValues = [...new Set(values)].filter(Boolean);
  const ids = new Map<string, number>();
  if (uniqueValues.length === 0) {
    return ids;
  }
  for (let index = 0; index < uniqueValues.length; index += SQLITE_IN_QUERY_BATCH_SIZE) {
    const batch = uniqueValues.slice(index, index + SQLITE_IN_QUERY_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, ${column} AS source_key FROM ${table} WHERE ${column} IN (${placeholders})`).all(...batch) as Array<{
      id: number;
      source_key: string;
    }>;
    for (const row of rows) {
      ids.set(row.source_key, Number(row.id));
    }
  }
  return ids;
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function parseArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function totalsOrEmpty(totals: ImportTotals | null | undefined): ImportTotals {
  return totals ?? { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
}

function emptyLiveTotals(): LiveSyncTotals {
  return { contacts: 0, chats: 0, participants: 0, messages: 0, updates: 0, gapsOpened: 0, gapsClosed: 0, warnings: 0 };
}

function totalsOrEmptyLive(totals: LiveSyncTotals | null | undefined): LiveSyncTotals {
  return totals ?? emptyLiveTotals();
}

function rowToImportSummary(row: SqliteImportRunRow): ImportRunSummary {
  return {
    id: row.id,
    status: row.status as ImportRunSummary["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totals: totalsOrEmpty(parseJson(row.totals_json) as ImportTotals | null),
    warningCount: Number(row.warning_count ?? 0),
    errorMessage: row.error_message ?? null
  };
}

function rowToLiveSession(row: SqliteLiveSessionRow): LiveSessionSummary {
  return {
    id: row.id,
    status: row.status as LiveSessionSummary["status"],
    clientName: row.client_name,
    linkedDeviceJid: row.linked_device_jid,
    lastConnectedAt: row.last_connected_at,
    lastDisconnectedAt: row.last_disconnected_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToLiveRun(row: SqliteLiveRunRow): LiveSyncRunSummary {
  return {
    id: row.id,
    status: row.status as LiveSyncRunSummary["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totals: totalsOrEmptyLive(parseJson(row.totals_json) as LiveSyncTotals | null),
    warningCount: Number(row.warning_count ?? 0),
    errorMessage: row.error_message
  };
}

function rowToLiveCheckpoint(row: SqliteLiveCheckpointRow): LiveChatCheckpointRecord {
  return {
    chatSourceId: row.chat_source_id,
    chatId: row.chat_id,
    latestArchivedMessageKey: row.latest_archived_message_key,
    latestArchivedAtMs: nullableNumber(row.latest_archived_at_ms),
    earliestArchivedMessageKey: row.earliest_archived_message_key,
    earliestArchivedAtMs: nullableNumber(row.earliest_archived_at_ms),
    latestLiveMessageKey: row.latest_live_message_key,
    latestLiveAtMs: nullableNumber(row.latest_live_at_ms),
    oldestVerifiedMessageKey: row.oldest_verified_message_key,
    oldestVerifiedAtMs: nullableNumber(row.oldest_verified_at_ms),
    health: row.health as LiveHealthState,
    retryCount: Number(row.retry_count ?? 0),
    nextRecoveryAt: row.next_recovery_at,
    lastAuditAt: row.last_audit_at,
    rawMetadata: parseJson(row.raw_metadata_json)
  };
}

function rowToLiveGap(row: SqliteLiveGapRow): LiveGapWindowRecord {
  return {
    id: Number(row.id),
    chatSourceId: row.chat_source_id,
    chatId: row.chat_id,
    reason: row.reason as LiveGapReason,
    status: row.status as LiveGapStatus,
    startAtMs: nullableNumber(row.start_at_ms),
    endAtMs: nullableNumber(row.end_at_ms),
    requiredLowerBoundAtMs: nullableNumber(row.required_lower_bound_at_ms),
    anchorMessageKey: row.anchor_message_key,
    requestCount: Number(row.request_count ?? 0),
    lastAttemptAt: row.last_attempt_at,
    confidence: row.confidence as LiveGapWindowRecord["confidence"],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToMemoryRun(row: SqliteMemoryRunRow): MemoryRunSummary {
  return {
    id: row.id,
    status: row.status as MemoryRunSummary["status"],
    kind: row.kind as MemoryRunSummary["kind"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sourceStartAtMs: nullableNumber(row.source_start_at_ms),
    sourceEndAtMs: nullableNumber(row.source_end_at_ms),
    pageCount: Number(row.page_count ?? 0),
    citationCount: Number(row.citation_count ?? 0),
    messageCount: Number(row.message_count ?? 0),
    warningCount: Number(row.warning_count ?? 0),
    errorMessage: row.error_message
  };
}

function rowToMemoryWindow(row: SqliteMemoryWindowRow): MemorySourceWindowRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status as MemorySourceWindowRecord["status"],
    startAtMs: nullableNumber(row.start_at_ms),
    endAtMs: nullableNumber(row.end_at_ms),
    chatSourceIds: parseArray(row.chat_source_ids_json),
    messageCount: Number(row.message_count ?? 0),
    sourceHash: row.source_hash,
    committedAt: row.committed_at,
    createdAt: row.created_at
  };
}

function rowToMemoryEvidence(row: SqliteMemoryEvidenceRow, index: number): MemoryEvidenceMessage {
  const availability = deriveMediaAvailability(row);
  return {
    citationLabel: `m${index + 1}`,
    messageId: Number(row.id),
    sourceMessageKey: row.source_message_key,
    sourceMessageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    chatId: Number(row.chat_id),
    chatDisplayName: row.chat_display_name ?? displayPhoneFromJid(row.chat_jid),
    senderSourceJid: row.sender_source_jid,
    senderDisplayName: row.sender_display_name ?? displayPhoneFromJid(row.sender_source_jid),
    timestampMs: nullableNumber(row.timestamp_ms),
    sentAt: row.sent_at,
    direction: row.direction as MemoryEvidenceMessage["direction"],
    messageType: row.message_type,
    interpretation: interpretMessage({
      messageType: row.message_type,
      isDeleted: Boolean(row.is_deleted),
      hasHeldContent: Boolean(row.text) || availability === "stored",
      mediaAvailability: availability
    }),
    text: row.text
  };
}

function rowToMemoryRevision(row: SqliteMemoryRevisionRow): MemoryPageRevisionRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    runId: row.run_id,
    windowId: row.window_id,
    title: row.title,
    path: row.page_path,
    summary: row.summary,
    markdown: row.markdown,
    status: row.status as MemoryPageRevisionRecord["status"],
    sourceStartAtMs: nullableNumber(row.source_start_at_ms),
    sourceEndAtMs: nullableNumber(row.source_end_at_ms),
    citationCount: Number(row.citation_count ?? 0),
    createdAt: row.created_at,
    metadata: parseJson(row.metadata_json)
  };
}

function rowToMemoryCitation(row: SqliteMemoryCitationRow): MemoryCitationRecord {
  return {
    id: Number(row.id),
    revisionId: row.revision_id,
    claimId: row.claim_id,
    citationLabel: row.citation_label,
    messageId: row.message_id == null ? null : Number(row.message_id),
    sourceMessageKey: row.source_message_key,
    sourceMessageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    senderSourceJid: row.sender_source_jid,
    timestampMs: nullableNumber(row.timestamp_ms)
  };
}

function rowToMemoryIssue(row: SqliteMemoryIssueRow): MemoryValidationIssue {
  return {
    id: Number(row.id),
    runId: row.run_id,
    packId: row.pack_id,
    pageId: row.page_id,
    severity: row.severity as MemoryValidationIssue["severity"],
    code: row.code,
    message: row.message,
    context: parseJson(row.context_json),
    createdAt: row.created_at
  };
}

function emptyStatus(initialized: boolean, error?: string): StatusSummary {
  return {
    database: {
      configured: true,
      initialized,
      adapter: "sqlite",
      location: path.basename(config.archive.sqlitePath),
      error
    },
    counts: { chats: 0, contacts: 0, participants: 0, messages: 0, warnings: 0 },
    latestImport: null,
    latestWarnings: []
  };
}

// Phone digits from a phone-addressed JID only; LID/group/broadcast ids are
// numeric but are NOT phone numbers.
function displayPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  const [user, server] = jid.split("@");
  if (server !== "s.whatsapp.net" && server !== "c.us") {
    return null;
  }
  const digits = user?.split(":")[0]?.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

// Search tuning: candidate pool reranked in JS (BM25 × recency decay) and the
// reindex chunk size (rows recomputed per transaction between event-loop
// yields).
const SEARCH_CANDIDATE_POOL = 240;
const SEARCH_REINDEX_CHUNK = 2000;

interface SqliteSearchRow {
  id: number;
  source_message_key: string;
  source_message_id: string;
  chat_id: number;
  sender_source_jid: string | null;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
  is_deleted: number;
  has_media: number;
  body: string | null;
  chat_source_id: string;
  chat_display_name: string | null;
  chat_type: string;
  sender_display_name: string | null;
  rank: number;
  snip_resolved: string | null;
  snip_body: string | null;
  snip_caption: string | null;
}

// User text → FTS5 MATCH expression. Every token becomes a quoted phrase so
// FTS operators in user input are inert; the final unquoted token gets prefix
// matching so search-as-you-type works. Returns null for queries with no
// searchable tokens.
function buildFtsMatchQuery(raw: string): string | null {
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];
  const parts: string[] = [];
  tokens.forEach((token, index) => {
    let phrase = token;
    let quoted = false;
    if (phrase.length >= 2 && phrase.startsWith('"') && phrase.endsWith('"')) {
      quoted = true;
      phrase = phrase.slice(1, -1);
    }
    const cleaned = phrase.replace(/"/g, " ").trim();
    if (!cleaned) {
      return;
    }
    const prefix = !quoted && index === tokens.length - 1 && /[\p{L}\p{N}]{2,}$/u.test(cleaned);
    parts.push(`"${cleaned}"${prefix ? "*" : ""}`);
  });
  return parts.length > 0 ? parts.join(" ") : null;
}

// Prefer the snippet closest to what the user sees (body, then caption), then
// the resolved-text snippet (which may have matched a name or file name).
function pickSnippet(row: SqliteSearchRow): string {
  for (const candidate of [row.snip_body, row.snip_caption, row.snip_resolved]) {
    if (candidate && candidate.includes(SEARCH_HIGHLIGHT_START)) {
      return candidate;
    }
  }
  return row.snip_body?.trim() || row.snip_caption?.trim() || row.snip_resolved?.trim() || (row.body ?? "").slice(0, 160);
}

// Derived search text for one message: resolved body/caption (mentions as
// names), media file name, and the sender label. Content-less rows stay null
// so system noise never matches person-name queries.
function composeResolvedText(
  body: string | null,
  caption: string | null,
  mediaName: string | null,
  senderLabel: string | null,
  mentionLabels: Map<string, string>
): string | null {
  const parts: string[] = [];
  const resolvedBody = applyMentionLabels(body, mentionLabels)?.trim();
  const resolvedCaption = applyMentionLabels(caption, mentionLabels)?.trim();
  if (resolvedBody) {
    parts.push(resolvedBody);
  }
  if (resolvedCaption) {
    parts.push(resolvedCaption);
  }
  if (mediaName?.trim()) {
    parts.push(mediaName.trim());
  }
  if (parts.length === 0) {
    return null;
  }
  if (senderLabel?.trim()) {
    parts.push(senderLabel.trim());
  }
  return parts.join("\n");
}

// A "visible exchange" is a message a user would recognize as conversation:
// used both to hide event-only chats and to compute WhatsApp-style recency.
function visibleExchangePredicate(alias: string): string {
  return `${alias}.message_type NOT IN ('system', 'status', 'reaction', 'encrypted_update')
          AND (
            ${alias}.direction IN ('incoming', 'outgoing')
            OR NULLIF(TRIM(COALESCE(${alias}.body, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(${alias}.caption, '')), '') IS NOT NULL
            OR ${alias}.has_media = 1
            OR ${alias}.is_deleted = 1
            OR ${alias}.message_type = 'call'
          )`;
}

function currentIso(): string {
  return new Date().toISOString();
}

function isLidFormJid(jid: string): boolean {
  return jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

// True when a "name" is just the identity restated (bare digits of the JID's
// local part, or the JID itself) — permitted as a fill, never as an overwrite.
function isIdentityDerivedName(name: string, jid: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return true;
  }
  const localPart = localPartFromJid(jid);
  return trimmed === jid || trimmed === localPart || trimmed.replace(/\D/g, "") === localPart;
}


function isoFromMs(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function nullableNumber(value: number | null | undefined): number | null {
  return value == null ? null : Number(value);
}

function localPartFromJid(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}

interface SqliteImportRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  totals_json: string | null;
  warning_count: number;
  error_message: string | null;
}

interface SqliteWarningRow {
  id: number;
  severity: string;
  code: string;
  entity_type: string | null;
  source_table: string | null;
  source_row_id: string | null;
  message: string;
  context_json: string | null;
}

interface SqliteChatRow {
  id: number;
  source_chat_id: string;
  jid: string;
  display_name: string;
  chat_type: string;
  message_count: number;
  participant_count: number;
  last_message_at: string | null;
}

interface SqliteBrainTaskRow {
  id: number;
  kind: string;
  chat_source_id: string | null;
  payload_json: string | null;
  dedupe_key: string;
  status: string;
  priority: number;
  attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
}

interface SqliteBrainRunRow {
  id: string;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  timezone: string | null;
  totals_json: string | null;
  error_message: string | null;
}

function rowToBrainTask(row: SqliteBrainTaskRow): BrainTaskRecord {
  return {
    id: Number(row.id),
    kind: row.kind as BrainTaskRecord["kind"],
    chatSourceId: row.chat_source_id,
    payload: parseJson(row.payload_json) as Record<string, unknown> | null,
    dedupeKey: row.dedupe_key,
    status: row.status as BrainTaskRecord["status"],
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    nextAttemptAtMs: row.next_attempt_at_ms == null ? null : Number(row.next_attempt_at_ms),
    lastError: row.last_error
  };
}

function rowToBrainRun(row: SqliteBrainRunRow): BrainRunSummary {
  return {
    id: row.id,
    kind: row.kind as BrainRunSummary["kind"],
    status: row.status as BrainRunSummary["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    timezone: row.timezone,
    totals: parseJson(row.totals_json) as Record<string, number> | null,
    errorMessage: row.error_message
  };
}

interface SqliteMessageRow extends SqliteMediaStateColumns {
  id: number;
  source_message_id: string;
  sender_display_name: string | null;
  sender_source_jid: string | null;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
  body: string | null;
  caption: string | null;
  has_media: number;
  media_mime_type: string | null;
  media_name: string | null;
  is_deleted: number;
  is_forwarded: number;
  is_starred: number;
  source_table: string;
  edited_flag: number;
  edit_revision_count: number;
  preview_title: string | null;
  preview_description: string | null;
  preview_url: string | null;
  preview_has_thumbnail: number;
}

interface SqliteLiveSessionRow {
  id: string;
  status: string;
  client_name: string;
  linked_device_jid: string | null;
  last_connected_at: string | null;
  last_disconnected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteLiveRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  totals_json: string | null;
  warning_count: number;
  error_message: string | null;
}

interface SqliteLiveCheckpointRow {
  chat_source_id: string;
  chat_id: number | null;
  latest_archived_message_key: string | null;
  latest_archived_at_ms: number | null;
  earliest_archived_message_key: string | null;
  earliest_archived_at_ms: number | null;
  latest_live_message_key: string | null;
  latest_live_at_ms: number | null;
  oldest_verified_message_key: string | null;
  oldest_verified_at_ms: number | null;
  health: string;
  retry_count: number;
  next_recovery_at: string | null;
  last_audit_at: string | null;
  raw_metadata_json: string | null;
}

interface SqliteLiveGapRow {
  id: number;
  chat_source_id: string;
  chat_id: number | null;
  reason: string;
  status: string;
  start_at_ms: number | null;
  end_at_ms: number | null;
  required_lower_bound_at_ms: number | null;
  anchor_message_key: string | null;
  request_count: number;
  last_attempt_at: string | null;
  confidence: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteLiveHealthRow {
  chat_source_id: string;
  display_name: string | null;
  health: string;
  latest_archived_at_ms: number | null;
  latest_live_at_ms: number | null;
  oldest_verified_at_ms: number | null;
  next_recovery_at: string | null;
  open_gap_count: number;
}

interface SqliteMemoryRunRow {
  id: string;
  status: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  source_start_at_ms: number | null;
  source_end_at_ms: number | null;
  page_count: number;
  citation_count: number;
  message_count: number;
  warning_count: number;
  error_message: string | null;
}

interface SqliteMemoryWindowRow {
  id: string;
  run_id: string;
  status: string;
  start_at_ms: number | null;
  end_at_ms: number | null;
  chat_source_ids_json: string | null;
  message_count: number;
  source_hash: string;
  committed_at: string | null;
  created_at: string;
}

interface SqliteMemoryEvidenceRow extends SqliteMediaStateColumns {
  id: number;
  source_message_key: string;
  source_message_id: string;
  source_chat_id: string;
  chat_id: number;
  chat_display_name: string | null;
  chat_jid: string | null;
  sender_source_jid: string | null;
  sender_display_name: string | null;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
  is_deleted: number;
  text: string | null;
}

interface SqliteMemoryRevisionRow {
  id: string;
  page_id: string;
  run_id: string;
  window_id: string;
  title: string;
  page_path: string;
  summary: string;
  markdown: string;
  status: string;
  source_start_at_ms: number | null;
  source_end_at_ms: number | null;
  citation_count: number;
  metadata_json: string | null;
  created_at: string;
}

interface SqliteMemoryCitationRow {
  id: number;
  revision_id: string;
  claim_id: string;
  citation_label: string;
  message_id: number | null;
  source_message_key: string;
  source_message_id: string;
  source_chat_id: string;
  sender_source_jid: string | null;
  timestamp_ms: number | null;
}

interface SqliteMemoryIssueRow {
  id: number;
  run_id: string;
  pack_id: string | null;
  page_id: string | null;
  severity: string;
  code: string;
  message: string;
  context_json: string | null;
  created_at: string;
}
