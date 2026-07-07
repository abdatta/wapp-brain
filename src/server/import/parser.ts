import type Database from "better-sqlite3";
import type {
  ChatRecord,
  ContactRecord,
  ImportWarning,
  MessageRecord,
  ParticipantRecord
} from "../../shared/types";
import { inferChatType, normalizeJid, phoneFromJid } from "./jid";
import { boolish, directionFromFromMe, messageTypeFromCode, normalizeTimestampMs } from "./messageTypes";
import {
  columnsFor,
  hasColumns,
  hasTable,
  inspectSQLite,
  pickColumn,
  quoteIdentifier,
  SQLiteInspection,
  tableColumnNames
} from "./sqlite";
import { messageKey, surrogateMessageId } from "../identity/keys";

type SqlRow = Record<string, unknown>;
const ROW_WARNING_LIMIT = 50;

const LEGACY_MESSAGE_COLUMNS = [
  "_id",
  "key_remote_jid",
  "remote_jid",
  "key_from_me",
  "from_me",
  "key_id",
  "remote_resource",
  "participant_hash",
  "data",
  "text_data",
  "timestamp",
  "received_timestamp",
  "media_wa_type",
  "message_type",
  "media_mime_type",
  "media_name",
  "media_size",
  "media_caption",
  "caption",
  "quoted_row_id",
  "status",
  "starred",
  "forwarded"
];

const MODERN_MESSAGE_COLUMNS = [
  "_id",
  "chat_row_id",
  "chat_id",
  "sender_jid_row_id",
  "sender_id",
  "from_me",
  "key_from_me",
  "key_id",
  "timestamp",
  "received_timestamp",
  "message_type",
  "media_wa_type",
  "text_data",
  "data",
  "caption",
  "quoted_message_row_id",
  "status",
  "starred",
  "forwarded"
];

export interface ParsedWhatsAppSource {
  contacts: ContactRecord[];
  chats: ChatRecord[];
  identityLinks: Array<{ lid: string; pn: string }>;
  warnings: ImportWarning[];
  iterateMessages: () => IterableIterator<MessageRecord>;
  getParticipants: () => ParticipantRecord[];
  getSkippedRows: () => number;
  schemaReport: Record<string, string[]>;
  supported: boolean;
  messageCountEstimate: number | null;
}

export function parseWhatsAppSource(
  msgstoreDb: Database.Database,
  waDb?: Database.Database | null,
  sourceFingerprint?: string | null
): ParsedWhatsAppSource {
  const msgInspection = inspectSQLite(msgstoreDb);
  const waInspection = waDb ? inspectSQLite(waDb) : null;
  const warnings: ImportWarning[] = [];
  const contactMap = new Map<string, ContactRecord>();
  const participantMap = new Map<string, ParticipantRecord>();
  let skippedRows = 0;

  const jidMap = buildJidMap(msgstoreDb, msgInspection);
  const chatRowJidMap = buildChatRowJidMap(msgstoreDb, msgInspection, jidMap);
  const identityLinks: Array<{ lid: string; pn: string }> = [];
  readWaContacts(waDb, waInspection, contactMap, warnings, identityLinks);
  readJidContacts(jidMap, contactMap);
  contactMap.set("me", {
    sourceJid: "me",
    displayName: "Me",
    rawMetadata: { source: "synthetic-self" }
  });

  const chats = readChats(msgstoreDb, msgInspection, jidMap, chatRowJidMap, contactMap, warnings);
  if (chats.length === 0) {
    warnings.push({
      severity: "warning",
      code: "NO_CHATS_DISCOVERED",
      entityType: "chat",
      message: "No chats were discovered from supported chat tables."
    });
  }

  const adapter = chooseMessageAdapter(msgInspection);
  const messageCountEstimate = adapter ? countMessageRows(msgstoreDb, adapter) : null;
  if (!adapter) {
    warnings.push({
      severity: "error",
      code: "UNSUPPORTED_MSGSTORE_SCHEMA",
      entityType: "message",
      message: "No supported WhatsApp message table shape was found.",
      context: { tables: tableColumnNames(msgInspection) }
    });
  }

  return {
    contacts: [...contactMap.values()],
    chats,
    identityLinks,
    warnings,
    supported: Boolean(adapter),
    iterateMessages: function* () {
      if (!adapter) {
        return;
      }
      for (const message of adapter === "legacy"
        ? iterateLegacyMessages(msgstoreDb, msgInspection, contactMap, participantMap, warnings, sourceFingerprint ?? null, () => {
            skippedRows += 1;
          })
        : iterateModernMessages(msgstoreDb, msgInspection, jidMap, chatRowJidMap, contactMap, participantMap, warnings, sourceFingerprint ?? null, () => {
            skippedRows += 1;
          })) {
        yield message;
      }
    },
    getParticipants: () => [...participantMap.values()],
    getSkippedRows: () => skippedRows,
    schemaReport: tableColumnNames(msgInspection),
    messageCountEstimate
  };
}

