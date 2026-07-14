import type Database from "better-sqlite3";
import type {
  ChatRecord,
  ContactRecord,
  ImportWarning,
  LiveMessageUpdateRecord,
  MediaDownloadDescriptor,
  MessageRecord,
  MessageSecretRecord,
  ParticipantRecord,
  QuotedMessageSnapshot
} from "../../shared/types";
import { inferChatType, isMaskedNumberLabel, normalizeJid, phoneFromJid } from "./jid";
import { boolish, directionFromFromMe, isMediaMessageType, messageTypeFromCode, normalizeTimestampMs } from "./messageTypes";
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

// One media message's backup-side mapping: where its file lived, how to
// verify it (content hash), and enough metadata to link the stored asset.
export interface ImportMediaRef {
  chatSourceId: string;
  sourceMessageId: string;
  messageType: string;
  filePath: string | null;
  fileSize: number | null;
  mimeType: string | null;
  mediaName: string | null;
  fileHashB64: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isViewOnce: boolean;
  thumbnail: Buffer | null;
  // Present only for media with no local file but a usable CDN descriptor: the
  // importer enqueues it for background recovery instead of leaving it missing.
  downloadDescriptor?: MediaDownloadDescriptor | null;
}

// LID→phone links carry their origin so the archive records truthful
// per-source provenance (links are irrevocable; provenance is the audit trail).
export interface ImportIdentityLink {
  lid: string;
  pn: string;
  source: "wa.db" | "msgstore.jid_map";
}

