import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRecord, MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import { LiveMaintainer } from "../src/server/live/maintainer";
import type {
  LiveConnectionUpdate,
  LiveGroupMetadataResult,
  LiveMaintainerOptions,
  LiveMessageEvent,
  LiveWhatsAppClient
} from "../src/server/live/types";

const LID = "244543240839423@lid";
const PN = "919051167186@s.whatsapp.net";

describe("identity and naming integrity", () => {
  it("converges backup-shaped and live-shaped copies of the same message onto one row", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("import", [makeChat("15550000001@s.whatsapp.net")]);
    // Backup import path: parser emits key_id as sourceMessageId with a canonical key.
    await repository.upsertMessages([
      { ...makeMessage("15550000001@s.whatsapp.net", "3EB0ABCDEF", 1000), sourceTable: "message", body: null }
    ]);
    // Live path: same WhatsApp message id, different producer, richer content.
    await repository.upsertMessages([
      { ...makeMessage("15550000001@s.whatsapp.net", "3EB0ABCDEF", 1000), sourceTable: "wa-web:messages.upsert", body: "hello" }
    ]);

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("hello");
  });

  it("canonicalizes ingestion through persisted identity links", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.recordIdentityLinks([{ lid: LID, pn: PN }]);
    await repository.upsertChats("live", [makeChat(LID)]);
    await repository.upsertMessages([makeMessage(LID, "m1", 1000)]);

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });

    expect(chats).toHaveLength(1);
    expect(chats[0]?.sourceChatId).toBe(PN);
  });

  it("merges split identities when the mapping is learned late", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("live", [makeChat(LID), { ...makeChat(PN), displayName: "Asha" }]);
    await repository.upsertMessages([
      makeMessage(LID, "lid-only", 1000),
      { ...makeMessage(LID, "shared-id", 2000), body: null },
      { ...makeMessage(PN, "shared-id", 2000), body: "richer copy" },
      makeMessage(PN, "pn-only", 3000)
    ]);
    await repository.upsertLiveCheckpoint({ chatSourceId: LID, health: "healthy", retryCount: 2 });

    await repository.recordIdentityLinks([{ lid: LID, pn: PN }]);
    const first = await repository.mergeIdentity(LID, PN);
    const second = await repository.mergeIdentity(LID, PN);

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(chats).toHaveLength(1);
    expect(chats[0]?.sourceChatId).toBe(PN);
    expect(first.chatsMerged).toBe(1);
    expect(first.messagesCollapsed).toBe(1);
    expect(second.chatsMerged + second.messagesCollapsed).toBe(0);
    expect(messages.map((message) => message.sourceMessageId).sort()).toEqual(["lid-only", "pn-only", "shared-id"]);
    expect(messages.find((message) => message.sourceMessageId === "shared-id")?.body).toBe("richer copy");
    expect((await repository.listLiveCheckpoints([PN]))).toHaveLength(1);
    expect(await repository.listUnmergedLidIdentities()).toHaveLength(0);
  });

  it("merges split identities in the SQLite adapter with both chats populated", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-identity-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const runId = await repository.startImportRun({ fixture: "identity" });
      await repository.upsertChats(runId, [makeChat(LID), { ...makeChat(PN), displayName: "Asha" }]);
      await repository.upsertMessages([
        makeMessage(LID, "lid-only", 1000),
        { ...makeMessage(LID, "shared-id", 2000), body: "richer copy" },
        { ...makeMessage(PN, "shared-id", 2000), body: null },
        makeMessage(PN, "pn-only", 3000)
      ]);

      await repository.recordIdentityLinks([{ lid: LID, pn: PN }]);
      const merged = await repository.mergeIdentity(LID, PN);

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

      expect(chats).toHaveLength(1);
      expect(chats[0]?.displayName).toBe("Asha");
      expect(merged.messagesCollapsed).toBe(1);
      expect(messages.map((message) => message.sourceMessageId).sort()).toEqual(["lid-only", "pn-only", "shared-id"]);
      expect(messages.find((message) => message.sourceMessageId === "shared-id")?.body).toBe("richer copy");
      expect(messages.every((message) => message.sourceMessageId && !message.sourceMessageId.includes("|"))).toBe(true);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to ingest into archives written under the previous identity scheme", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-legacy-"));
    const archivePath = path.join(tempDir, "archive.sqlite");
    try {
      let repository = new SqliteArchiveRepository(archivePath);
      const runId = await repository.startImportRun({ fixture: "legacy" });
      await repository.upsertChats(runId, [makeChat(PN)]);
      await repository.upsertMessages([makeMessage(PN, "m1", 1000)]);
      await repository.close();

      const raw = new Database(archivePath);
      raw.prepare(`DELETE FROM schema_meta WHERE key = 'identity_version'`).run();
      raw.close();

      repository = new SqliteArchiveRepository(archivePath);
      await expect(repository.upsertMessages([makeMessage(PN, "m2", 2000)])).rejects.toThrow("canonical identity");
      const status = await repository.getStatus();
      expect(status.database.error).toContain("re-pair");

      // Clear-and-replace is the sanctioned escape hatch.
      await repository.clearArchiveData();
      const freshRun = await repository.startImportRun({ fixture: "fresh" });
      await repository.upsertChats(freshRun, [makeChat(PN)]);
      expect(await repository.upsertMessages([makeMessage(PN, "m3", 3000)])).toBe(1);
      await repository.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-arms the legacy gate when a failed replace import rolls back", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-legacy-rollback-"));
    const archivePath = path.join(tempDir, "archive.sqlite");
    try {
      let repository = new SqliteArchiveRepository(archivePath);
      const runId = await repository.startImportRun({ fixture: "legacy" });
      await repository.upsertChats(runId, [makeChat(PN)]);
      await repository.upsertMessages([makeMessage(PN, "m1", 1000)]);
      await repository.close();

      const raw = new Database(archivePath);
      raw.prepare(`DELETE FROM schema_meta WHERE key = 'identity_version'`).run();
      raw.close();

      repository = new SqliteArchiveRepository(archivePath);
      const restorePoint = await repository.createRestorePoint("legacy-rollback");
      await repository.clearArchiveData(); // stamps the new version
      await restorePoint.restore(); // simulated failed replace import
      await restorePoint.dispose();

      await expect(repository.upsertMessages([makeMessage(PN, "m2", 2000)])).rejects.toThrow("canonical identity");
      await repository.close();

      // A fresh instance over the restored file must also see it as legacy.
      repository = new SqliteArchiveRepository(archivePath);
      await expect(repository.upsertMessages([makeMessage(PN, "m3", 3000)])).rejects.toThrow("canonical identity");
      await repository.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scopes keyless-row surrogates by source fingerprint so different backups cannot collide", async () => {
    const { surrogateMessageId } = await import("../src/server/identity/keys");

    const backupA = surrogateMessageId("modern", "1", "aaaa11112222");
    const backupB = surrogateMessageId("modern", "1", "bbbb33334444");
    const backupARepeat = surrogateMessageId("modern", "1", "aaaa11112222");

    expect(backupA).not.toBe(backupB);
    expect(backupA).toBe(backupARepeat);
  });

  it("rejects malformed identity links on both sides", async () => {
    const repository = new MemoryArchiveRepository();

    const learned = await repository.recordIdentityLinks([
      { lid: "abc@invalid-lid", pn: PN },
      { lid: LID, pn: "garbage" },
      { lid: LID, pn: "12036000000000@g.us" },
      { lid: LID, pn: PN }
    ]);

    expect(learned).toEqual([LID]);
  });

  it("learns identity links from live events and merges immediately", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    await repository.upsertChats("live", [makeChat(LID)]);
    await repository.upsertMessages([makeMessage(LID, "m1", 1000)]);

    await maintainer.start();
    await client.emit({
      eventKey: "lid-mapping.update:test",
      eventType: "lid-mapping.update",
      mode: "update",
      identityLinks: [{ lid: LID, pn: PN }]
    });
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });

    expect(chats).toHaveLength(1);
    expect(chats[0]?.sourceChatId).toBe(PN);
  });

  it("names unnamed groups through the metadata pass and records participant links", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    client.groupMetadata.set("12036000000000@g.us", {
      subject: "Weekend Hikers",
      participants: [
        { jid: PN, role: "admin" },
        { jid: "15550000002@s.whatsapp.net", role: null }
      ],
      identityLinks: [{ lid: LID, pn: PN }]
    });
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    await repository.upsertChats("live", [{ ...makeChat("12036000000000@g.us"), chatType: "group", displayName: null }]);
    await repository.upsertMessages([makeMessage("12036000000000@g.us", "g1", 1000)]);

    await maintainer.start();
    await maintainer.runRecoveryOnce();
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const live = await repository.getLiveStatus();

    expect(chats[0]?.displayName).toBe("Weekend Hikers");
    expect(live.identityHealth.unnamedGroups).toBe(0);
  });

  it("reports identity health and never surfaces raw identifiers as display names", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("live", [
      { ...makeChat("12036000000000@g.us"), chatType: "group", displayName: null },
      { ...makeChat("15550000009@s.whatsapp.net"), displayName: null },
      makeChat(LID)
    ]);
    await repository.upsertMessages([
      makeMessage("12036000000000@g.us", "g1", 1000),
      makeMessage("15550000009@s.whatsapp.net", "d1", 2000),
      makeMessage(LID, "l1", 3000)
    ]);
    await repository.refreshChatStats();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const live = await repository.getLiveStatus();
    const group = chats.find((chat) => chat.chatType === "group");
    const dm = chats.find((chat) => chat.sourceChatId === "15550000009@s.whatsapp.net");
    const lidChat = chats.find((chat) => chat.sourceChatId === LID);

    expect(group?.displayName).toBeNull();
    expect(dm?.displayName).toBe("+15550000009");
    expect(lidChat?.displayName).toBeNull();
    expect(live.identityHealth.unnamedGroups).toBe(1);
    expect(live.identityHealth.unresolvedLids).toBeGreaterThanOrEqual(1);
  });

  it("attributes history-synced group messages via the envelope participant field", async () => {
    const { normalizeBaileysMessagesWithJidResolver } = await import("../src/server/live/normalize");
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "12036000000000@g.us", id: "H1", fromMe: false },
          participant: "15550000001@s.whatsapp.net",
          messageTimestamp: 1712000001,
          message: { conversation: "from history" }
        },
        {
          key: { remoteJid: "12036000000000@g.us", id: "H2", fromMe: false },
          messageTimestamp: 1712000002,
          message: { conversation: "no participant anywhere" }
        }
      ],
      "wa-web:history-sync",
      (jid) => jid
    );

    expect(event.messages?.[0]?.senderSourceJid).toBe("15550000001@s.whatsapp.net");
    // Unknown sender stays unknown — never the group's own identity.
    expect(event.messages?.[1]?.senderSourceJid).toBeNull();
    expect(event.contacts?.some((contact) => contact.sourceJid === "12036000000000@g.us")).toBe(false);
  });

  it("renders legacy group-self senders as unresolved instead of the group name", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("live", [{ ...makeChat("12036000000000@g.us"), chatType: "group", displayName: "Weekend Hikers" }]);
    await repository.upsertContacts("live", [
      { sourceJid: "12036000000000@g.us", displayName: "Weekend Hikers", pushName: null, phoneNumber: null }
    ]);
    await repository.upsertMessages([
      { ...makeMessage("12036000000000@g.us", "legacy-1", 1000), senderSourceJid: "12036000000000@g.us" }
    ]);

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages[0]?.senderDisplayName).toBeNull();
  });

  it("resolves mention tokens to display identities without touching stored content", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.recordIdentityLinks([{ lid: "219378490601549@lid", pn: "15550000007@s.whatsapp.net" }]);
    await repository.upsertChats("live", [{ ...makeChat("12036000000000@g.us"), chatType: "group", displayName: "Group" }]);
    await repository.upsertContacts("live", [
      { sourceJid: "15550000007@s.whatsapp.net", displayName: "Sambit", pushName: null, phoneNumber: null },
      { sourceJid: "15550000008@s.whatsapp.net", displayName: null, pushName: "Avery", phoneNumber: null }
    ]);
    const rawBody = "@219378490601549 is so disconnected, ask @15550000008 or @99999999999999";
    await repository.upsertMessages([
      { ...makeMessage("12036000000000@g.us", "m1", 1000), body: rawBody, caption: "cc @15550000008" }
    ]);

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    // LID mention resolves through the identity link; phone mention via push
    // name; unknown digits stay raw; stored content is untouched.
    expect(messages[0]?.body).toBe("@Sambit is so disconnected, ask @Avery or @99999999999999");
    expect(messages[0]?.caption).toBe("cc @Avery");
    // Resolved labels ride along for UI highlighting; unresolved digits do not.
    expect(messages[0]?.mentions).toEqual(["Sambit", "Avery"]);
    const evidence = await repository.listMemoryEvidenceMessages({ limit: 10 });
    expect(evidence.find((item) => item.sourceMessageId === "m1")?.text).toBe(rawBody);
  });

  it("resolves mentions and reports mention labels in the SQLite adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-mentions-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const runId = await repository.startImportRun({ fixture: "mentions" });
      await repository.recordIdentityLinks([{ lid: "219378490601549@lid", pn: "15550000007@s.whatsapp.net" }]);
      await repository.upsertChats(runId, [{ ...makeChat("12036000000000@g.us"), displayName: "Group" }]);
      await repository.upsertContacts(runId, [
        { sourceJid: "15550000007@s.whatsapp.net", displayName: "Sambit", pushName: null, phoneNumber: null }
      ]);
      await repository.upsertMessages([
        { ...makeMessage("12036000000000@g.us", "m1", 1000), body: "hi @219378490601549 and @99999999999999" }
      ]);

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

      expect(messages[0]?.body).toBe("hi @Sambit and @99999999999999");
      expect(messages[0]?.mentions).toEqual(["Sambit"]);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back sender display through push name and phone, never the raw JID", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("live", [{ ...makeChat("12036000000000@g.us"), chatType: "group", displayName: "Group" }]);
    await repository.upsertContacts("live", [
      { sourceJid: "15550000001@s.whatsapp.net", displayName: null, pushName: "Avery", phoneNumber: null }
    ]);
    await repository.upsertMessages([
      { ...makeMessage("12036000000000@g.us", "m1", 1000), senderSourceJid: "15550000001@s.whatsapp.net" },
      { ...makeMessage("12036000000000@g.us", "m2", 2000), senderSourceJid: "15550000002@s.whatsapp.net" },
      { ...makeMessage("12036000000000@g.us", "m3", 3000), senderSourceJid: LID }
    ]);

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages.find((message) => message.sourceMessageId === "m1")?.senderDisplayName).toBe("Avery");
    expect(messages.find((message) => message.sourceMessageId === "m2")?.senderDisplayName).toBe("+15550000002");
    expect(messages.find((message) => message.sourceMessageId === "m3")?.senderDisplayName).toBeNull();
  });
});