function countMessageRows(db: Database.Database, adapter: "legacy" | "modern"): number | null {
  const table = adapter === "legacy" ? "messages" : "message";
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number };
    const count = Number(row.count);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

function readWaContacts(
  waDb: Database.Database | null | undefined,
  waInspection: SQLiteInspection | null,
  contactMap: Map<string, ContactRecord>,
  warnings: ImportWarning[],
  identityLinks: Array<{ lid: string; pn: string }> = []
): void {
  if (!waDb || !waInspection) {
    warnings.push({
      severity: "info",
      code: "WA_DB_NOT_PROVIDED",
      entityType: "contact",
      message: "wa.db was not provided; contacts will fall back to JIDs."
    });
    return;
  }
  if (!hasTable(waInspection, "wa_contacts")) {
    warnings.push({
      severity: "warning",
      code: "WA_CONTACTS_MISSING",
      entityType: "contact",
      sourceTable: "wa_contacts",
      message: "wa.db did not contain wa_contacts; contacts will fall back to JIDs."
    });
    return;
  }
  const columns = columnsFor(waInspection, "wa_contacts");
  const jidColumn = pickColumn(columns, ["jid", "raw_string", "wa_id", "number"]);
  if (!jidColumn) {
    warnings.push({
      severity: "warning",
      code: "WA_CONTACTS_JID_MISSING",
      entityType: "contact",
      sourceTable: "wa_contacts",
      message: "wa_contacts did not include a supported JID column."
    });
    return;
  }
  const lidColumn = pickColumn(columns, ["lid_jid", "lid", "lid_raw_string"]);
  const selected = [
    jidColumn,
    ...(lidColumn ? [lidColumn] : []),
    ...["display_name", "wa_name", "notify_name", "given_name", "family_name", "sort_name", "number", "phone_number"]
  ].filter((column, index, all) => columns.has(column) && all.indexOf(column) === index);
  const rows = waDb.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM wa_contacts`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const jid = normalizeJid(row[jidColumn]);
    if (!jid) {
      continue;
    }
    // Newer wa.db builds carry the LID alias next to the phone JID — a
    // first-class identity-link source for merging split records.
    if (lidColumn && jid.endsWith("@s.whatsapp.net")) {
      const lid = normalizeJid(row[lidColumn]);
      if (lid && (lid.endsWith("@lid") || lid.endsWith("@hosted.lid"))) {
        identityLinks.push({ lid, pn: jid });
      }
    }
    const displayName = firstString(row, ["display_name", "wa_name", "notify_name", "given_name", "sort_name"]) ?? null;
    const existing = contactMap.get(jid);
    contactMap.set(jid, {
      sourceJid: jid,
      displayName: displayName || existing?.displayName || null,
      pushName: firstString(row, ["wa_name", "notify_name"]) ?? existing?.pushName ?? null,
      phoneNumber: firstString(row, ["number", "phone_number"]) ?? phoneFromJid(jid),
      rawMetadata: {
        source: "wa_contacts",
        columns: selected.filter((column) => row[column] != null)
      }
    });
  }
}

function buildJidMap(db: Database.Database, inspection: SQLiteInspection): Map<number, string> {
  const map = new Map<number, string>();
  if (!hasTable(inspection, "jid") || !hasColumns(inspection, "jid", ["_id"])) {
    return map;
  }
  const columns = columnsFor(inspection, "jid");
  const selected = ["_id", "raw_string", "user", "server", "agent", "device"].filter((column) => columns.has(column));
  const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM jid`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const id = Number(row._id);
    const raw = normalizeJid(row.raw_string);
    const fromParts = row.user && row.server ? normalizeJid(`${row.user}@${row.server}`) : null;
    const jid = raw ?? fromParts;
    if (Number.isFinite(id) && jid) {
      map.set(id, jid);
    }
  }
  return map;
}