export interface ParsedWhatsAppSource {
  contacts: ContactRecord[];
  chats: ChatRecord[];
  identityLinks: ImportIdentityLink[];
  warnings: ImportWarning[];
  iterateMessages: () => IterableIterator<MessageRecord>;
  // Backup add-on records (reactions, poll votes, event responses) as the same
  // targeted state updates the live path applies to original messages.
  iterateAddOnUpdates: () => IterableIterator<Omit<LiveMessageUpdateRecord, "applied">>;
  // Per-message secrets carried by the backup (message_secret), keyed by the
  // message's canonical identity — arms late decryption retroactively.
  iterateMessageSecrets: () => IterableIterator<MessageSecretRecord>;
  // Media sidecar mappings (message_media, message_view_once_media, thumbnail
  // tables) used to match files in the user-provided media folder.
  iterateMediaRefs: () => IterableIterator<ImportMediaRef>;
  // Available after iterateMessages completes: stale edit-key identities to
  // collapse onto their canonical (original-key) rows.
  getEditRekeys: () => Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>;
  getParticipants: () => ParticipantRecord[];
  getSkippedRows: () => number;
  schemaReport: Record<string, string[]>;
  supported: boolean;
  messageCountEstimate: number | null;
  mediaRefCountEstimate: number;
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
  const identityLinks: ImportIdentityLink[] = [];
  // Source precedence is ordering: wa.db address-book names land first, the
  // msgstore LID display cache only fills identities wa.db left unnamed, and
  // bare JID stubs come last. msgstore's own tables (jid_map, lid_display_name)
  // are what cover contacts wa.db no longer carries — numbers that left
  // WhatsApp keep their chat-level mapping and phone-side label there.
  readWaContacts(waDb, waInspection, contactMap, warnings, identityLinks);
  readMsgstoreIdentityLinks(msgstoreDb, msgInspection, jidMap, identityLinks);
  readLidDisplayNames(msgstoreDb, msgInspection, jidMap, contactMap);
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
  // Empty maps for legacy schemas — every sidecar table is guarded.
  const sidecars = loadInterpretationSidecars(msgstoreDb, msgInspection, jidMap, chatRowJidMap, warnings);
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
        : iterateModernMessages(msgstoreDb, msgInspection, jidMap, chatRowJidMap, contactMap, participantMap, warnings, sourceFingerprint ?? null, sidecars, () => {
            skippedRows += 1;
          })) {
        yield message;
      }
    },
    iterateAddOnUpdates: function* () {
      if (adapter !== "modern") {
        return;
      }
      yield* iterateModernAddOnUpdates(msgstoreDb, msgInspection, jidMap, chatRowJidMap, sidecars.edits);
    },
    getEditRekeys: () => [...sidecars.editRekeys],
    iterateMessageSecrets: function* () {
      if (adapter !== "modern" || !hasColumns(msgInspection, "message_secret", ["message_row_id", "message_secret"])) {
        return;
      }
      const rows = msgstoreDb
        .prepare(
          `SELECT s.message_secret AS secret, m._id AS row_id, m.key_id AS key_id, m.chat_row_id AS chat_row_id
           FROM message_secret s
           JOIN message m ON m._id = s.message_row_id`
        )
        .iterate() as Iterable<SqlRow>;
      for (const row of rows) {
        const chatJid = chatRowJidMap.get(Number(row.chat_row_id));
        const edit = sidecars.edits.get(Number(row.row_id));
        const messageId = edit?.originalKeyId ?? stringOrNull(row.key_id);
        const secret = row.secret;
        if (!chatJid || !messageId || !(secret instanceof Buffer) || secret.length === 0) {
          continue;
        }
        yield { chatSourceId: chatJid, sourceMessageId: messageId, secret, source: "backup" };
      }
    },
    iterateMediaRefs: function* () {
      // Media-folder mapping requires the modern sidecar tables; legacy
      // schemas keep their inline mime/name and are honestly import_missing.
      if (adapter !== "modern" || sidecars.media.size === 0 || !hasColumns(msgInspection, "message", ["_id", "chat_row_id"])) {
        return;
      }
      const thumbnailStmt = hasColumns(msgInspection, "message_thumbnail", ["message_row_id", "thumbnail"])
        ? msgstoreDb.prepare(`SELECT thumbnail FROM message_thumbnail WHERE message_row_id = ?`)
        : null;
      const columns = columnsFor(msgInspection, "message");
      const selected = ["_id", "chat_row_id", "key_id", "message_type", "from_me", "key_from_me", "sender_jid_row_id"].filter(
        (column) => columns.has(column)
      );
      const rows = msgstoreDb
        .prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM message ORDER BY _id ASC`)
        .iterate() as Iterable<SqlRow>;
      for (const row of rows) {
        const rowId = Number(row._id);
        const media = sidecars.media.get(rowId);
        if (!media) {
          continue;
        }
        const chatJid = chatRowJidMap.get(Number(row.chat_row_id));
        if (!chatJid) {
          continue;
        }
        // Media links target the message's canonical identity — the original
        // key for edited rows, matching how the message itself was archived.
        const edit = sidecars.edits.get(rowId);
        const messageId = edit?.originalKeyId ?? stringOrNull(row.key_id) ?? surrogateMessageId("modern", String(rowId), sourceFingerprint ?? null);
        const messageType = messageTypeFromCode(row.message_type ?? 0);
        const thumbnailRow = thumbnailStmt ? (thumbnailStmt.get(rowId) as { thumbnail: Buffer | null } | undefined) : undefined;
        // No local file recorded, but the backup may still hold the CDN
        // descriptor — surface it so the importer can enqueue a recovery.
        const downloadDescriptor = media.filePath
          ? null
          : buildImportDownloadDescriptor(media, messageType, {
              chatJid,
              keyId: stringOrNull(row.key_id),
              fromMe: boolish(row.from_me ?? row.key_from_me),
              senderJid: jidMap.get(Number(row.sender_jid_row_id)) ?? null
            });
        yield {
          chatSourceId: chatJid,
          sourceMessageId: messageId,
          messageType,
          filePath: media.filePath,
          fileSize: media.fileSize,
          mimeType: media.mimeType,
          mediaName: media.mediaName,
          fileHashB64: media.fileHashB64,
          width: media.width,
          height: media.height,
          durationMs: media.durationMs,
          isViewOnce: media.viewOnce || messageType.startsWith("view_once"),
          thumbnail: thumbnailRow?.thumbnail instanceof Buffer && thumbnailRow.thumbnail.length > 0 ? thumbnailRow.thumbnail : null,
          downloadDescriptor
        };
      }
    },
    getParticipants: () => [...participantMap.values()],
    getSkippedRows: () => skippedRows,
    schemaReport: tableColumnNames(msgInspection),
    messageCountEstimate,
    mediaRefCountEstimate: adapter === "modern" ? sidecars.media.size : 0
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
  identityLinks: ImportIdentityLink[] = []
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
      if (lid && isLidJid(lid)) {
        identityLinks.push({ lid, pn: jid, source: "wa.db" });
      }
    }
    // A masked-number placeholder (e.g. "+91∙∙∙∙∙∙∙∙86") is WhatsApp's stand-in
    // for an unsaved contact — never a real name; drop it so it can never enter
    // the archive as one and shadow the full number we already hold.
    const displayName = dropMaskedName(firstString(row, ["display_name", "wa_name", "notify_name", "given_name", "sort_name"]));
    const existing = contactMap.get(jid);
    contactMap.set(jid, {
      sourceJid: jid,
      displayName: displayName || existing?.displayName || null,
      pushName: dropMaskedName(firstString(row, ["wa_name", "notify_name"])) ?? existing?.pushName ?? null,
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

function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
}

// msgstore's jid_map is the phone's own LID↔phone routing table. It keeps
// mappings for every chat the phone has — including numbers no longer
// registered on WhatsApp, which never appear in wa.db or app-state sync.
function readMsgstoreIdentityLinks(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  identityLinks: ImportIdentityLink[]
): void {
  if (!hasTable(inspection, "jid_map") || !hasColumns(inspection, "jid_map", ["lid_row_id", "jid_row_id"])) {
    return;
  }
  const rows = db.prepare(`SELECT lid_row_id, jid_row_id FROM jid_map`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const lid = jidMap.get(Number(row.lid_row_id));
    const pn = jidMap.get(Number(row.jid_row_id));
    if (lid && isLidJid(lid) && pn?.endsWith("@s.whatsapp.net")) {
      identityLinks.push({ lid, pn, source: "msgstore.jid_map" });
    }
  }
}

// lid_display_name is the phone's display cache for LID users — the exact
// label the phone shows. It only fills identities that have no name from a
// stronger source (wa.db address-book names run first).
function readLidDisplayNames(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  contactMap: Map<string, ContactRecord>
): void {
  if (!hasTable(inspection, "lid_display_name") || !hasColumns(inspection, "lid_display_name", ["lid_row_id", "display_name"])) {
    return;
  }
  const rows = db.prepare(`SELECT lid_row_id, display_name FROM lid_display_name`).iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const lid = jidMap.get(Number(row.lid_row_id));
    const displayName = stringOrNull(row.display_name)?.trim() || null;
    if (!lid || !isLidJid(lid) || !displayName) {
      continue;
    }
    const existing = contactMap.get(lid);
    if (existing?.displayName) {
      continue;
    }
    contactMap.set(lid, {
      sourceJid: lid,
      displayName,
      pushName: existing?.pushName ?? null,
      phoneNumber: existing?.phoneNumber ?? null,
      rawMetadata: { source: "lid_display_name" }
    });
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
    const displayName = dropMaskedName(firstString(row, ["subject", "display_name"])) ?? contactMap.get(jid)?.displayName ?? null;
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
    const displayName = dropMaskedName(firstString(row, ["subject", "display_name"])) ?? contactMap.get(jid)?.displayName ?? null;
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
      hasMedia: isMediaMessageType(messageType) || Boolean(row.media_mime_type || row.media_name),
      mediaMimeType: stringOrNull(row.media_mime_type),
      mediaName: stringOrNull(row.media_name),
      quotedSourceMessageId: row.quoted_row_id == null ? null : surrogateMessageId("legacy", String(row.quoted_row_id), sourceFingerprint),
      // Deletion is a fact (revocation records), never inferred from an
      // unrecognized type — unknowns render as honest legacy placeholders.
      isDeleted: messageType === "admin_revoked" || messageType === "revoked",
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

// Sidecar-table content for mapped types: what a message *was* (poll question,
// event, template text, invite) lives beside the main row in modern schemas.
// Keys are message _id row ids; every table is optional per-archive.
interface InterpretationSidecars {
  polls: Map<number, { options: Array<{ name: string; votes: number }>; selectableOptionsCount: number | null }>;
  events: Map<number, SqlRow>;
  eventInvites: Map<number, SqlRow>;
  templates: Map<number, { contentText: string | null; footerText: string | null; buttons: string[] }>;
  uiElements: Map<number, SqlRow>;
  groupInvites: Map<number, SqlRow>;
  revoked: Map<number, { revokedByJid: string | null; revokedAtMs: number | null }>;
  calls: Map<number, { videoCall: boolean; durationSeconds: number | null; missed: boolean }>;
  // Android re-keys an edited message in place: the row's key_id becomes the
  // latest edit's key while message_edit_info preserves the original. Live
  // sync archives the message under that original key, so the original is the
  // canonical identity across sources.
  edits: Map<number, { originalKeyId: string | null; editedAtMs: number | null }>;
  // Stale identities superseded by the original-key convergence: archives
  // written by earlier importer versions hold edited rows under their edit
  // key; these pairs let the importer collapse them onto the canonical row.
  editRekeys: Array<{ chatSourceId: string; staleMessageId: string; canonicalMessageId: string }>;
  // Media sidecar (message_media / message_view_once_media): file path, size,
  // mime, name, and content hash used both to keep modern mime/name on the
  // message row and to match files in the user-provided media folder.
  media: Map<number, MediaSidecarInfo>;
  quotedSnapshots: Map<number, QuotedMessageSnapshot>;
  // Current Android schemas put the reply's own message row id on
  // message_quoted, rather than putting a quoted-row pointer on message.
  quotedSnapshotsByReplyRowId: Map<number, QuotedMessageSnapshot>;
}

interface MediaSidecarInfo {
  filePath: string | null;
  fileSize: number | null;
  mimeType: string | null;
  mediaName: string | null;
  fileHashB64: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  viewOnce: boolean;
  // Encrypted CDN download descriptor — used to recover media the phone never
  // saved locally (file_path NULL). media_key is the only binary column.
  mediaKeyB64: string | null;
  encFileHashB64: string | null;
  directPath: string | null;
  url: string | null;
  mediaKeyTimestamp: number | null;
  fileLength: number | null;
}

function loadInterpretationSidecars(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  chatRowJidMap: Map<number, string>,
  warnings: ImportWarning[]
): InterpretationSidecars {
  const sidecars: InterpretationSidecars = {
    polls: new Map(),
    events: new Map(),
    eventInvites: new Map(),
    templates: new Map(),
    uiElements: new Map(),
    groupInvites: new Map(),
    revoked: new Map(),
    calls: new Map(),
    edits: new Map(),
    editRekeys: [],
    media: new Map(),
    quotedSnapshots: new Map(),
    quotedSnapshotsByReplyRowId: new Map()
  };
  const rowsOf = (table: string, columns: string[]): SqlRow[] => {
    if (!hasColumns(inspection, table, columns)) {
      return [];
    }
    try {
      return db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as SqlRow[];
    } catch {
      return [];
    }
  };

  for (const row of rowsOf("message_poll", ["message_row_id"])) {
    sidecars.polls.set(Number(row.message_row_id), {
      options: [],
      selectableOptionsCount: row.selectable_options_count == null ? null : Number(row.selectable_options_count)
    });
  }
  for (const row of rowsOf("message_poll_option", ["message_row_id", "option_name"])) {
    const poll = sidecars.polls.get(Number(row.message_row_id)) ?? { options: [], selectableOptionsCount: null };
    poll.options.push({ name: String(row.option_name ?? ""), votes: Number(row.vote_total ?? 0) });
    sidecars.polls.set(Number(row.message_row_id), poll);
  }
  for (const row of rowsOf("message_event", ["message_row_id", "name"])) {
    sidecars.events.set(Number(row.message_row_id), row);
  }
  for (const row of rowsOf("message_event_invite", ["message_row_id", "event_title"])) {
    sidecars.eventInvites.set(Number(row.message_row_id), row);
  }
  for (const row of rowsOf("message_template", ["message_row_id"])) {
    sidecars.templates.set(Number(row.message_row_id), {
      contentText: stringOrNull(row.content_text_data),
      footerText: stringOrNull(row.footer_text_data),
      buttons: []
    });
  }
  for (const row of rowsOf("message_template_button", ["message_row_id", "text_data"])) {
    const template = sidecars.templates.get(Number(row.message_row_id)) ?? { contentText: null, footerText: null, buttons: [] };
    const label = stringOrNull(row.text_data);
    if (label) {
      template.buttons.push(label);
    }
    sidecars.templates.set(Number(row.message_row_id), template);
  }
  for (const row of rowsOf("message_ui_elements", ["message_row_id"])) {
    sidecars.uiElements.set(Number(row.message_row_id), row);
  }
  for (const row of rowsOf("message_group_invite", ["message_row_id", "group_name"])) {
    sidecars.groupInvites.set(Number(row.message_row_id), row);
  }
  for (const row of rowsOf("message_revoked", ["message_row_id"])) {
    const adminRowId = row.admin_jid_row_id == null ? null : Number(row.admin_jid_row_id);
    const revokedAtMs = normalizeTimestampMs(row.revoke_timestamp);
    sidecars.revoked.set(Number(row.message_row_id), {
      revokedByJid: adminRowId == null ? null : jidMap.get(adminRowId) ?? null,
      revokedAtMs
    });
  }
  if (hasColumns(inspection, "message_call_log", ["message_row_id", "call_log_row_id"]) && hasColumns(inspection, "call_log", ["_id"])) {
    try {
      const rows = db
        .prepare(
          `SELECT mcl.message_row_id AS message_row_id, cl.video_call AS video_call, cl.duration AS duration
           FROM message_call_log mcl JOIN call_log cl ON cl._id = mcl.call_log_row_id`
        )
        .all() as SqlRow[];
      for (const row of rows) {
        sidecars.calls.set(Number(row.message_row_id), {
          videoCall: boolish(row.video_call),
          durationSeconds: row.duration == null ? null : Number(row.duration),
          missed: false
        });
      }
    } catch {
      // Optional enrichment only.
    }
  }
  for (const row of rowsOf("missed_call_logs", ["message_row_id"])) {
    sidecars.calls.set(Number(row.message_row_id), {
      videoCall: boolish(row.video_call),
      durationSeconds: null,
      missed: true
    });
  }
  for (const row of rowsOf("message_edit_info", ["message_row_id", "original_key_id"])) {
    sidecars.edits.set(Number(row.message_row_id), {
      originalKeyId: stringOrNull(row.original_key_id),
      editedAtMs: normalizeTimestampMs(row.edited_timestamp ?? row.sender_timestamp)
    });
  }
  // Media mappings can run to hundreds of thousands of rows; stream only the
  // columns that exist. message_view_once_media mirrors message_media's shape
  // where present and marks its rows as view-once.
  loadMediaSidecarTable(db, inspection, "message_media", false, sidecars.media);
  loadMediaSidecarTable(db, inspection, "message_view_once_media", true, sidecars.media);
  loadQuotedSnapshotSidecars(
    db,
    inspection,
    jidMap,
    chatRowJidMap,
    warnings,
    sidecars.quotedSnapshots,
    sidecars.quotedSnapshotsByReplyRowId
  );
  return sidecars;
}

function loadMediaSidecarTable(
  db: Database.Database,
  inspection: SQLiteInspection,
  table: string,
  viewOnce: boolean,
  target: Map<number, MediaSidecarInfo>
): void {
  if (!hasColumns(inspection, table, ["message_row_id"])) {
    return;
  }
  const columns = columnsFor(inspection, table);
  const optional = [
    "file_path", "file_size", "mime_type", "media_name", "file_hash", "width", "height", "media_duration",
    // CDN descriptor columns (present on modern message_media): used to recover
    // media whose phone never saved a local file.
    "media_key", "enc_file_hash", "direct_path", "message_url", "media_key_timestamp", "file_length"
  ];
  const selected = ["message_row_id", ...optional.filter((column) => columns.has(column))];
  try {
    const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`).iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      const rowId = Number(row.message_row_id);
      if (!Number.isFinite(rowId)) {
        continue;
      }
      const durationSeconds = row.media_duration == null ? null : Number(row.media_duration);
      const existing = target.get(rowId);
      target.set(rowId, {
        filePath: stringOrNull(row.file_path) ?? existing?.filePath ?? null,
        fileSize: row.file_size == null ? existing?.fileSize ?? null : Number(row.file_size),
        mimeType: stringOrNull(row.mime_type) ?? existing?.mimeType ?? null,
        mediaName: stringOrNull(row.media_name) ?? existing?.mediaName ?? null,
        fileHashB64: stringOrNull(row.file_hash) ?? existing?.fileHashB64 ?? null,
        width: row.width == null ? existing?.width ?? null : Number(row.width),
        height: row.height == null ? existing?.height ?? null : Number(row.height),
        durationMs: durationSeconds == null || !Number.isFinite(durationSeconds) ? existing?.durationMs ?? null : Math.round(durationSeconds * 1000),
        viewOnce: viewOnce || existing?.viewOnce === true,
        mediaKeyB64: blobToBase64(row.media_key) ?? existing?.mediaKeyB64 ?? null,
        encFileHashB64: stringOrNull(row.enc_file_hash) ?? existing?.encFileHashB64 ?? null,
        directPath: stringOrNull(row.direct_path) ?? existing?.directPath ?? null,
        url: stringOrNull(row.message_url) ?? existing?.url ?? null,
        mediaKeyTimestamp: row.media_key_timestamp == null ? existing?.mediaKeyTimestamp ?? null : Number(row.media_key_timestamp),
        fileLength: row.file_length == null ? existing?.fileLength ?? null : Number(row.file_length)
      });
    }
  } catch {
    // Optional enrichment only; a missing/odd table shape must not fail import.
  }
}

