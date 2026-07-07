import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  ChatListItem,
  ChatListOptions,
  ChatRecord,
  ChatSyncStateRecord,
  ContactRecord,
  ImportRunSummary,
  ImportTotals,
  ImportWarning,
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
  ParticipantRecord,
  RecoveryAnchorRecord,
  StatusSummary
} from "../../shared/types";
import { config } from "../config";
import { baselineFromStatus } from "../live/baseline";
import { liveKeyMessageId } from "../live/normalize";
import { getMemoryProviderStatus } from "../memory/provider";
import type { ArchiveRepository, ArchiveRestorePoint } from "./repository";

const TOOL_VERSION = "0.1.0";
const SQLITE_IN_QUERY_BATCH_SIZE = 500;
const ARCHIVE_TABLES = [
  "import_runs",
  "contacts",
  "chats",
  "chat_participants",
  "messages",
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
  "memory_job_locks"
] as const;
const DELETE_TABLE_ORDER = [
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
  "messages",
  "chat_participants",
  "chats",
  "contacts",
  "import_warnings",
  "import_runs"
] as const;

const LIVE_SESSION_STATUSES = ["not_configured", "pairing", "connected", "disconnected", "stopped", "error", "logged_out"] as const;

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
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  )`,

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

  `CREATE TABLE IF NOT EXISTS live_message_updates (
    event_key TEXT PRIMARY KEY,
    chat_source_id TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    update_type TEXT NOT NULL CHECK (update_type IN ('delete','edit','reaction','receipt','call','unknown')),
    occurred_at_ms INTEGER NULL,
    applied INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

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

  `CREATE INDEX IF NOT EXISTS idx_import_warnings_run ON import_warnings (import_run_id, severity, code)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone_number)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats (last_message_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_type ON chats (chat_type)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_contact ON chat_participants (contact_id, chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp_ms, id)`,
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
  `CREATE INDEX IF NOT EXISTS idx_memory_issues_run ON memory_validation_issues (run_id, severity, code)`
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

  constructor(private readonly dbPath = config.archive.sqlitePath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureDatabase(this.db);
    ensureSchema(this.db);
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
    const unique = new Map<string, ContactRecord>();
    for (const contact of contacts) {
      if (contact.sourceJid) {
        unique.set(contact.sourceJid, contact);
      }
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
    const unique = new Map<string, ChatRecord>();
    for (const chat of chats) {
      if (chat.sourceChatId) {
        unique.set(chat.sourceChatId, chat);
      }
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
    const unique = new Map<string, ParticipantRecord>();
    for (const participant of participants) {
      unique.set(`${participant.chatSourceId}\u0000${participant.sourceJid}`, participant);
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
    if (messages.length === 0) {
      return 0;
    }

    const chatIds = this.getChatIds([...new Set(messages.map((message) => message.chatSourceId))]);
    const senderIds = this.getContactIds([
      ...new Set(messages.map((message) => message.senderSourceJid).filter((jid): jid is string => Boolean(jid)))
    ]);
    const rows = messages
      .map((message) => {
        const chatId = chatIds.get(message.chatSourceId);
        if (!chatId) {
          return null;
        }
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
          rawMetadata: stringifyJson(message.rawMetadata ?? null)
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
        media_name, quoted_source_message_id, is_deleted, is_forwarded, is_starred, raw_metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_message_key) DO UPDATE SET
         chat_id = excluded.chat_id,
         sender_contact_id = excluded.sender_contact_id,
         sender_source_jid = excluded.sender_source_jid,
         timestamp_ms = excluded.timestamp_ms,
         sent_at = excluded.sent_at,
         direction = excluded.direction,
         from_me = excluded.from_me,
         message_type = excluded.message_type,
         raw_type_code = excluded.raw_type_code,
         body = excluded.body,
         caption = excluded.caption,
         has_media = excluded.has_media,
         media_mime_type = excluded.media_mime_type,
         media_name = excluded.media_name,
         quoted_source_message_id = excluded.quoted_source_message_id,
         is_deleted = excluded.is_deleted,
         is_forwarded = excluded.is_forwarded,
         is_starred = excluded.is_starred,
         raw_metadata_json = excluded.raw_metadata_json`
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
          row.rawMetadata
        );
      }
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
        location: path.basename(this.dbPath)
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

  async applyLiveMessageUpdates(updates: Array<Omit<LiveMessageUpdateRecord, "applied">>): Promise<LiveMessageUpdateResult> {
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
    const markDeleted = this.db.prepare(
      `UPDATE messages
       SET is_deleted = 1, body = NULL, caption = NULL,
           raw_metadata_json = COALESCE(raw_metadata_json, ?)
       WHERE source_message_key = ?`
    );
    const applyEdit = this.db.prepare(
      `UPDATE messages
       SET body = ?,
           raw_metadata_json = json_set(COALESCE(raw_metadata_json, '{}'), '$.edited', 1)
       WHERE source_message_key = ?`
    );
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
    const transaction = this.db.transaction(() => {
      for (const update of updates) {
        let targetKey: string | null = update.sourceMessageKey;
        if (!exists.get(targetKey)) {
          const messageId = liveKeyMessageId(update.sourceMessageKey);
          const fallback = messageId ? (fallbackKey.get(update.chatSourceId, messageId) as { key: string } | undefined) : undefined;
          targetKey = fallback?.key ?? null;
        }
        const hasBase = Boolean(targetKey);
        if (targetKey) {
          if (update.updateType === "delete") {
            markDeleted.run(stringifyJson({ liveUpdate: "delete" }), targetKey);
          }
          if (update.updateType === "edit" && typeof update.metadata?.body === "string") {
            applyEdit.run(update.metadata.body, targetKey);
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
    });
    transaction();
    return { applied, pending };
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
      chatHealth: healthRows.map((row) => ({
        chatSourceId: row.chat_source_id,
        chatDisplayName: row.display_name ?? null,
        health: row.health as LiveHealthState,
        latestArchivedAt: isoFromMs(row.latest_archived_at_ms),
        latestLiveAt: isoFromMs(row.latest_live_at_ms),
        oldestVerifiedAt: isoFromMs(row.oldest_verified_at_ms),
        openGapCount: Number(row.open_gap_count ?? 0),
        nextRecoveryAt: row.next_recovery_at ?? null
      }))
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
        location: path.basename(this.dbPath)
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
      where.push("(display_name LIKE ? OR jid LIKE ?)");
      params.push(`%${options.search}%`, `%${options.search}%`);
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
        `SELECT id, source_chat_id, jid, COALESCE(NULLIF(display_name, ''), jid) AS display_name, chat_type,
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
      displayName: row.display_name,
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
    const rows = this.db
      .prepare(
        `SELECT m.id, m.source_message_id, COALESCE(c.display_name, m.sender_source_jid) AS sender_display_name,
                m.sender_source_jid, m.timestamp_ms, m.sent_at, m.direction, m.message_type, m.body, m.caption,
                m.has_media, m.media_mime_type, m.media_name, m.is_deleted, m.is_forwarded, m.is_starred
         FROM messages m
         LEFT JOIN contacts c ON c.id = m.sender_contact_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.timestamp_ms ${orderDirection}, m.id ${orderDirection}
         LIMIT ? OFFSET ?`
      )
      .all(...params) as SqliteMessageRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      sourceMessageId: row.source_message_id,
      senderDisplayName: row.sender_display_name,
      senderSourceJid: row.sender_source_jid,
      timestampMs: row.timestamp_ms == null ? null : Number(row.timestamp_ms),
      sentAt: row.sent_at,
      direction: row.direction as MessageListItem["direction"],
      messageType: row.message_type,
      body: row.body,
      caption: row.caption,
      hasMedia: Boolean(row.has_media),
      mediaMimeType: row.media_mime_type,
      mediaName: row.media_name,
      isDeleted: Boolean(row.is_deleted),
      isForwarded: Boolean(row.is_forwarded),
      isStarred: Boolean(row.is_starred)
    }));
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
                COALESCE(NULLIF(chats.display_name, ''), chats.jid) AS chat_display_name,
                m.sender_source_jid, COALESCE(c.display_name, m.sender_source_jid) AS sender_display_name,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type,
                COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text
         FROM messages m
         JOIN chats ON chats.id = m.chat_id
         LEFT JOIN contacts c ON c.id = m.sender_contact_id
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
                COALESCE(NULLIF(chats.display_name, ''), chats.jid) AS chat_display_name,
                m.sender_source_jid, COALESCE(c.display_name, m.sender_source_jid) AS sender_display_name,
                m.timestamp_ms, m.sent_at, m.direction, m.message_type,
                COALESCE(NULLIF(m.body, ''), NULLIF(m.caption, '')) AS text
         FROM messages m
         JOIN chats ON chats.id = m.chat_id
         LEFT JOIN contacts c ON c.id = m.sender_contact_id
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
        if (displayName) {
          updateDisplayName.run(displayName, currentIso(), contact.sourceJid);
        } else if (pushName) {
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
          this.clearSqliteSequence();
          this.db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT name, seq FROM import_restore_snapshot.sqlite_sequence").run();
        })();
      } finally {
        this.db.prepare(`DETACH DATABASE ${snapshotName}`).run();
      }
    } finally {
      this.db.pragma("foreign_keys = ON");
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
  db.exec(schemaStatements.join(";\n"));
  migrateAdditiveColumns(db);
}