function buildChatRowJidMap(db: Database.Database, inspection: SQLiteInspection, jidMap: Map<number, string>): Map<number, string> {
  const map = new Map<number, string>();
  if (!hasColumns(inspection, "chat", ["_id", "jid_row_id"])) {
    return map;
  }
  const columns = columnsFor(inspection, "chat");
  const selected = ["_id", "jid_row_id", "display_name"].filter((column) => columns.has(column));
  const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM chat`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const chatRowId = Number(row._id);
    const jid = jidMap.get(Number(row.jid_row_id)) ?? normalizeJid(row.display_name);
    if (Number.isFinite(chatRowId) && jid) {
      map.set(chatRowId, jid);
    }
  }
  return map;
}

function readJidContacts(jidMap: Map<number, string>, contactMap: Map<string, ContactRecord>): void {
  for (const jid of jidMap.values()) {
    if (!contactMap.has(jid)) {
      contactMap.set(jid, {
        sourceJid: jid,
        displayName: null,
        phoneNumber: phoneFromJid(jid),
        rawMetadata: { source: "jid" }
      });
    }
  }
}

function readChats(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  chatRowJidMap: Map<number, string>,
  contactMap: Map<string, ContactRecord>,
  warnings: ImportWarning[]
): ChatRecord[] {
  const chats = new Map<string, ChatRecord>();
  readModernChats(db, inspection, jidMap, chatRowJidMap, contactMap, chats);
  readLegacyChats(db, inspection, contactMap, chats);
  deriveChatsFromMessages(db, inspection, chatRowJidMap, contactMap, chats, warnings);
  return [...chats.values()];
}

function readModernChats(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  chatRowJidMap: Map<number, string>,
  contactMap: Map<string, ContactRecord>,
  chats: Map<string, ChatRecord>
): void {
  if (!hasTable(inspection, "chat")) {
    return;
  }
  const columns = columnsFor(inspection, "chat");
  const selected = ["_id", "jid_row_id", "subject", "display_name", "sort_timestamp"].filter((column) => columns.has(column));
  if (!selected.includes("_id")) {
    return;
  }
  const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM chat`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const jid = chatRowJidMap.get(Number(row._id)) ?? jidMap.get(Number(row.jid_row_id)) ?? normalizeJid(row.display_name);
    if (!jid) {
      continue;
    }
    const displayName = firstString(row, ["subject", "display_name"]) ?? contactMap.get(jid)?.displayName ?? null;
    chats.set(jid, {
      sourceChatId: jid,
      jid,
      displayName,
      chatType: inferChatType(jid),
      rawMetadata: {
        source: "chat",
        sourceRowId: String(row._id),
        columns: selected.filter((column) => row[column] != null)
      }
    });
  }
}