// Modern Android stores a quoted-message copy beside the reply. Schemas vary,
// so every table/column is inspected and mapped by explicit known names only.
// Unknown fields are never copied into metadata or logs.
function loadQuotedSnapshotSidecars(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  chatRowJidMap: Map<number, string>,
  warnings: ImportWarning[],
  target: Map<number, QuotedMessageSnapshot>,
  byReplyRowId: Map<number, QuotedMessageSnapshot>
): void {
  if (!hasTable(inspection, "message_quoted")) {
    return;
  }
  const columns = columnsFor(inspection, "message_quoted");
  const idColumn = pickColumn(columns, ["_id", "message_row_id", "quoted_message_row_id", "message_quoted_row_id"]);
  if (!idColumn) {
    addRowWarning(warnings, {
      code: "QUOTED_SNAPSHOT_ID_MISSING",
      sourceTable: "message_quoted",
      message: "Quoted snapshots were skipped because no supported row identifier was available."
    });
    return;
  }
  try {
    const rows = db.prepare(`SELECT * FROM message_quoted`).iterate() as Iterable<SqlRow>;
    for (const row of rows) {
      const id = Number(row[idColumn]);
      if (!Number.isFinite(id)) continue;
      const rawTypeCode = row.message_type ?? row.media_wa_type ?? null;
      const mediaType = rawTypeCode == null ? "unknown" : messageTypeFromCode(rawTypeCode);
      const senderRowId = Number(row.sender_jid_row_id ?? row.sender_id ?? row.participant_jid_row_id);
      const chatRowId = Number(row.chat_row_id ?? row.chat_id ?? row.remote_chat_row_id);
      const keyId = stringOrNull(row.key_id ?? row.quoted_key_id ?? row.stanza_id);
      const snapshot: QuotedMessageSnapshot = {
        quotedSourceMessageId: keyId ?? surrogateMessageId("quoted", String(id), null),
        quotedSourceChatId: Number.isFinite(chatRowId) ? chatRowJidMap.get(chatRowId) ?? null : null,
        quotedSenderSourceJid: boolish(row.from_me ?? row.key_from_me) ? "me" : jidMap.get(senderRowId) ?? null,
        quotedFromMe: row.from_me == null && row.key_from_me == null ? null : boolish(row.from_me ?? row.key_from_me),
        timestampMs: normalizeTimestampMs(row.timestamp ?? row.sender_timestamp),
        messageType: mediaType,
        rawTypeCode: rawTypeCode == null ? null : String(rawTypeCode),
        body: stringOrNull(row.text_data ?? row.data ?? row.message_text),
        caption: stringOrNull(row.caption ?? row.media_caption),
        mediaMimeType: stringOrNull(row.media_mime_type ?? row.mime_type),
        mediaName: stringOrNull(row.media_name ?? row.file_name),
        thumbnail: null,
        location: null,
        vcard: null,
        mentionedJids: []
      };
      target.set(id, snapshot);
      if (idColumn === "message_row_id") {
        byReplyRowId.set(id, snapshot);
      }
    }
  } catch {
    addRowWarning(warnings, {
      code: "QUOTED_SNAPSHOT_READ_FAILED",
      sourceTable: "message_quoted",
      message: "Quoted snapshot rows could not be read; replies will keep their existing pointers."
    });
    return;
  }

  loadQuotedMediaCompanion(db, inspection, target, warnings);
  loadQuotedLocationCompanion(db, inspection, target, warnings);
  loadQuotedVcardCompanion(db, inspection, target, warnings);
  loadQuotedMentionsCompanion(db, inspection, jidMap, target, warnings);
}

