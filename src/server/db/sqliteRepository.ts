import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  ChatListItem,
  ChatListOptions,
  ChatRecord,
  ContactRecord,
  ImportRunSummary,
  ImportTotals,
  ImportWarning,
  MessageListItem,
  MessageRecord,
  ParticipantRecord,
  StatusSummary
} from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "./repository";

const TOOL_VERSION = "0.1.0";
const SQLITE_IN_QUERY_BATCH_SIZE = 500;

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

  `CREATE INDEX IF NOT EXISTS idx_import_warnings_run ON import_warnings (import_run_id, severity, code)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone_number)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats (last_message_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_type ON chats (chat_type)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_participants_contact ON chat_participants (contact_id, chat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_id, timestamp_ms, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages (chat_id, sender_contact_id, timestamp_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_type_time ON messages (message_type, timestamp_ms)`
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
       (source_chat_id, jid, display_name, chat_type, raw_metadata_json, first_seen_import_id, last_seen_import_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

  async refreshChatStats(): Promise<void> {
    this.db.exec(
      `UPDATE chats
       SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.chat_id = chats.id),
           participant_count = (SELECT COUNT(*) FROM chat_participants WHERE chat_participants.chat_id = chats.id),
           last_message_at_ms = (SELECT MAX(timestamp_ms) FROM messages WHERE messages.chat_id = chats.id),
           last_message_at = (
             SELECT sent_at FROM messages
             WHERE messages.chat_id = chats.id
             ORDER BY timestamp_ms DESC, id DESC
             LIMIT 1
           )`
    );
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
      latestWarnings
    };
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
          AND visible_messages.message_type NOT IN ('system', 'status')
          AND (
            visible_messages.direction IN ('incoming', 'outgoing')
            OR NULLIF(TRIM(COALESCE(visible_messages.body, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(visible_messages.caption, '')), '') IS NOT NULL
            OR visible_messages.has_media = 1
            OR visible_messages.is_deleted = 1
            OR visible_messages.message_type = 'call'
          )
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

  async close(): Promise<void> {
    this.db.close();
  }

  private getContactIds(jids: string[]): Map<string, number> {
    return getIds(this.db, "contacts", "source_jid", jids);
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
}

function configureDatabase(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function ensureSchema(db: Database.Database): void {
  db.exec(schemaStatements.join(";\n"));
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

function totalsOrEmpty(totals: ImportTotals | null | undefined): ImportTotals {
  return totals ?? { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
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

function currentIso(): string {
  return new Date().toISOString();
}

function isoFromMs(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