function readLegacyChats(
  db: Database.Database,
  inspection: SQLiteInspection,
  contactMap: Map<string, ContactRecord>,
  chats: Map<string, ChatRecord>
): void {
  if (!hasTable(inspection, "chat_list")) {
    return;
  }
  const columns = columnsFor(inspection, "chat_list");
  const jidColumn = pickColumn(columns, ["key_remote_jid", "remote_jid", "jid"]);
  if (!jidColumn) {
    return;
  }
  const selected = [jidColumn, "subject", "display_name", "sort_timestamp", "creation"].filter(
    (column, index, all) => columns.has(column) && all.indexOf(column) === index
  );
  const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM chat_list`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const jid = normalizeJid(row[jidColumn]);
    if (!jid) {
      continue;
    }
    const displayName = firstString(row, ["subject", "display_name"]) ?? contactMap.get(jid)?.displayName ?? null;
    chats.set(jid, {
      sourceChatId: jid,
      jid,
      displayName,
      chatType: inferChatType(jid),
      rawMetadata: {
        source: "chat_list",
        columns: selected.filter((column) => row[column] != null)
      }
    });
  }
}

function deriveChatsFromMessages(
  db: Database.Database,
  inspection: SQLiteInspection,
  chatRowJidMap: Map<number, string>,
  contactMap: Map<string, ContactRecord>,
  chats: Map<string, ChatRecord>,
  warnings: ImportWarning[]
): void {
  if (hasColumns(inspection, "messages", ["key_remote_jid"])) {
    const rows = db.prepare("SELECT DISTINCT key_remote_jid FROM messages WHERE key_remote_jid IS NOT NULL").iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      const jid = normalizeJid(row.key_remote_jid);
      addDerivedChat(jid, contactMap, chats);
    }
  }
  if (hasColumns(inspection, "message", ["chat_row_id"])) {
    const rows = db.prepare("SELECT DISTINCT chat_row_id FROM message WHERE chat_row_id IS NOT NULL").iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      const jid = chatRowJidMap.get(Number(row.chat_row_id));
      addDerivedChat(jid, contactMap, chats);
    }
  }
  if (chats.size === 0 && hasTable(inspection, "message")) {
    warnings.push({
      severity: "warning",
      code: "CHAT_DERIVATION_LIMITED",
      entityType: "chat",
      message: "Messages were present, but chat identifiers could not be mapped from supported columns."
    });
  }
}

function addDerivedChat(jid: string | null | undefined, contactMap: Map<string, ContactRecord>, chats: Map<string, ChatRecord>): void {
  if (!jid || chats.has(jid)) {
    return;
  }
  chats.set(jid, {
    sourceChatId: jid,
    jid,
    displayName: contactMap.get(jid)?.displayName ?? null,
    chatType: inferChatType(jid),
    rawMetadata: { source: "derived_from_messages" }
  });
}

function chooseMessageAdapter(inspection: SQLiteInspection): "legacy" | "modern" | null {
  if (hasColumns(inspection, "messages", ["key_remote_jid", "key_id"])) {
    return "legacy";
  }
  if (
    hasColumns(inspection, "message", ["_id", "chat_row_id"]) &&
    hasColumns(inspection, "chat", ["_id", "jid_row_id"]) &&
    hasColumns(inspection, "jid", ["_id"])
  ) {
    return "modern";
  }
  return null;
}

function* iterateLegacyMessages(
  db: Database.Database,
  inspection: SQLiteInspection,
  contactMap: Map<string, ContactRecord>,
  participantMap: Map<string, ParticipantRecord>,
  warnings: ImportWarning[],
  sourceFingerprint: string | null,
  onSkippedRow: () => void
): IterableIterator<MessageRecord> {
  const columns = columnsFor(inspection, "messages");
  const selected = LEGACY_MESSAGE_COLUMNS.filter((column) => columns.has(column));
  const orderColumn = columns.has("_id") ? "_id" : columns.has("timestamp") ? "timestamp" : selected[0];
  const rows = db
    .prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM messages ORDER BY ${quoteIdentifier(orderColumn)} ASC`)
    .iterate() as Iterable<SqlRow>;
  let fallbackRow = 0;
  for (const row of rows) {
    fallbackRow += 1;
    const sourceRowId = String(row._id ?? fallbackRow);
    const chatJid = normalizeJid(row.key_remote_jid ?? row.remote_jid);
    if (!chatJid) {
      onSkippedRow();
      addRowWarning(warnings, {
        code: "MESSAGE_CHAT_MISSING",
        sourceTable: "messages",
        sourceRowId,
        message: "Skipped a message row because no supported chat identifier was available."
      });
      continue;
    }
    const fromMe = boolish(row.key_from_me ?? row.from_me);
    const rawTypeCode = row.media_wa_type ?? row.message_type ?? 0;
    const messageType = messageTypeFromCode(rawTypeCode);
    const senderJid = fromMe ? "me" : normalizeJid(row.remote_resource) ?? (inferChatType(chatJid) === "group" ? null : chatJid);
    ensureContact(senderJid, contactMap);
    if (senderJid && senderJid !== "me") {
      addParticipant(participantMap, chatJid, senderJid, normalizeTimestampMs(row.timestamp), contactMap);
    }
    const keyId = stringOrNull(row.key_id);
    const timestampMs = normalizeTimestampMs(row.timestamp ?? row.received_timestamp);
    const body = stringOrNull(row.data ?? row.text_data);
    const caption = stringOrNull(row.media_caption ?? row.caption);
    const sourceMessageId = keyId ?? surrogateMessageId("legacy", sourceRowId, sourceFingerprint);
    yield {
      sourceMessageId,
      sourceMessageKey: messageKey(chatJid, sourceMessageId),
      sourceTable: "messages",
      sourceRowId,
      chatSourceId: chatJid,
      senderSourceJid: senderJid,
      timestampMs,
      sentAtIso: timestampMs ? new Date(timestampMs).toISOString() : null,
      fromMe,
      direction: directionFromFromMe(fromMe, messageType),
      messageType,
      rawTypeCode: rawTypeCode == null ? null : String(rawTypeCode),
      body,
      caption,
      hasMedia: messageType !== "text" || Boolean(row.media_mime_type || row.media_name),
      mediaMimeType: stringOrNull(row.media_mime_type),
      mediaName: stringOrNull(row.media_name),
      quotedSourceMessageId: row.quoted_row_id == null ? null : surrogateMessageId("legacy", String(row.quoted_row_id), sourceFingerprint),
      isDeleted: body == null && caption == null && messageType.startsWith("unknown"),
      isForwarded: boolish(row.forwarded),
      isStarred: boolish(row.starred),
      rawMetadata: {
        adapter: "legacy",
        status: row.status ?? null,
        mediaSize: row.media_size ?? null,
        sourceColumns: selected.filter((column) => row[column] != null)
      }
    };
  }
}