function quotedCompanionKey(row: SqlRow): number | null {
  for (const key of ["quoted_message_row_id", "message_quoted_row_id", "quoted_row_id", "message_row_id"]) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function loadQuotedCompanionRows(
  db: Database.Database,
  inspection: SQLiteInspection,
  table: string,
  target: Map<number, QuotedMessageSnapshot>,
  warnings: ImportWarning[],
  apply: (snapshot: QuotedMessageSnapshot, row: SqlRow) => void
): void {
  if (!hasTable(inspection, table)) return;
  try {
    for (const row of db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).iterate() as Iterable<SqlRow>) {
      const key = quotedCompanionKey(row);
      const snapshot = key == null ? null : target.get(key) ?? null;
      if (!snapshot) continue;
      try {
        apply(snapshot, row);
      } catch {
        addRowWarning(warnings, {
          code: "QUOTED_SNAPSHOT_COMPANION_MALFORMED",
          sourceTable: table,
          sourceRowId: row._id == null ? null : String(row._id),
          message: "A malformed quoted-message companion was skipped while preserving its reply."
        });
      }
    }
  } catch {
    addRowWarning(warnings, {
      code: "QUOTED_SNAPSHOT_COMPANION_READ_FAILED",
      sourceTable: table,
      message: "An optional quoted-message companion table could not be read; replies remain available."
    });
  }
}