class FakeLiveClient implements LiveWhatsAppClient {
  readonly name = "baileys" as const;
  readonly groupMetadata = new Map<string, LiveGroupMetadataResult>();
  private connectionHandlers: Array<(update: LiveConnectionUpdate) => void | Promise<void>> = [];
  private eventHandlers: Array<(event: LiveMessageEvent) => void | Promise<void>> = [];

  onConnectionUpdate(handler: (update: LiveConnectionUpdate) => void | Promise<void>): void {
    this.connectionHandlers.push(handler);
  }

  onEvent(handler: (event: LiveMessageEvent) => void | Promise<void>): void {
    this.eventHandlers.push(handler);
  }

  async connect(): Promise<void> {
    for (const handler of this.connectionHandlers) {
      await handler({ state: "connected", linkedDeviceJid: "fake-device@s.whatsapp.net" });
    }
  }

  async disconnect(): Promise<void> {
    for (const handler of this.connectionHandlers) {
      await handler({ state: "stopped" });
    }
  }

  async emit(event: LiveMessageEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }

  async fetchGroupMetadata(jid: string): Promise<LiveGroupMetadataResult | null> {
    return this.groupMetadata.get(jid) ?? null;
  }
}

function makeChat(chatSourceId: string): ChatRecord {
  return {
    sourceChatId: chatSourceId,
    jid: chatSourceId,
    displayName: null,
    chatType: chatSourceId.endsWith("@g.us") ? "group" : "dm"
  };
}

function makeMessage(chatSourceId: string, id: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(chatSourceId, id),
    sourceTable: "wa-web:messages.upsert",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: chatSourceId,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    rawTypeCode: "text",
    body: `Synthetic ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

function testOptions(): LiveMaintainerOptions {
  return {
    clientName: "baileys",
    authDir: ".wapp-brain/test-live-auth",
    readOnly: true,
    maxBackfillPerChatMessages: 2000,
    maxBackfillPerChatDays: 14,
    maxConcurrentChatBackfills: 2,
    minBackfillDelayMs: 0,
    maxGapRetries: 5,
    recoveryIntervalMs: 60_000,
    auditSettleMs: 0
  };
}