function* iterateModernMessages(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  chatRowJidMap: Map<number, string>,
  contactMap: Map<string, ContactRecord>,
  participantMap: Map<string, ParticipantRecord>,
  warnings: ImportWarning[],
  sourceFingerprint: string | null,
  onSkippedRow: () => void
): IterableIterator<MessageRecord> {
  const columns = columnsFor(inspection, "message");
  const selected = MODERN_MESSAGE_COLUMNS.filter((column) => columns.has(column));
  const textJoin = hasColumns(inspection, "message_text", ["message_row_id", "text_data"]);
  const textSelect = textJoin ? `, message_text.text_data AS joined_text_data` : "";
  const textJoinSql = textJoin ? `LEFT JOIN message_text ON message_text.message_row_id = message._id` : "";
  const orderColumn = columns.has("_id") ? "_id" : columns.has("timestamp") ? "timestamp" : selected[0];
  const rows = db
    .prepare(
      `SELECT ${selected.map((column) => `message.${quoteIdentifier(column)} AS ${quoteIdentifier(column)}`).join(", ")}${textSelect}
       FROM message
       ${textJoinSql}
       ORDER BY message.${quoteIdentifier(orderColumn)} ASC`
    )
    .iterate() as Iterable<SqlRow>;
  let fallbackRow = 0;
  for (const row of rows) {
    fallbackRow += 1;
    const sourceRowId = String(row._id ?? fallbackRow);
    const chatRowId = Number(row.chat_row_id ?? row.chat_id);
    const chatJid = chatRowJidMap.get(chatRowId) ?? normalizeJid(row.chat_row_id ?? row.chat_id);
    if (!chatJid) {
      onSkippedRow();
      addRowWarning(warnings, {
        code: "MESSAGE_CHAT_MISSING",
        sourceTable: "message",
        sourceRowId,
        message: "Skipped a message row because no supported chat identifier was available."
      });
      continue;
    }
    const fromMe = boolish(row.from_me ?? row.key_from_me);
    const rawTypeCode = row.message_type ?? row.media_wa_type ?? 0;
    const messageType = messageTypeFromCode(rawTypeCode);
    const senderRowId = Number(row.sender_jid_row_id ?? row.sender_id);
    const senderJid = fromMe ? "me" : jidMap.get(senderRowId) ?? (inferChatType(chatJid) === "group" ? null : chatJid);
    ensureContact(senderJid, contactMap);
    if (senderJid && senderJid !== "me") {
      addParticipant(participantMap, chatJid, senderJid, normalizeTimestampMs(row.timestamp), contactMap);
    }
    const keyId = stringOrNull(row.key_id);
    const timestampMs = normalizeTimestampMs(row.timestamp ?? row.received_timestamp);
    const body = stringOrNull(row.text_data ?? row.joined_text_data ?? row.data);
    const caption = stringOrNull(row.caption);
    const sourceMessageId = keyId ?? surrogateMessageId("modern", sourceRowId, sourceFingerprint);
    yield {
      sourceMessageId,
      sourceMessageKey: messageKey(chatJid, sourceMessageId),
      sourceTable: "message",
      sourceRowId,
      chatSourceId: chatJid,
      senderSourceJid: senderJid,
      timestampMs,
      sentAtIso: timestampMs ? new Date(timestampMs).toISOString() : null,
      fromMe,
      direction: directionFromFromMe(fromMe, messageType),
      messageType,
      rawTypeCode: rawTypeCode == null ? null : String(rawTypeCode),
      body,
      caption,
      hasMedia: messageType !== "text",
      mediaMimeType: null,
      mediaName: null,
      quotedSourceMessageId: row.quoted_message_row_id == null ? null : surrogateMessageId("modern", String(row.quoted_message_row_id), sourceFingerprint),
      isDeleted: body == null && caption == null && messageType.startsWith("unknown"),
      isForwarded: boolish(row.forwarded),
      isStarred: boolish(row.starred),
      rawMetadata: {
        adapter: "modern",
        status: row.status ?? null,
        sourceColumns: [...selected, ...(textJoin ? ["message_text.text_data"] : [])].filter((column) => {
          const alias = column === "message_text.text_data" ? "joined_text_data" : column;
          return row[alias] != null;
        })
      }
    };
  }
}