function loadQuotedMediaCompanion(db: Database.Database, inspection: SQLiteInspection, target: Map<number, QuotedMessageSnapshot>, warnings: ImportWarning[]): void {
  loadQuotedCompanionRows(db, inspection, "message_quoted_media", target, warnings, (snapshot, row) => {
    snapshot.caption = stringOrNull(row.caption ?? row.media_caption) ?? snapshot.caption;
    snapshot.mediaMimeType = stringOrNull(row.mime_type ?? row.media_mime_type) ?? snapshot.mediaMimeType ?? null;
    snapshot.mediaName = stringOrNull(row.media_name ?? row.file_name) ?? snapshot.mediaName ?? null;
    const thumbnail = row.thumbnail ?? row.thumbnail_data;
    if (thumbnail != null && !(thumbnail instanceof Buffer) && !(thumbnail instanceof Uint8Array)) {
      throw new Error("Quoted thumbnail must be bytes");
    }
    snapshot.thumbnail = thumbnail instanceof Buffer && thumbnail.length > 0 ? thumbnail : snapshot.thumbnail ?? null;
  });
}

function loadQuotedLocationCompanion(db: Database.Database, inspection: SQLiteInspection, target: Map<number, QuotedMessageSnapshot>, warnings: ImportWarning[]): void {
  loadQuotedCompanionRows(db, inspection, "message_quoted_location", target, warnings, (snapshot, row) => {
    const latitude = nullableFiniteNumber(row.latitude ?? row.lat);
    const longitude = nullableFiniteNumber(row.longitude ?? row.lng);
    if (((row.latitude ?? row.lat) != null && latitude == null) || ((row.longitude ?? row.lng) != null && longitude == null)) {
      throw new Error("Quoted location coordinates must be numeric");
    }
    snapshot.location = {
      latitude,
      longitude,
      name: stringOrNull(row.name ?? row.place_name),
      address: stringOrNull(row.address)
    };
  });
}