function migrateAdditiveColumns(db: Database.Database): void {
  const additions: Array<{ table: string; column: string; ddl: string }> = [
    { table: "chats", column: "platform_recency_ms", ddl: "ALTER TABLE chats ADD COLUMN platform_recency_ms INTEGER NULL" }
  ];
  for (const addition of additions) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(addition.table) as Array<{ name: string }>;
    if (!columns.some((column) => column.name === addition.column)) {
      db.exec(addition.ddl);
    }
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
  return {
    citationLabel: `m${index + 1}`,
    messageId: Number(row.id),
    sourceMessageKey: row.source_message_key,
    sourceMessageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    chatId: Number(row.chat_id),
    chatDisplayName: row.chat_display_name,
    senderSourceJid: row.sender_source_jid,
    senderDisplayName: row.sender_display_name,
    timestampMs: nullableNumber(row.timestamp_ms),
    sentAt: row.sent_at,
    direction: row.direction as MemoryEvidenceMessage["direction"],
    messageType: row.message_type,
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

// A "visible exchange" is a message a user would recognize as conversation:
// used both to hide event-only chats and to compute WhatsApp-style recency.
function visibleExchangePredicate(alias: string): string {
  return `${alias}.message_type NOT IN ('system', 'status', 'reaction')
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

interface SqliteMessageRow {
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

interface SqliteMemoryEvidenceRow {
  id: number;
  source_message_key: string;
  source_message_id: string;
  source_chat_id: string;
  chat_id: number;
  chat_display_name: string | null;
  sender_source_jid: string | null;
  sender_display_name: string | null;
  timestamp_ms: number | null;
  sent_at: string | null;
  direction: string;
  message_type: string;
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
