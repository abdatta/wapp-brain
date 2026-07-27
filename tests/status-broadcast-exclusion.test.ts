import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { isStatusChatJid, STATUS_BROADCAST_JID } from "../src/server/import/jid";
import { parseWhatsAppSource } from "../src/server/import/parser";
import { normalizeBaileysMessage, normalizeBaileysMessagesWithJidResolver } from "../src/server/live/normalize";
import { MediaBlobStore } from "../src/server/media/blobStore";
import { messageKey } from "../src/server/identity/keys";
import type { ChatRecord, MessageRecord } from "../src/shared/types";

const REAL_CHAT = "15550000001@s.whatsapp.net";
const identityResolver = (jid: string) => jid;

function makeChat(jid: string, chatType: ChatRecord["chatType"]): ChatRecord {
  return { sourceChatId: jid, jid, displayName: null, chatType, platformRecencyMs: 1712000000000, rawMetadata: {} };
}

function makeMessage(chatJid: string, id: string, timestampMs: number, messageType = "text"): MessageRecord {
  return {
    sourceMessageKey: messageKey(chatJid, id),
    sourceMessageId: id,
    sourceTable: "wa-web:messages.upsert",
    sourceRowId: id,
    chatSourceId: chatJid,
    senderSourceJid: chatJid,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType,
    rawTypeCode: messageType,
    body: `body for ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

/** A status chat that slipped into the archive before this change, plus one real chat. */
async function seedStatusAndRealChat(repository: ArchiveRepository): Promise<void> {
  await repository.upsertChats("import", [makeChat(REAL_CHAT, "dm"), makeChat(STATUS_BROADCAST_JID, "status")]);
  await repository.upsertMessages([
    makeMessage(REAL_CHAT, "REAL-1", 1712000001000),
    // Live status posts are typed by content: these are exactly the rows the old
    // `message_type = 'status'` guards let through.
    makeMessage(STATUS_BROADCAST_JID, "STATUS-IMG", 1712000002000, "image"),
    makeMessage(STATUS_BROADCAST_JID, "STATUS-TXT", 1712000003000, "text")
  ]);
}

describe("status is never ingested", () => {
  it("identifies the status chat by identity, across canonical forms", () => {
    expect(isStatusChatJid(STATUS_BROADCAST_JID)).toBe(true);
    expect(isStatusChatJid("status@broadcast")).toBe(true);
    expect(isStatusChatJid(" status@broadcast ")).toBe(true);
    expect(isStatusChatJid("STATUS@BROADCAST")).toBe(true);

    expect(isStatusChatJid(REAL_CHAT)).toBe(false);
    expect(isStatusChatJid("120363000000000000@g.us")).toBe(false);
    // A real broadcast list is a chat; only WhatsApp Status is excluded.
    expect(isStatusChatJid("1234567890@broadcast")).toBe(false);
    expect(isStatusChatJid("abc@newsletter")).toBe(false);
    expect(isStatusChatJid(null)).toBe(false);
    expect(isStatusChatJid(undefined)).toBe(false);
    expect(isStatusChatJid("")).toBe(false);
  });

  it("drops a status post typed as ordinary image content", () => {
    // Live status posts are typed by content, never `message_type = 'status'` —
    // the hole the old type-keyed guards left open.
    const record = normalizeBaileysMessage(
      {
        key: { remoteJid: STATUS_BROADCAST_JID, id: "STATUS-IMG", fromMe: false },
        messageTimestamp: 1712000001,
        message: { imageMessage: { caption: "my status", mimetype: "image/jpeg" } }
      },
      "wa-web:messages.upsert"
    );

    expect(record).toBeNull();
  });

  it("keeps the rest of a mixed batch while persisting nothing for status", async () => {
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: STATUS_BROADCAST_JID, id: "STATUS-VID", fromMe: false },
          messageTimestamp: 1712000001,
          message: {
            videoMessage: {
              mimetype: "video/mp4",
              mediaKey: new Uint8Array([1, 2, 3]),
              directPath: "/v/t62/status"
            }
          }
        },
        {
          key: { remoteJid: REAL_CHAT, id: "REAL-1", fromMe: false },
          messageTimestamp: 1712000002,
          message: { conversation: "a real message" }
        }
      ],
      "wa-web:messages.upsert",
      identityResolver
    );

    expect(event.messages?.map((message) => message.sourceMessageId)).toEqual(["REAL-1"]);
    // No chat row is minted for status, and no media descriptor is captured —
    // descriptor capture is exactly what the boundary filter runs ahead of.
    expect(event.chats?.map((chat) => chat.sourceChatId)).toEqual([REAL_CHAT]);
    expect(event.mediaDescriptors ?? []).toHaveLength(0);
  });

  it("drops status receipts, reactions, and edits addressed to the status chat", async () => {
    const { normalizeBaileysReactionsWithJidResolver, normalizeBaileysReceiptsWithJidResolver, normalizeDeleteUpdate } =
      await import("../src/server/live/normalize");

    const reactions = await normalizeBaileysReactionsWithJidResolver(
      [{ key: { remoteJid: STATUS_BROADCAST_JID, id: "STATUS-IMG" }, reaction: { text: "👍", key: { participant: REAL_CHAT } } }],
      identityResolver
    );
    const receipts = await normalizeBaileysReceiptsWithJidResolver(
      [{ key: { remoteJid: STATUS_BROADCAST_JID, id: "STATUS-IMG" }, receipt: { userJid: REAL_CHAT, readTimestamp: 1712000003 } }],
      identityResolver
    );

    expect(reactions.updates ?? []).toHaveLength(0);
    expect(receipts.updates ?? []).toHaveLength(0);
    expect(normalizeDeleteUpdate({ remoteJid: STATUS_BROADCAST_JID, id: "STATUS-IMG" })).toBeNull();
  });

  it("skips status rows on the backup-import path and reports them as a diagnostic", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT, user TEXT, server TEXT);
      CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER NOT NULL, subject TEXT, display_name TEXT, sort_timestamp INTEGER);
      CREATE TABLE message (
        _id INTEGER PRIMARY KEY, chat_row_id INTEGER NOT NULL, sender_jid_row_id INTEGER, from_me INTEGER NOT NULL,
        key_id TEXT NOT NULL, timestamp INTEGER, message_type INTEGER, status INTEGER, starred INTEGER, forwarded INTEGER
      );
      CREATE TABLE message_text (message_row_id INTEGER PRIMARY KEY, text_data TEXT);
    `);
    db.prepare("INSERT INTO jid (_id, raw_string, user, server) VALUES (?, ?, ?, ?)").run(1, REAL_CHAT, "15550000001", "s.whatsapp.net");
    db.prepare("INSERT INTO jid (_id, raw_string, user, server) VALUES (?, ?, ?, ?)").run(2, STATUS_BROADCAST_JID, "status", "broadcast");
    db.prepare("INSERT INTO chat (_id, jid_row_id, sort_timestamp) VALUES (?, ?, ?)").run(10, 1, 1711000002000);
    db.prepare("INSERT INTO chat (_id, jid_row_id, sort_timestamp) VALUES (?, ?, ?)").run(11, 2, 1711000003000);
    const insertMessage = db.prepare(`
      INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, status, starred, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
    `);
    insertMessage.run(100, 10, 1, 0, "REAL-1", 1711000001000);
    insertMessage.run(101, 11, 1, 0, "STATUS-1", 1711000002000);
    db.prepare("INSERT INTO message_text (message_row_id, text_data) VALUES (?, ?)").run(100, "a real message");
    db.prepare("INSERT INTO message_text (message_row_id, text_data) VALUES (?, ?)").run(101, "my status");

    try {
      const parsed = parseWhatsAppSource(db);
      const messages = [...parsed.iterateMessages()];

      expect(parsed.chats.map((chat) => chat.jid)).toEqual([REAL_CHAT]);
      expect(messages.map((message) => message.sourceMessageId)).toEqual(["REAL-1"]);
      expect(parsed.getSkippedStatusRows()).toBe(1);
      // Skipped status is reported, never silent — a skipped count must not read as data loss.
      expect(parsed.warnings.some((warning) => warning.code === "STATUS_ROWS_SKIPPED")).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("status is never brain-processed (defense in depth)", () => {
  it("never selects a residual status chat as backlog or evidence in SQLite", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-status-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await seedStatusAndRealChat(repository);

      const backlog = await repository.getBrainChatBacklog({ limit: 20 });
      const evidence = await repository.listMemoryEvidenceMessages({ limit: 50 });
      // An explicitly status-scoped read must stay empty too — no back door.
      const scoped = await repository.getBrainChatBacklog({ limit: 20, chatSourceId: STATUS_BROADCAST_JID });
      const chats = await repository.listChats({ limit: 20, offset: 0 });

      expect(backlog.map((item) => item.chatSourceId)).toEqual([REAL_CHAT]);
      expect(evidence.map((message) => message.sourceChatId)).toEqual([REAL_CHAT]);
      expect(scoped).toHaveLength(0);
      // The status chat has no *visible* message, so it drops out of the chat list.
      expect(chats.map((chat) => chat.sourceChatId)).toEqual([REAL_CHAT]);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mirrors the exclusion in the in-memory repository", async () => {
    const repository = new MemoryArchiveRepository();
    await seedStatusAndRealChat(repository);

    const backlog = await repository.getBrainChatBacklog({ limit: 20 });
    const evidence = await repository.listMemoryEvidenceMessages({ limit: 50 });

    expect(backlog.map((item) => item.chatSourceId)).toEqual([REAL_CHAT]);
    expect(evidence.map((message) => message.sourceChatId)).toEqual([REAL_CHAT]);
  });
});

describe("status excision", () => {
  it("removes every status row, is idempotent, and never unlinks a shared blob", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-excise-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await seedStatusAndRealChat(repository);

      // Two blobs: one status-only (must go) and one whose content hash a real
      // chat also references (must survive — the store is content-addressed).
      // The store uses the configured media root, isolated by tests/setup.
      const store = new MediaBlobStore();
      const soleBlob = await store.putBytes(new TextEncoder().encode("status-only bytes"));
      const sharedBlob = await store.putBytes(new TextEncoder().encode("shared with a real chat"));
      const asset = (chatJid: string, messageId: string, blob: { sha256: string; storagePath: string; byteSize: number }) => ({
        messageKey: messageKey(chatJid, messageId),
        chatSourceId: chatJid,
        sha256: blob.sha256,
        storagePath: blob.storagePath,
        mimeType: "image/jpeg",
        byteSize: blob.byteSize,
        source: "live-download" as const,
        isViewOnce: false,
        width: null,
        height: null,
        durationMs: null
      });
      await repository.linkMediaAsset(asset(STATUS_BROADCAST_JID, "STATUS-IMG", soleBlob));
      await repository.linkMediaAsset(asset(STATUS_BROADCAST_JID, "STATUS-TXT", sharedBlob));
      await repository.linkMediaAsset(asset(REAL_CHAT, "REAL-1", sharedBlob));

      // A dry run reports the same shape and changes nothing.
      const preview = await repository.exciseStatusBroadcast({ dryRun: true });
      const allChats = async () =>
        (await repository!.listChats({ limit: 50, offset: 0, includeEventOnly: true })).map((chat) => chat.sourceChatId);

      expect(preview.dryRun).toBe(true);
      expect(preview.totalRows).toBeGreaterThan(0);
      expect(await allChats()).toContain(STATUS_BROADCAST_JID);

      const report = await repository.exciseStatusBroadcast();

      expect(report.dryRun).toBe(false);
      expect(rowsFor(report, "messages")).toBe(2);
      expect(rowsFor(report, "chats")).toBe(1);
      expect(rowsFor(report, "media_assets")).toBe(2);
      expect(report.blobsDeleted).toBe(1);
      expect(report.blobsSharedKept).toBe(1);
      expect(report.bytesReclaimed).toBe(soleBlob.byteSize);
      expect(report.blobErrors).toEqual([]);
      // The status-only blob is gone; the shared one is untouched.
      expect(await store.stat(soleBlob.storagePath)).toBeNull();
      expect(await store.stat(sharedBlob.storagePath)).not.toBeNull();
      // The real chat and its message survive intact.
      expect(await allChats()).toEqual([REAL_CHAT]);

      const second = await repository.exciseStatusBroadcast();
      expect(second.totalRows).toBe(0);
      expect(second.blobsDeleted).toBe(0);
      expect(second.bytesReclaimed).toBe(0);
      expect(second.chatId).toBeNull();
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports nothing to do on an archive that never held status", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("import", [makeChat(REAL_CHAT, "dm")]);

    const report = await repository.exciseStatusBroadcast();

    expect(report.totalRows).toBe(0);
    expect(report.chatId).toBeNull();
  });
});

function rowsFor(report: { rowsByTable: Array<{ table: string; rows: number }> }, table: string): number {
  return report.rowsByTable.find((entry) => entry.table === table)?.rows ?? 0;
}