function loadQuotedVcardCompanion(db: Database.Database, inspection: SQLiteInspection, target: Map<number, QuotedMessageSnapshot>, warnings: ImportWarning[]): void {
  loadQuotedCompanionRows(db, inspection, "message_quoted_vcard", target, warnings, (snapshot, row) => {
    snapshot.vcard = { name: stringOrNull(row.name ?? row.display_name), vcard: stringOrNull(row.vcard ?? row.vcard_data) };
  });
}

function loadQuotedMentionsCompanion(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  target: Map<number, QuotedMessageSnapshot>,
  warnings: ImportWarning[]
): void {
  loadQuotedCompanionRows(db, inspection, "message_quoted_mentions", target, warnings, (snapshot, row) => {
    const jid = normalizeJid(row.mentioned_jid ?? row.jid) ?? jidMap.get(Number(row.mentioned_jid_row_id ?? row.jid_row_id)) ?? null;
    if (jid && !(snapshot.mentionedJids ?? []).includes(jid)) {
      snapshot.mentionedJids = [...(snapshot.mentionedJids ?? []), jid];
    }
  });
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// message_media stores media_key as a BLOB; the other hash/path columns are
// already base64/text. The queue descriptor keeps binary fields as base64.
function blobToBase64(value: unknown): string | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.length > 0 ? value.toString("base64") : null;
  if (value instanceof Uint8Array) return value.length > 0 ? Buffer.from(value).toString("base64") : null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

// Android msgstore message-type → the Baileys media type used to derive the
// decrypt key. Only the kinds a passive CDN fetch can recover are mapped;
// anything else yields no descriptor (stays honestly missing).
const DESCRIPTOR_MEDIA_TYPE: Record<string, MediaDownloadDescriptor["mediaType"]> = {
  image: "image",
  view_once_image: "image",
  video: "video",
  gif: "video",
  view_once_video: "video",
  audio: "audio",
  view_once_audio: "audio",
  document: "document",
  sticker: "sticker"
};

// Build a recovery descriptor for a file-less media row. Returns null unless the
// media key is present AND the media is actionable — either a CDN path/url to
// download now, or a raw stanza key to request a re-upload for.
function buildImportDownloadDescriptor(
  media: MediaSidecarInfo,
  messageType: string,
  message: { chatJid: string; keyId: string | null; fromMe: boolean; senderJid: string | null }
): MediaDownloadDescriptor | null {
  const mediaType = DESCRIPTOR_MEDIA_TYPE[messageType];
  if (!mediaType || !media.mediaKeyB64) {
    return null;
  }
  // A media re-upload request must reference the message exactly as the sender
  // addressed it; only the raw stanza key (never a surrogate id) can do that.
  const retryKey = message.keyId
    ? {
        remoteJid: message.chatJid,
        id: message.keyId,
        fromMe: message.fromMe,
        participant: message.fromMe ? null : message.senderJid && message.senderJid !== "me" ? message.senderJid : null
      }
    : null;
  if (!media.directPath && !media.url && !retryKey) {
    return null;
  }
  return {
    mediaType,
    mediaKey: media.mediaKeyB64,
    directPath: media.directPath,
    url: media.url,
    fileEncSha256: media.encFileHashB64,
    fileSha256: media.fileHashB64,
    mediaKeyTimestamp: media.mediaKeyTimestamp,
    mimeType: media.mimeType,
    fileName: media.mediaName,
    fileLength: media.fileLength ?? media.fileSize,
    width: media.width,
    height: media.height,
    durationSeconds: media.durationMs != null ? media.durationMs / 1000 : null,
    retryKey
  };
}

// Body/caption fill only when the main row had none; structured extras land in
// rawMetadata under documented keys (poll, event, template, groupInvite,
// revoked) for downstream consumers. The typed placeholder is the floor.
function enrichFromSidecars(
  messageType: string,
  rowId: number,
  sidecars: InterpretationSidecars
): { body?: string | null; caption?: string | null; metadata?: Record<string, unknown> } {
  if (messageType === "poll") {
    const poll = sidecars.polls.get(rowId);
    return poll && poll.options.length > 0 ? { metadata: { poll } } : {};
  }
  if (messageType === "event") {
    const event = sidecars.events.get(rowId);
    if (event) {
      return {
        body: stringOrNull(event.name),
        caption: stringOrNull(event.description),
        metadata: {
          event: {
            locationName: stringOrNull(event.location_name),
            startTimeMs: normalizeTimestampMs(event.start_time),
            endTimeMs: normalizeTimestampMs(event.end_time),
            joinLink: stringOrNull(event.join_link),
            isCanceled: boolish(event.is_canceled)
          }
        }
      };
    }
    const invite = sidecars.eventInvites.get(rowId);
    if (invite) {
      return {
        body: stringOrNull(invite.event_title),
        caption: stringOrNull(invite.caption),
        metadata: {
          event: {
            startTimeMs: normalizeTimestampMs(invite.start_time),
            endTimeMs: normalizeTimestampMs(invite.end_time),
            isCanceled: boolish(invite.is_canceled),
            joinLink: stringOrNull(invite.call_link)
          }
        }
      };
    }
    return {};
  }
  if (messageType === "template" || messageType === "list") {
    const template = sidecars.templates.get(rowId);
    if (template) {
      return {
        body: template.contentText,
        metadata: { template: { footerText: template.footerText, buttons: template.buttons } }
      };
    }
    const elements = sidecars.uiElements.get(rowId);
    if (elements) {
      return {
        body: stringOrNull(elements.description),
        metadata: {
          template: {
            footerText: stringOrNull(elements.footer_text),
            buttons: [stringOrNull(elements.button_text)].filter((label): label is string => label !== null),
            elementContent: stringOrNull(elements.element_content)
          }
        }
      };
    }
    return {};
  }
  if (messageType === "group_invite") {
    const invite = sidecars.groupInvites.get(rowId);
    if (!invite) {
      return {};
    }
    return {
      body: stringOrNull(invite.group_name),
      metadata: {
        groupInvite: {
          expiresAtMs: normalizeTimestampMs(invite.expiration),
          expired: boolish(invite.expired)
        }
      }
    };
  }
  if (messageType === "admin_revoked" || messageType === "revoked") {
    const revoked = sidecars.revoked.get(rowId);
    // The row's own timestamp is the original post time (verified on the real
    // archive); the revocation moment and actor ride in metadata when known.
    return revoked ? { metadata: { revoked } } : {};
  }
  if (messageType === "call" || messageType === "missed_call") {
    const call = sidecars.calls.get(rowId);
    return call ? { metadata: { call } } : {};
  }
  return {};
}

// Reactions, poll votes, and event responses from message_add_on become the
// same targeted state updates the live path emits: keyed by the parent
// message's canonical identity, deterministic per (target, actor) so
// re-imports stay idempotent. Receipts and pin/edit add-ons are skipped
// (receipts are sync noise; edits converge through message_edit_info).
function* iterateModernAddOnUpdates(
  db: Database.Database,
  inspection: SQLiteInspection,
  jidMap: Map<number, string>,
  chatRowJidMap: Map<number, string>,
  edits: InterpretationSidecars["edits"]
): IterableIterator<Omit<LiveMessageUpdateRecord, "applied">> {
  if (!hasColumns(inspection, "message_add_on", ["_id", "chat_row_id", "parent_message_row_id"])) {
    return;
  }
  const optionNames = new Map<number, string>();
  if (hasColumns(inspection, "message_poll_option", ["_id", "option_name"])) {
    for (const row of db.prepare(`SELECT _id, option_name FROM message_poll_option`).iterate() as Iterable<SqlRow>) {
      optionNames.set(Number(row._id), String(row.option_name ?? ""));
    }
  }
  const selectedOptions = new Map<number, string[]>();
  if (hasColumns(inspection, "message_add_on_poll_vote_selected_option", ["message_add_on_row_id", "message_poll_option_id"])) {
    for (const row of db
      .prepare(`SELECT message_add_on_row_id, message_poll_option_id FROM message_add_on_poll_vote_selected_option`)
      .iterate() as Iterable<SqlRow>) {
      const addOnId = Number(row.message_add_on_row_id);
      const optionName = optionNames.get(Number(row.message_poll_option_id));
      if (optionName == null) {
        continue;
      }
      selectedOptions.set(addOnId, [...(selectedOptions.get(addOnId) ?? []), optionName]);
    }
  }
  const reactionJoin = hasColumns(inspection, "message_add_on_reaction", ["message_add_on_row_id", "reaction"]);
  const voteJoin = hasColumns(inspection, "message_add_on_poll_vote", ["message_add_on_row_id"]);
  const responseJoin = hasColumns(inspection, "message_add_on_event_response", ["message_add_on_row_id", "response"]);
  if (!reactionJoin && !voteJoin && !responseJoin) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT a._id AS add_on_id, a.chat_row_id AS chat_row_id, a.from_me AS from_me,
              a.sender_jid_row_id AS sender_jid_row_id, a.timestamp AS timestamp,
              p._id AS parent_row_id, p.key_id AS parent_key_id
              ${reactionJoin ? ", r.reaction AS reaction" : ", NULL AS reaction"}
              ${voteJoin ? ", v.message_add_on_row_id AS vote_row, v.sender_timestamp AS vote_timestamp" : ", NULL AS vote_row, NULL AS vote_timestamp"}
              ${responseJoin ? ", e.message_add_on_row_id AS response_row, e.response AS event_response, e.extra_guest_count AS extra_guest_count, e.sender_timestamp AS response_timestamp" : ", NULL AS response_row, NULL AS event_response, NULL AS extra_guest_count, NULL AS response_timestamp"}
       FROM message_add_on a
       JOIN message p ON p._id = a.parent_message_row_id
       ${reactionJoin ? "LEFT JOIN message_add_on_reaction r ON r.message_add_on_row_id = a._id" : ""}
       ${voteJoin ? "LEFT JOIN message_add_on_poll_vote v ON v.message_add_on_row_id = a._id" : ""}
       ${responseJoin ? "LEFT JOIN message_add_on_event_response e ON e.message_add_on_row_id = a._id" : ""}
       ORDER BY a._id ASC`
    )
    .iterate() as Iterable<SqlRow>;
  for (const row of rows) {
    const chatJid = chatRowJidMap.get(Number(row.chat_row_id));
    if (!chatJid) {
      continue;
    }
    // Target the parent's canonical identity: edited parents live under their
    // original key across sources.
    const parentEdit = edits.get(Number(row.parent_row_id));
    const targetId = parentEdit?.originalKeyId ?? stringOrNull(row.parent_key_id);
    if (!targetId) {
      continue;
    }
    const targetKey = messageKey(chatJid, targetId);
    const actorJid = boolish(row.from_me) ? "me" : jidMap.get(Number(row.sender_jid_row_id)) ?? null;
    const occurredAtMs = normalizeTimestampMs(row.timestamp);
    const reaction = stringOrNull(row.reaction);
    if (reaction) {
      yield {
        eventKey: `import:reaction:${targetKey}:${actorJid ?? "unknown"}`,
        chatSourceId: chatJid,
        sourceMessageKey: targetKey,
        updateType: "reaction",
        occurredAtMs,
        metadata: { emoji: reaction, reactorJid: actorJid }
      };
      continue;
    }
    if (row.vote_row != null) {
      yield {
        eventKey: `import:poll_vote:${targetKey}:${actorJid ?? "unknown"}`,
        chatSourceId: chatJid,
        sourceMessageKey: targetKey,
        updateType: "poll_vote",
        occurredAtMs: normalizeTimestampMs(row.vote_timestamp) ?? occurredAtMs,
        metadata: { voterJid: actorJid, options: selectedOptions.get(Number(row.add_on_id)) ?? [] }
      };
      continue;
    }
    if (row.response_row != null) {
      yield {
        eventKey: `import:event_response:${targetKey}:${actorJid ?? "unknown"}`,
        chatSourceId: chatJid,
        sourceMessageKey: targetKey,
        updateType: "event_response",
        occurredAtMs: normalizeTimestampMs(row.response_timestamp) ?? occurredAtMs,
        metadata: {
          responderJid: actorJid,
          response: row.event_response == null ? null : Number(row.event_response),
          extraGuestCount: row.extra_guest_count == null ? null : Number(row.extra_guest_count)
        }
      };
    }
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
  sidecars: InterpretationSidecars,
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
    const rowIdNumber = Number(row._id ?? fallbackRow);
    const sidecar = enrichFromSidecars(messageType, rowIdNumber, sidecars);
    const body = stringOrNull(row.text_data ?? row.joined_text_data ?? row.data) ?? sidecar.body ?? null;
    const caption = stringOrNull(row.caption) ?? sidecar.caption ?? null;
    // Edited rows carry the latest edit's key; the original key is the
    // identity live sync archived them under.
    const edit = sidecars.edits.get(rowIdNumber);
    const identityKeyId = edit?.originalKeyId ?? keyId;
    if (edit?.originalKeyId && keyId && edit.originalKeyId !== keyId) {
      sidecars.editRekeys.push({ chatSourceId: chatJid, staleMessageId: keyId, canonicalMessageId: edit.originalKeyId });
    }
    const sourceMessageId = identityKeyId ?? surrogateMessageId("modern", sourceRowId, sourceFingerprint);
    const quotedSnapshot =
      sidecars.quotedSnapshots.get(Number(row.quoted_message_row_id)) ?? sidecars.quotedSnapshotsByReplyRowId.get(rowIdNumber);
    if (quotedSnapshot?.quotedSenderSourceJid && quotedSnapshot.quotedSenderSourceJid !== "me") {
      ensureContact(quotedSnapshot.quotedSenderSourceJid, contactMap);
    }
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
      hasMedia: isMediaMessageType(messageType) || sidecars.media.has(rowIdNumber),
      mediaMimeType: sidecars.media.get(rowIdNumber)?.mimeType ?? null,
      mediaName: sidecars.media.get(rowIdNumber)?.mediaName ?? null,
      quotedSourceMessageId:
        quotedSnapshot?.quotedSourceMessageId ??
        (row.quoted_message_row_id == null ? null : surrogateMessageId("modern", String(row.quoted_message_row_id), sourceFingerprint)),
      quotedSnapshot: quotedSnapshot ? structuredClone(quotedSnapshot) : null,
      // Deletion is a fact (revocation records), never inferred from an
      // unrecognized type — unknowns render as honest legacy placeholders.
      isDeleted: messageType === "admin_revoked" || messageType === "revoked",
      isForwarded: boolish(row.forwarded),
      isStarred: boolish(row.starred),
      rawMetadata: {
        adapter: "modern",
        status: row.status ?? null,
        sourceColumns: [...selected, ...(textJoin ? ["message_text.text_data"] : [])].filter((column) => {
          const alias = column === "message_text.text_data" ? "joined_text_data" : column;
          return row[alias] != null;
        }),
        ...(sidecar.metadata ?? {}),
        ...(edit ? { edited: 1, editedAtMs: edit.editedAtMs, latestEditKeyId: keyId } : {})
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

// A backup-sourced display name, unless it is a masked-number placeholder — in
// which case it is treated as absent (null), the same as if WhatsApp held no
// name for the identity.
function dropMaskedName(value: string | null): string | null {
  return value && !isMaskedNumberLabel(value) ? value : null;
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