function addParticipant(
  participantMap: Map<string, ParticipantRecord>,
  chatJid: string,
  participantJid: string,
  timestampMs: number | null,
  contactMap: Map<string, ContactRecord>
): void {
  if (inferChatType(chatJid) !== "group") {
    return;
  }
  const key = `${chatJid}\u0000${participantJid}`;
  const existing = participantMap.get(key);
  participantMap.set(key, {
    chatSourceId: chatJid,
    sourceJid: participantJid,
    displayName: contactMap.get(participantJid)?.displayName ?? null,
    membershipSource: "inferred",
    firstSeenAtMs: existing?.firstSeenAtMs ? Math.min(existing.firstSeenAtMs, timestampMs ?? existing.firstSeenAtMs) : timestampMs,
    lastSeenAtMs: existing?.lastSeenAtMs ? Math.max(existing.lastSeenAtMs, timestampMs ?? existing.lastSeenAtMs) : timestampMs,
    rawMetadata: { source: "messages" }
  });
}

function ensureContact(jid: string | null | undefined, contactMap: Map<string, ContactRecord>): void {
  if (!jid || contactMap.has(jid)) {
    return;
  }
  contactMap.set(jid, {
    sourceJid: jid,
    displayName: null,
    phoneNumber: phoneFromJid(jid),
    rawMetadata: { source: "messages" }
  });
}

function firstString(row: SqlRow, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringOrNull(row[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value);
  return text.length ? text : null;
}

function addRowWarning(
  warnings: ImportWarning[],
  warning: Pick<ImportWarning, "code" | "sourceTable" | "sourceRowId" | "message">
): void {
  const rowWarningCount = warnings.filter((candidate) => candidate.code.startsWith("MESSAGE_")).length;
  if (rowWarningCount < ROW_WARNING_LIMIT) {
    warnings.push({
      severity: "warning",
      entityType: "message",
      ...warning
    });
    return;
  }
  if (!warnings.some((candidate) => candidate.code === "MESSAGE_ROW_WARNINGS_TRUNCATED")) {
    warnings.push({
      severity: "warning",
      code: "MESSAGE_ROW_WARNINGS_TRUNCATED",
      entityType: "message",
      message: "Additional message row warnings were suppressed after the warning limit."
    });
  }
}
