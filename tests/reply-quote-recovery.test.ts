import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { normalizeBaileysMessage, normalizeBaileysMessagesWithJidResolver } from "../src/server/live/normalize";
import { createModernSyntheticFixture } from "../src/server/import/fixtures";
import { parseWhatsAppSource } from "../src/server/import/parser";
import Database from "better-sqlite3";
import { buildEvidencePacks, buildPackLabeler, generateEpisodeForPack, regenerateEpisode, EXTRACTION_VERSION } from "../src/server/brain/episodes";
import { config } from "../src/server/config";
import { runImport } from "../src/server/import/importer";
import { enableBrainProvider } from "../src/server/brain/provider";
import { LiveMaintainer } from "../src/server/live/maintainer";
import type { LiveConnectionUpdate, LiveMaintainerOptions, LiveMessageEvent, LiveWhatsAppClient } from "../src/server/live/types";
import { drainBrainTasks } from "../src/server/brain/scheduler";

function reply(snapshot: MessageRecord["quotedSnapshot"]): MessageRecord {
  return {
    sourceMessageId: "reply-1",
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: "1",
    chatSourceId: "chat@s.whatsapp.net",
    senderSourceJid: "15550000000@s.whatsapp.net",
    timestampMs: 1,
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: "reply body",
    hasMedia: false,
    quotedSourceMessageId: snapshot?.quotedSourceMessageId ?? "original-1",
    quotedSnapshot: snapshot,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

async function seed(repository: MemoryArchiveRepository | SqliteArchiveRepository): Promise<void> {
  const run = await repository.startImportRun({ test: true });
  await repository.upsertChats(run, [{ sourceChatId: "chat@s.whatsapp.net", jid: "chat@s.whatsapp.net", chatType: "dm" }]);
  await repository.upsertContacts(run, [{ sourceJid: "15550000000@s.whatsapp.net", displayName: "Riya" }]);
}

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => Object.assign(config.brain, previous);
}

class QuoteLiveClient implements LiveWhatsAppClient {
  readonly name = "baileys" as const;
  private connectionHandlers: Array<(update: LiveConnectionUpdate) => void | Promise<void>> = [];
  private eventHandlers: Array<(event: LiveMessageEvent) => void | Promise<void>> = [];

  constructor(private readonly linkedDeviceJid: string) {}

  onConnectionUpdate(handler: (update: LiveConnectionUpdate) => void | Promise<void>): void {
    this.connectionHandlers.push(handler);
  }

  onEvent(handler: (event: LiveMessageEvent) => void | Promise<void>): void {
    this.eventHandlers.push(handler);
  }

  async connect(): Promise<void> {
    for (const handler of this.connectionHandlers) {
      await handler({ state: "connected", linkedDeviceJid: this.linkedDeviceJid });
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
}

function quoteLiveOptions(): LiveMaintainerOptions {
  return {
    clientName: "baileys",
    authDir: ".wapp-brain/test-quote-live-auth",
    readOnly: true,
    maxBackfillPerChatMessages: 100,
    maxBackfillPerChatDays: 1,
    maxConcurrentChatBackfills: 1,
    minBackfillDelayMs: 1,
    maxGapRetries: 1,
    recoveryIntervalMs: 60_000,
    auditSettleMs: 0
  };
}

describe("reply quote recovery", () => {
  it("parses a complete modern Android quoted snapshot without truncation", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quoted-fixture-"));
    try {
      const fixture = await createModernSyntheticFixture(path.join(temp, "fixture"));
      const db = new Database(fixture.msgstorePath, { readonly: true });
      const parsed = parseWhatsAppSource(db);
      const message = [...parsed.iterateMessages()].find((candidate) => candidate.sourceMessageId === "modern-group-3");
      db.close();
      expect(message?.quotedSnapshot?.body?.length).toBeGreaterThan(200);
      expect(message?.quotedSnapshot).toMatchObject({
        quotedSourceMessageId: "modern-group-1", mediaMimeType: "image/jpeg", location: { name: "Cafe" }, vcard: { name: "Casey" }
      });
      expect(message?.quotedSnapshot?.mentionedJids).toContain("15550000003@s.whatsapp.net");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("keeps pointer-only replies when quoted snapshot tables are absent", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quoted-absent-"));
    try {
      const fixture = await createModernSyntheticFixture(path.join(temp, "fixture"));
      const writable = new Database(fixture.msgstorePath);
      writable.exec("DROP TABLE message_quoted_mentions; DROP TABLE message_quoted_vcard; DROP TABLE message_quoted_location; DROP TABLE message_quoted_media; DROP TABLE message_quoted;");
      writable.close();
      const db = new Database(fixture.msgstorePath, { readonly: true });
      const parsed = parseWhatsAppSource(db);
      const message = [...parsed.iterateMessages()].find((candidate) => candidate.sourceMessageId === "modern-group-3");
      db.close();
      expect(message?.quotedSourceMessageId).toBeTruthy();
      expect(message?.quotedSnapshot).toBeNull();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("captures quoted snapshots when current Android schemas use message_row_id", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quoted-message-row-id-"));
    try {
      const fixture = await createModernSyntheticFixture(path.join(temp, "fixture"));
      const writable = new Database(fixture.msgstorePath);
      writable.exec(`
        ALTER TABLE message_quoted RENAME COLUMN _id TO message_row_id;
        UPDATE message_quoted SET message_row_id = 104;
        UPDATE message_quoted_media SET quoted_message_row_id = 104;
        UPDATE message_quoted_location SET quoted_message_row_id = 104;
        UPDATE message_quoted_vcard SET quoted_message_row_id = 104;
        UPDATE message_quoted_mentions SET quoted_message_row_id = 104;
        ALTER TABLE message DROP COLUMN quoted_message_row_id;
      `);
      writable.close();
      const db = new Database(fixture.msgstorePath, { readonly: true });
      const parsed = parseWhatsAppSource(db);
      const message = [...parsed.iterateMessages()].find((candidate) => candidate.sourceMessageId === "modern-group-3");
      db.close();

      expect(message?.quotedSnapshot).toMatchObject({
        quotedSourceMessageId: "modern-group-1",
        body: expect.stringContaining("Long quoted context"),
        mediaMimeType: "image/jpeg"
      });
      expect(parsed.warnings.some((warning) => warning.code === "QUOTED_SNAPSHOT_ID_MISSING")).toBe(false);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("persists modern quote snapshots idempotently through the importer", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quoted-import-"));
    try {
      const fixture = await createModernSyntheticFixture(path.join(temp, "fixture"));
      const repository = new MemoryArchiveRepository();
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });
      const group = (await repository.listChats({ limit: 20, offset: 0 })).find((chat) => chat.sourceChatId === "120363000000000002@g.us")!;
      const message = (await repository.listMessages(group.id, { limit: 20, offset: 0 })).find((item) => item.sourceMessageId === "modern-group-3")!;
      expect(message.quotedSnapshot?.body?.length).toBeGreaterThan(200);
      expect(message.quotedSnapshot?.hasThumbnail).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("warns for a malformed optional companion but retains the base snapshot", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quoted-malformed-"));
    try {
      const fixture = await createModernSyntheticFixture(path.join(temp, "fixture"));
      const writable = new Database(fixture.msgstorePath);
      writable.prepare("UPDATE message_quoted_media SET thumbnail = ? WHERE quoted_message_row_id = ?").run("not-bytes", 900);
      writable.close();
      const db = new Database(fixture.msgstorePath, { readonly: true });
      const parsed = parseWhatsAppSource(db);
      const message = [...parsed.iterateMessages()].find((candidate) => candidate.sourceMessageId === "modern-group-3");
      db.close();
      expect(message?.quotedSnapshot?.body).toContain("Long quoted context");
      expect(parsed.warnings.some((warning) => warning.code === "QUOTED_SNAPSHOT_COMPANION_MALFORMED")).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("monotonically enriches one memory-owned snapshot without truncating text", async () => {
    const repository = new MemoryArchiveRepository();
    await seed(repository);
    const text = "quoted ".repeat(120);
    await repository.upsertMessages([{ ...reply({
      quotedSourceMessageId: "original-1", quotedSourceChatId: "group@g.us", quotedSenderSourceJid: "15550000000@s.whatsapp.net",
      quotedFromMe: null, timestampMs: null, messageType: "image", body: text, caption: null, thumbnail: null,
      mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
    }), sourceTable: "android:message_quoted" }]);
    await repository.upsertMessages([{ ...reply({
      quotedSourceMessageId: "original-1", quotedSourceChatId: null, quotedSenderSourceJid: null,
      quotedFromMe: null, timestampMs: null, messageType: "unknown", body: null, caption: "caption", thumbnail: new Uint8Array([1, 2]),
      mediaMimeType: "image/jpeg", mediaName: null, location: null, vcard: null, mentionedJids: []
    }), sourceTable: "wa-web:messages.upsert" }]);
    const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
    const message = (await repository.listMessages(chat.id, { limit: 1, offset: 0 }))[0]!;
    expect(message.quotedSnapshot?.body).toBe(text);
    expect(message.quotedSnapshot?.caption).toBe("caption");
    expect(message.quotedSnapshot?.hasThumbnail).toBe(true);
    expect(await repository.getQuotedSnapshotThumbnail(message.id)).toEqual(new Uint8Array([1, 2]));
  });

  it("does not stale SQLite episodes for an identical quote snapshot, but does stale an enrichment", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quoted-staleness-"));
    const repository = new SqliteArchiveRepository(path.join(temp, "archive.sqlite"));
    try {
      await seed(repository);
      const snapshot = {
        quotedSourceMessageId: "original-1", quotedSourceChatId: "group@g.us", quotedSenderSourceJid: "15550000000@s.whatsapp.net",
        quotedFromMe: false, timestampMs: 1, messageType: "image", rawTypeCode: "1", body: "complete quote", caption: null,
        thumbnail: new Uint8Array([1, 2]), mediaMimeType: "image/jpeg", mediaName: null,
        location: { latitude: 1, longitude: 2, name: null, address: null },
        vcard: null, mentionedJids: ["15550000001@s.whatsapp.net"]
      } satisfies NonNullable<MessageRecord["quotedSnapshot"]>;
      await repository.upsertMessages([reply(snapshot)]);
      const pack = (await buildEvidencePacks(repository, { chatSourceId: "chat@s.whatsapp.net", startAtMs: 0, endAtMs: Date.now() }))[0]!;
      const generated = await generateEpisodeForPack(repository, pack, { generator: "extractive" });

      await repository.upsertMessages([reply(snapshot)]);
      expect((await repository.listBrainEpisodes({ episodeId: generated.episode.id, limit: 1 }))[0]?.status).toBe("current");
      expect((await repository.getBrainTaskSummary()).pending).toBe(0);

      await repository.upsertMessages([{ ...reply({ ...snapshot, caption: "later caption" }), sourceTable: "live" }]);
      expect((await repository.listBrainEpisodes({ episodeId: generated.episode.id, limit: 1 }))[0]?.status).toBe("stale");
      expect((await repository.getBrainTaskSummary()).pending).toBe(1);
    } finally {
      await repository.close();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("keeps same-chat pointer fallbacks while refusing cross-chat ID collisions", async () => {
    const repository = new MemoryArchiveRepository();
    await seed(repository);
    await repository.upsertMessages([
      {
        ...reply(null),
        sourceMessageId: "original-1",
        sourceRowId: "original-1",
        quotedSourceMessageId: null,
        fromMe: true,
        direction: "outgoing",
        senderSourceJid: "me",
        body: "archived same-chat original"
      },
      reply(null),
      {
        ...reply({
          quotedSourceMessageId: "original-1", quotedSourceChatId: "other@g.us", quotedSenderSourceJid: null,
          quotedFromMe: null, timestampMs: null, messageType: "text", body: "cross-chat capture", caption: null,
          thumbnail: null, mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
        }),
        sourceMessageId: "cross-reply",
        sourceRowId: "cross-reply"
      }
    ]);
    const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
    const messages = await repository.listMessages(chat.id, { limit: 10, offset: 0 });

    expect(messages.find((item) => item.sourceMessageId === "reply-1")?.quotedSnapshot).toMatchObject({
      captured: false, body: "archived same-chat original", originalMessageId: expect.any(Number), quotedFromMe: true
    });
    expect(messages.find((item) => item.sourceMessageId === "cross-reply")?.quotedSnapshot).toMatchObject({
      body: "cross-chat capture", originalMessageId: null
    });
  });

  it("projects saved-name, push-name, and owner provenance without guessing", async () => {
    const repository = new MemoryArchiveRepository();
    await seed(repository);
    const run = await repository.startImportRun({ test: true });
    await repository.upsertContacts(run, [{ sourceJid: "quoted@s.whatsapp.net", pushName: "Quinn" }]);
    await repository.upsertMessages([
      reply({
        quotedSourceMessageId: "saved", quotedSourceChatId: "chat@s.whatsapp.net", quotedSenderSourceJid: "quoted@s.whatsapp.net",
        quotedFromMe: false, timestampMs: null, messageType: "text", body: "push-name quote", caption: null,
        thumbnail: null, mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
      }),
      {
        ...reply({
          quotedSourceMessageId: "owner", quotedSourceChatId: "chat@s.whatsapp.net", quotedSenderSourceJid: "15550000000@s.whatsapp.net",
          quotedFromMe: true, timestampMs: null, messageType: "text", body: "owner quote", caption: null,
          thumbnail: null, mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
        }),
        sourceMessageId: "owner-reply",
        sourceRowId: "owner-reply"
      }
    ]);
    const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
    const messages = await repository.listMessages(chat.id, { limit: 10, offset: 0 });

    expect(messages.find((item) => item.sourceMessageId === "reply-1")?.quotedSnapshot).toMatchObject({
      quotedSenderDisplayName: "Quinn", quotedSenderNameIsPushName: true, quotedFromMe: false
    });
    expect(messages.find((item) => item.sourceMessageId === "owner-reply")?.quotedSnapshot?.quotedFromMe).toBe(true);
  });

  it("stamps reply anchors and queues exact-window regeneration after later enrichment", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quote-brain-"));
    const previousRoot = config.brain.rootDir;
    config.brain.rootDir = temp;
    try {
      const repository = new MemoryArchiveRepository();
      await seed(repository);
      await repository.upsertMessages([reply(null)]);
      const pack = (await buildEvidencePacks(repository, { chatSourceId: "chat@s.whatsapp.net", startAtMs: 0, endAtMs: 2 }))[0]!;
      const generated = await generateEpisodeForPack(repository, pack, { generator: "extractive" });
      expect(generated.episode.extractionVersion).toBe(EXTRACTION_VERSION);
      expect(generated.episode.quotedReplyAnchors).toEqual([expect.objectContaining({ replySourceMessageKey: generated.episode.claims[0]?.citations[0]?.sourceMessageKey ?? "wa|chat@s.whatsapp.net|reply-1", snapshotPresent: false })]);
      await repository.upsertMessages([reply({
        quotedSourceMessageId: "original-1", quotedSourceChatId: "group@g.us", quotedSenderSourceJid: null,
        quotedFromMe: null, timestampMs: null, messageType: "text", body: "late quote", caption: null, thumbnail: null,
        mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
      })]);
      await repository.upsertMessages([{ ...reply(null), sourceMessageId: "later", sourceRowId: "later", timestampMs: 2, body: "later uncovered work" }]);
      const backlogBefore = await repository.getBrainChatBacklog({ limit: 1 });
      expect((await repository.listBrainEpisodes({ limit: 1 }))[0]?.status).toBe("stale");
      expect((await repository.getBrainTaskSummary()).pending).toBe(1);
      const drained = await drainBrainTasks(repository, {
        maxTasks: 1,
        mode: "extractive",
        model: null,
        provider: "extractive",
        runId: null,
        onlyKind: "episode"
      });
      const episodes = await repository.listBrainEpisodes({ limit: 10 });
      const backlogAfter = await repository.getBrainChatBacklog({ limit: 1 });
      expect(drained.episodes).toBe(1);
      expect(episodes.filter((episode) => episode.status === "superseded")).toHaveLength(1);
      expect(episodes.filter((episode) => episode.status === "current")).toHaveLength(1);
      expect(backlogAfter[0]?.assimilatedThroughMs).toBe(backlogBefore[0]?.assimilatedThroughMs);
      expect((await drainBrainTasks(repository, {
        maxTasks: 1, mode: "extractive", model: null, provider: "extractive", runId: null, onlyKind: "episode"
      })).episodes).toBe(0);
    } finally {
      config.brain.rootDir = previousRoot;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("renders complete captured quote evidence without making it citable across backup and live sources", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quote-prompt-"));
    const promptPath = path.join(temp, "prompt.txt");
    const stubPath = path.join(temp, "capture.cjs");
    await writeFile(
      stubPath,
      `let data=""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => {
        require("fs").writeFileSync(${JSON.stringify(promptPath)}, data);
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ summary: "Quotes retain their context.", claims: [{ kind: "fact", text: "The reply preserved context.", cites: ["m2"] }] }),
          usage: { input_tokens: 10, output_tokens: 5 } }));
      });`,
      "utf8"
    );
    const restore = configureBrain({
      rootDir: temp,
      providerConfigPath: path.join(temp, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${stubPath}`
    });
    try {
      enableBrainProvider("claude-cli");
      const repository = new MemoryArchiveRepository();
      await repository.setArchiveOwnerName("Ari");
      const run = await repository.startImportRun({ test: true });
      await repository.upsertContacts(run, [
        { sourceJid: "riya@s.whatsapp.net", displayName: "Riya" },
        { sourceJid: "push@s.whatsapp.net", pushName: "Morgan" }
      ]);
      await repository.upsertChats(run, [{ sourceChatId: "quote@g.us", jid: "quote@g.us", chatType: "group" }]);
      const base = Date.now() - 10_000;
      const message = (sourceMessageId: string, timestampMs: number, body: string, extra: Partial<MessageRecord> = {}): MessageRecord => ({
        sourceMessageKey: "",
        sourceTable: "android:messages",
        sourceRowId: sourceMessageId,
        chatSourceId: "quote@g.us",
        senderSourceJid: "riya@s.whatsapp.net",
        timestampMs,
        fromMe: false,
        direction: "incoming",
        messageType: "text",
        body,
        hasMedia: false,
        isDeleted: false,
        isForwarded: false,
        isStarred: false,
        ...extra,
        sourceMessageId
      });
      const longQuote = "out-of-window quote remains complete ".repeat(25);
      await repository.upsertMessages([
        message("outside", base - 1_000, "legacy archived referent"),
        message("deleted", base - 800, "deleted original", { isDeleted: true }),
        message("in-pack", base, "in-pack referent"),
        message("in-pack-reply", base + 100, "reply to in-pack", { quotedSourceMessageId: "in-pack" }),
        message("pointer", base + 200, "reply to earlier archived context", { sourceTable: "wa-web:history-sync", quotedSourceMessageId: "outside" }),
        message("generic", base + 300, "reply with unavailable context", { quotedSourceMessageId: "missing" }),
        message("cross", base + 400, "reply privately", {
          sourceTable: "wa-web:messages.upsert",
          quotedSourceMessageId: "group-original",
          quotedSnapshot: {
            quotedSourceMessageId: "group-original", quotedSourceChatId: "other@g.us", quotedSenderSourceJid: "push@s.whatsapp.net",
            quotedFromMe: false, timestampMs: null, messageType: "text", body: longQuote, caption: null, thumbnail: new Uint8Array([1, 2]),
            mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
          }
        }),
        message("deleted-reply", base + 500, "reply to deleted original", {
          quotedSourceMessageId: "deleted",
          quotedSnapshot: {
            quotedSourceMessageId: "deleted", quotedSourceChatId: "quote@g.us", quotedSenderSourceJid: "me",
            quotedFromMe: true, timestampMs: null, messageType: "text", body: "snapshot survives deleted original", caption: null, thumbnail: null,
            mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
          }
        }),
        message("location", base + 600, "reply to location", {
          quotedSnapshot: {
            quotedSourceMessageId: "location-original", quotedSourceChatId: "other@g.us", quotedSenderSourceJid: "riya@s.whatsapp.net",
            quotedFromMe: false, timestampMs: null, messageType: "location", body: null, caption: null, thumbnail: null,
            mediaMimeType: null, mediaName: null, location: { latitude: 1, longitude: 2, name: "Cafe", address: "Market" }, vcard: null, mentionedJids: []
          }
        }),
        message("contact", base + 700, "reply to contact", {
          sourceTable: "wa-web:history-sync",
          quotedSnapshot: {
            quotedSourceMessageId: "contact-original", quotedSourceChatId: "other@g.us", quotedSenderSourceJid: "riya@s.whatsapp.net",
            quotedFromMe: false, timestampMs: null, messageType: "contact", body: null, caption: null, thumbnail: null,
            mediaMimeType: null, mediaName: null, location: null, vcard: { name: "Casey", vcard: "BEGIN:VCARD" }, mentionedJids: []
          }
        })
      ]);
      const pack = (await buildEvidencePacks(repository, { chatSourceId: "quote@g.us", startAtMs: base, endAtMs: Date.now() }))[0]!;
      const generated = await generateEpisodeForPack(repository, pack, { generator: "model", model: "haiku" });
      const prompt = await readFile(promptPath, "utf8");

      expect(generated.episode.generator).toBe("model");
      expect(generated.episode.quotedReplyAnchors).toHaveLength(7);
      expect(generated.episode.pushNameParticipants).toContain("push@s.whatsapp.net");
      expect(prompt).toContain('replying to m1');
      expect(prompt).toContain('legacy archived referent');
      expect(prompt).not.toContain('legacy archived referent" [non-citable snapshot]');
      expect(prompt).toContain('replying to an earlier message');
      expect(prompt).toContain(longQuote.trim());
      expect(prompt).toContain('~Morgan');
      expect(prompt).toContain('snapshot survives deleted original');
      expect(prompt).toContain('[location: Cafe — Market]');
      expect(prompt).toContain('[contact: Casey]');
      expect(prompt).toContain('[non-citable snapshot]');
    } finally {
      restore();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("selects older model episodes for exact-window replacement without advancing coverage", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quote-version-"));
    const restore = configureBrain({ rootDir: temp });
    try {
      const repository = new MemoryArchiveRepository();
      await seed(repository);
      await repository.upsertMessages([reply(null)]);
      const legacy = await repository.commitBrainEpisode({
        chatSourceId: "chat@s.whatsapp.net",
        startAtMs: 1,
        endAtMs: 1,
        messageCount: 1,
        participants: ["Riya"],
        summary: "Legacy summary",
        markdown: "",
        generator: "model",
        model: "test-model",
        runId: null,
        extractionVersion: EXTRACTION_VERSION - 1,
        claims: []
      });
      await repository.upsertMessages([{ ...reply(null), sourceMessageId: "later", sourceRowId: "later", timestampMs: 2, body: "uncovered later work" }]);
      const before = await repository.getBrainChatBacklog({ limit: 1 });
      expect((await repository.listRegenerableBrainEpisodes({ currentVersion: EXTRACTION_VERSION, limit: 10 })).map((episode) => episode.id)).toContain(legacy.id);

      const replacement = await regenerateEpisode(repository, legacy, { generator: "extractive" });
      const after = await repository.getBrainChatBacklog({ limit: 1 });
      const episodes = await repository.listBrainEpisodes({ limit: 10 });

      expect(replacement.results).toHaveLength(1);
      expect(replacement.results[0]?.episode.extractionVersion).toBe(EXTRACTION_VERSION);
      expect(episodes.find((episode) => episode.id === legacy.id)?.status).toBe("superseded");
      expect(after[0]?.assimilatedThroughMs).toBe(before[0]?.assimilatedThroughMs);
    } finally {
      restore();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("projects a local same-chat original only for the reply's own chat", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quotes-"));
    const repository = new SqliteArchiveRepository(path.join(temp, "archive.sqlite"));
    try {
      await seed(repository);
      await repository.upsertMessages([
        {
          ...reply(null), sourceMessageId: "original-1", sourceRowId: "original-1", quotedSourceMessageId: null,
          body: "same id, wrong chat", senderSourceJid: "me", fromMe: true, direction: "outgoing"
        },
        reply({
          quotedSourceMessageId: "original-1", quotedSourceChatId: "other@g.us", quotedSenderSourceJid: null,
          quotedFromMe: null, timestampMs: null, messageType: "text", body: "captured", caption: null, thumbnail: null,
          mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
        }),
        {
          ...reply(null),
          sourceMessageId: "legacy-pointer",
          sourceRowId: "legacy-pointer"
        },
        {
          ...reply(null),
          sourceMessageId: "legacy-saved-pointer",
          sourceRowId: "legacy-saved-pointer",
          quotedSourceMessageId: "saved-original"
        },
        {
          ...reply(null),
          sourceMessageId: "saved-original",
          sourceRowId: "saved-original",
          quotedSourceMessageId: null,
          body: "saved-contact original",
          senderSourceJid: "15550000000@s.whatsapp.net"
        },
        {
          ...reply({
            quotedSourceMessageId: "original-1", quotedSourceChatId: "chat@s.whatsapp.net", quotedSenderSourceJid: "me",
            quotedFromMe: true, timestampMs: null, messageType: "text", body: "same-chat capture", caption: null, thumbnail: null,
            mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
          }),
          sourceMessageId: "same-reply",
          sourceRowId: "same-reply"
        }
      ]);
      const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
      const messages = await repository.listMessages(chat.id, { limit: 10, offset: 0 });
      expect(messages.find((message) => message.sourceMessageId === "reply-1")?.quotedSnapshot?.originalMessageId).toBeNull();
      expect(messages.find((message) => message.sourceMessageId === "legacy-pointer")?.quotedSnapshot).toMatchObject({
        captured: false, quotedFromMe: true, originalMessageId: expect.any(Number)
      });
      expect(messages.find((message) => message.sourceMessageId === "legacy-saved-pointer")?.quotedSnapshot).toMatchObject({
        captured: false, quotedFromMe: false, quotedSenderDisplayName: "Riya", originalMessageId: expect.any(Number)
      });
      expect(messages.find((message) => message.sourceMessageId === "same-reply")?.quotedSnapshot?.originalMessageId).toEqual(expect.any(Number));
    } finally {
      await repository.close();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("preserves every available snapshot field when identity collapse keeps the canonical reply", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quote-collapse-"));
    const repository = new SqliteArchiveRepository(path.join(temp, "archive.sqlite"));
    try {
      await seed(repository);
      await repository.upsertMessages([
        {
          ...reply({
            quotedSourceMessageId: "original", quotedSourceChatId: "group@g.us", quotedSenderSourceJid: "me",
            quotedFromMe: true, timestampMs: 7, messageType: "image", rawTypeCode: "9", body: "complete collapse quote", caption: "caption",
            thumbnail: new Uint8Array([9]), mediaMimeType: "image/jpeg", mediaName: "quote.jpg",
            location: { latitude: 1, longitude: 2, name: "Cafe", address: "Main" }, vcard: { name: "Casey", vcard: "BEGIN:VCARD" }, mentionedJids: ["member@s.whatsapp.net"]
          }),
          sourceMessageId: "stale",
          sourceRowId: "stale"
        },
        {
          ...reply({
            quotedSourceMessageId: null, quotedSourceChatId: null, quotedSenderSourceJid: null,
            quotedFromMe: null, timestampMs: null, messageType: "unknown", body: null, caption: null,
            thumbnail: null, mediaMimeType: null, mediaName: null, location: null, vcard: null, mentionedJids: []
          }),
          sourceMessageId: "canonical",
          sourceRowId: "canonical"
        }
      ]);
      await repository.collapseSupersededMessages([
        { chatSourceId: "chat@s.whatsapp.net", staleMessageId: "stale", canonicalMessageId: "canonical" }
      ]);
      const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
      const collapsed = (await repository.listMessages(chat.id, { limit: 10, offset: 0 })).find((message) => message.sourceMessageId === "canonical")!;

      expect(collapsed.quotedSnapshot).toMatchObject({
        captured: true, quotedSourceMessageId: "original", quotedSourceChatId: "group@g.us", quotedFromMe: true,
        timestampMs: 7, messageType: "image", body: "complete collapse quote", caption: "caption",
        mediaMimeType: "image/jpeg", mediaName: "quote.jpg", location: { name: "Cafe" }, vcard: { name: "Casey" },
        mentionedJids: ["member@s.whatsapp.net"], hasThumbnail: true
      });
      expect([...(await repository.getQuotedSnapshotThumbnail(collapsed.id))!]).toEqual([9]);
    } finally {
      await repository.close();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("captures a one-level live location quote from generalized contextInfo", () => {
    const normalized = normalizeBaileysMessage({
      key: { remoteJid: "chat@s.whatsapp.net", id: "reply-2", fromMe: false },
      message: { locationMessage: { degreesLatitude: 1, degreesLongitude: 2, contextInfo: {
        stanzaId: "quoted-2", participant: "group-member@s.whatsapp.net", remoteJid: "group@g.us",
        quotedMessage: { locationMessage: { degreesLatitude: 3, degreesLongitude: 4, name: "Cafe" } }
      } } }
    }, "wa-web:messages.upsert");
    expect(normalized?.quotedSnapshot).toMatchObject({
      quotedSourceMessageId: "quoted-2", quotedSourceChatId: "group@g.us", quotedSenderSourceJid: "group-member@s.whatsapp.net",
      messageType: "location", location: { latitude: 3, longitude: 4, name: "Cafe" }
    });
  });

  it("captures text, wrapper-media, Reply Privately, and pointer-only live variants", async () => {
    const text = normalizeBaileysMessage({
      key: { remoteJid: "chat@s.whatsapp.net", id: "text-reply", fromMe: false },
      message: { extendedTextMessage: { text: "answer", contextInfo: {
        stanzaId: "source-text", participant: "sender@s.whatsapp.net",
        quotedMessage: { conversation: "complete quoted text" }
      } } }
    }, "wa-web:messages.upsert");
    const media = normalizeBaileysMessage({
      key: { remoteJid: "dm@s.whatsapp.net", id: "media-reply", fromMe: false },
      message: { ephemeralMessage: { message: { imageMessage: { caption: "answer", contextInfo: {
        stanzaId: "source-image", participant: "sender@s.whatsapp.net", remoteJid: "group@g.us",
        quotedMessage: { imageMessage: { caption: "image context", mimetype: "image/jpeg", jpegThumbnail: new Uint8Array([8]) } }
      } } } } }
    }, "wa-web:history-sync");
    const pointer = normalizeBaileysMessage({
      key: { remoteJid: "chat@s.whatsapp.net", id: "pointer-reply", fromMe: false },
      message: { extendedTextMessage: { text: "answer", contextInfo: { stanzaId: "source-only" } } }
    }, "wa-web:messages.upsert");
    const contact = normalizeBaileysMessage({
      key: { remoteJid: "chat@s.whatsapp.net", id: "contact-reply", fromMe: false },
      message: { contactsArrayMessage: { contextInfo: {
        stanzaId: "source-contact", participant: "sender@s.whatsapp.net",
        quotedMessage: { contactsArrayMessage: { contacts: [{ displayName: "Casey", vcard: "BEGIN:VCARD" }] } }
      } } }
    }, "wa-web:history-sync");
    expect(text?.quotedSnapshot?.body).toBe("complete quoted text");
    expect(media?.quotedSnapshot).toMatchObject({ quotedSourceChatId: "group@g.us", caption: "image context", mediaMimeType: "image/jpeg" });
    expect(media?.quotedSnapshot?.thumbnail).toEqual(new Uint8Array([8]));
    expect(contact?.quotedSnapshot).toMatchObject({ messageType: "contact", vcard: { name: "Casey" }, timestampMs: null });
    expect(pointer?.quotedSourceMessageId).toBe("source-only");
    expect(pointer?.quotedSnapshot).toBeNull();

    const resolved = await normalizeBaileysMessagesWithJidResolver([{
      key: { remoteJid: "chat@lid", id: "lid-reply", fromMe: false },
      message: { extendedTextMessage: { text: "answer", contextInfo: {
        stanzaId: "source", participant: "sender@lid", remoteJid: "group@lid", quotedMessage: { conversation: "quote" }
      } } }
    }], "wa-web:messages.upsert", (jid) => ({ "chat@lid": "chat@s.whatsapp.net", "sender@lid": "sender@s.whatsapp.net", "group@lid": "group@g.us" }[jid] ?? jid));
    expect(resolved.messages?.[0]?.quotedSnapshot).toMatchObject({
      quotedSenderSourceJid: "sender@s.whatsapp.net", quotedSourceChatId: "group@g.us"
    });
  });

  it("canonicalizes owner quotes in the maintainer and ignores duplicate live observations", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.setArchiveOwnerName("Ari");
    const client = new QuoteLiveClient("15550000000:0@s.whatsapp.net");
    const maintainer = new LiveMaintainer(repository, client, quoteLiveOptions());
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "chat@lid", id: "owner-reply", fromMe: false },
          messageTimestamp: 1712000001,
          message: { extendedTextMessage: { text: "reply", contextInfo: {
            stanzaId: "owner-original", participant: "15550000000@lid", remoteJid: "group@lid",
            quotedMessage: { conversation: "the owner's complete quote" }
          } } }
        }
      ],
      "wa-web:messages.upsert",
      (jid) =>
        ({
          "chat@lid": "chat@s.whatsapp.net",
          "15550000000@lid": "15550000000@s.whatsapp.net",
          "group@lid": "group@g.us"
        })[jid] ?? jid
    );

    await maintainer.start();
    await client.emit(event);
    await client.emit(event);
    await maintainer.stop();

    const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
    const messages = await repository.listMessages(chat.id, { limit: 10, offset: 0 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.quotedSnapshot).toMatchObject({
      quotedSenderSourceJid: "15550000000@s.whatsapp.net", quotedSourceChatId: "group@g.us", quotedFromMe: true,
      body: "the owner's complete quote"
    });
    const pack = (await buildEvidencePacks(repository, { chatSourceId: "chat@s.whatsapp.net", startAtMs: 0, endAtMs: Date.now() }))[0]!;
    expect(buildPackLabeler(pack.messages, "Ari").quotedSender(pack.messages[0]!)).toBe("Ari (me)");
  });
});
