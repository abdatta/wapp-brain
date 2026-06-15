import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRecord, LiveGapWindowRecord, LiveSyncTotals, MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { auditChatGaps, computeArchiveWatermarks } from "../src/server/live/auditor";
import { assertLiveBaselineReady, getLiveBaselineSummary } from "../src/server/live/baseline";
import { getLiveDependencyStatus, isSafeBaileysVersion } from "../src/server/live/dependency";
import { LiveMaintainer } from "../src/server/live/maintainer";
import { normalizeBaileysMessage } from "../src/server/live/normalize";
import { recoverDueGaps } from "../src/server/live/recovery";
import type {
  LiveConnectionUpdate,
  LiveHistoryRequest,
  LiveHistoryResult,
  LiveMaintainerOptions,
  LiveMessageEvent,
  LiveWhatsAppClient
} from "../src/server/live/types";

describe("live WhatsApp maintainer", () => {
  it("pins Baileys above the project safety floor", () => {
    const status = getLiveDependencyStatus();

    expect(status.installed).toBe(true);
    expect(status.safe).toBe(true);
    expect(isSafeBaileysVersion("6.7.21")).toBe(false);
    expect(isSafeBaileysVersion("6.7.22")).toBe(true);
    expect(isSafeBaileysVersion("7.0.0-rc11")).toBe(false);
    expect(isSafeBaileysVersion("7.0.0-rc13")).toBe(true);
  });

  it("creates live tables additively in SQLite archives", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-live-schema-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertLiveSession({ id: "default", status: "disconnected", clientName: "baileys" });
      const runId = await repository.startLiveSyncRun({ client: "baileys" });
      await repository.completeLiveSyncRun(runId, liveTotals({ messages: 1 }), 0);
      await repository.upsertLiveCheckpoint({ chatSourceId: "chat@s.whatsapp.net", health: "healthy", retryCount: 0 });
      const gapId = await repository.upsertLiveGap(makeGap("chat@s.whatsapp.net"));
      await repository.recordLiveEventReceipt({ eventKey: "event-1", eventType: "messages.upsert" });

      const status = await repository.getStatus();
      const gaps = await repository.listLiveGaps(["open"]);

      expect(status.database.initialized).toBe(true);
      expect(status.live?.session?.clientName).toBe("baileys");
      expect(status.live?.openGapCount).toBe(1);
      expect(gaps[0]?.id).toBe(gapId);
      expect(await repository.hasLiveEventReceipt("event-1")).toBe(true);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks live pairing until an imported archive baseline exists", async () => {
    const repository = new MemoryArchiveRepository();

    await expect(assertLiveBaselineReady(repository, 14)).rejects.toThrow("Import a WhatsApp backup");

    await seedChat(repository, "baseline@s.whatsapp.net", "Baseline", Date.now());
    const baseline = await getLiveBaselineSummary(repository, 14);

    expect(baseline.ready).toBe(true);
  });

  it("blocks live pairing when the archive baseline is older than the recovery window", async () => {
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, "old@s.whatsapp.net", "Old", Date.now() - 20 * 86_400_000);

    const baseline = await getLiveBaselineSummary(repository, 14);

    expect(baseline.ready).toBe(false);
    expect(baseline.status).toBe("too_old");
    await expect(assertLiveBaselineReady(repository, 14)).rejects.toThrow("older than 14 days");
  });

  it("normalizes Baileys message payloads without exposing full raw bodies in metadata", () => {
    const message = normalizeBaileysMessage(
      {
        key: { remoteJid: "15550000001@s.whatsapp.net", id: "ABC123", fromMe: false },
        messageTimestamp: 1712000001,
        pushName: "Avery",
        message: { conversation: "hello live world" }
      },
      "wa-web:messages.upsert"
    );

    expect(message?.sourceMessageKey).toBe("wa-web|15550000001@s.whatsapp.net||0|ABC123");
    expect(message?.body).toBe("hello live world");
    expect(JSON.stringify(message?.rawMetadata)).not.toContain("hello live world");
  });

  it("ingests duplicate live events idempotently through the maintainer", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const event = makeLiveEvent("chat@s.whatsapp.net", "m1", 1712000001000);

    await maintainer.start();
    await client.emit(event);
    await client.emit(event);
    await maintainer.stop();

    const status = await repository.getStatus();
    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(status.counts.messages).toBe(1);
    expect(messages[0]?.sourceMessageId).toBe("m1");
    expect(status.live?.session?.status).toBe("stopped");
  });

  it("applies delete updates and keeps update-before-base-message as pending", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const base = makeLiveEvent("updates@s.whatsapp.net", "m1", 1712000001000);
    const pendingKey = "wa-web|updates@s.whatsapp.net||0|missing";

    await maintainer.start();
    await client.emit(base);
    await client.emit({
      eventKey: "updates-event",
      eventType: "messages.update",
      mode: "update",
      updates: [
        {
          eventKey: "delete-existing",
          chatSourceId: "updates@s.whatsapp.net",
          sourceMessageKey: base.messages![0].sourceMessageKey,
          updateType: "delete"
        },
        {
          eventKey: "delete-missing",
          chatSourceId: "updates@s.whatsapp.net",
          sourceMessageKey: pendingKey,
          updateType: "delete"
        }
      ]
    });
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
    const updateResult = await repository.applyLiveMessageUpdates([
      {
        eventKey: "still-missing",
        chatSourceId: "updates@s.whatsapp.net",
        sourceMessageKey: pendingKey,
        updateType: "reaction"
      }
    ]);

    expect(messages[0]?.isDeleted).toBe(true);
    expect(updateResult.pending).toBe(1);
  });

  it("detects late-start gaps per chat from archive watermarks", async () => {
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, "fresh@s.whatsapp.net", "Fresh", 1712095200000);
    await seedChat(repository, "stale@s.whatsapp.net", "Stale", 1712059200000);
    const requiredLowerBoundAtMs = 1712095200000;

    const watermarks = await computeArchiveWatermarks(repository);
    const result = await auditChatGaps(repository, { watermarks, requiredLowerBoundAtMs }, { maxGapRetries: 5 });
    const gaps = await repository.listLiveGaps(["open"]);
    const checkpoints = await repository.listLiveCheckpoints();

    expect(result.gapsOpened).toBe(1);
    expect(gaps[0]?.chatSourceId).toBe("stale@s.whatsapp.net");
    expect(checkpoints.find((checkpoint) => checkpoint.chatSourceId === "fresh@s.whatsapp.net")?.health).toBe("healthy");
    expect(checkpoints.find((checkpoint) => checkpoint.chatSourceId === "stale@s.whatsapp.net")?.health).toBe("catching_up");
  });

  it("creates disconnect recovery gaps after reconnect", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    await seedChat(repository, "disconnect@s.whatsapp.net", "Disconnect", 1712000001000);

    await maintainer.start();
    await client.emitConnection({ state: "disconnected" });
    await client.emitConnection({ state: "connected" });
    await maintainer.stop();

    const gaps = await repository.listLiveGaps(["open"]);

    expect(gaps.some((gap) => gap.reason === "disconnect" && gap.chatSourceId === "disconnect@s.whatsapp.net")).toBe(true);
  });

  it("marks bounded recovery outcomes as closed, uncertain, or needs user action", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    await repository.upsertLiveGap({ ...makeGap("closed@s.whatsapp.net"), id: 1, requiredLowerBoundAtMs: 1000, startAtMs: 5000 });
    await repository.upsertLiveGap({ ...makeGap("uncertain@s.whatsapp.net"), id: 2, startAtMs: 5000 });
    await repository.upsertLiveGap({ ...makeGap("limit@s.whatsapp.net"), id: 3, requestCount: 5 });
    client.historyResults.set("closed@s.whatsapp.net", {
      status: "closed",
      events: [makeLiveEvent("closed@s.whatsapp.net", "older", 1000)],
      oldestReturnedAtMs: 1000,
      messageCount: 1
    });
    client.historyResults.set("uncertain@s.whatsapp.net", {
      status: "empty",
      events: [],
      messageCount: 0
    });

    const summary = await recoverDueGaps(repository, client, { ...testOptions(), maxConcurrentChatBackfills: 3 });
    const gaps = await repository.listLiveGaps();

    expect(summary.closed).toBe(1);
    expect(summary.uncertain).toBe(1);
    expect(summary.needsUserAction).toBe(1);
    expect(gaps.find((gap) => gap.chatSourceId === "closed@s.whatsapp.net")?.status).toBe("closed");
    expect(gaps.find((gap) => gap.chatSourceId === "uncertain@s.whatsapp.net")?.status).toBe("uncertain");
    expect(gaps.find((gap) => gap.chatSourceId === "limit@s.whatsapp.net")?.status).toBe("needs_user_action");
  });

  it("serves live API status and retry/unlink controls locally", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-live-api-"));
    const archivePath = path.join(tempDir, "archive.sqlite");
    const repository = new SqliteArchiveRepository(archivePath);
    try {
      await repository.upsertLiveSession({ id: "default", status: "disconnected", clientName: "baileys" });
      await repository.upsertLiveGap(makeGap("api@s.whatsapp.net"));
      await repository.close();

      const port = 4600 + Math.floor(Math.random() * 1000);
      const child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          APP_PORT: String(port),
          APP_HOST: "127.0.0.1",
          ARCHIVE_DB_PATH: archivePath,
          WAPP_WORK_DIR: path.join(tempDir, "work")
        },
        stdio: "ignore"
      });
      try {
        await waitForHttp(`http://127.0.0.1:${port}/api/live/status`);
        const status = await fetchJson<{ openGapCount: number }>(`http://127.0.0.1:${port}/api/live/status`);
        const gaps = await fetchJson<LiveGapWindowRecord[]>(`http://127.0.0.1:${port}/api/live/gaps`);
        const retry = await fetchJson<{ ok: boolean }>(`http://127.0.0.1:${port}/api/live/gaps/${gaps[0].id}/retry`, { method: "POST" });
        const unlink = await fetchJson<{ ok: boolean }>(`http://127.0.0.1:${port}/api/live/unlink`, { method: "POST" });

        expect(status.openGapCount).toBe(1);
        expect(retry.ok).toBe(true);
        expect(unlink.ok).toBe(true);
      } finally {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
    } finally {
      await repository.close().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});

class FakeLiveClient implements LiveWhatsAppClient {
  readonly name = "baileys" as const;
  readonly historyResults = new Map<string, LiveHistoryResult>();
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

  async emitConnection(update: LiveConnectionUpdate): Promise<void> {
    for (const handler of this.connectionHandlers) {
      await handler(update);
    }
  }

  async emit(event: LiveMessageEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }

  async fetchHistory(request: LiveHistoryRequest): Promise<LiveHistoryResult> {
    return this.historyResults.get(request.chatSourceId) ?? { status: "empty", events: [], messageCount: 0 };
  }
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function seedChat(repository: MemoryArchiveRepository, chatSourceId: string, displayName: string, timestampMs: number): Promise<void> {
  const runId = await repository.startImportRun({ fixture: "live-audit" });
  await repository.upsertChats(runId, [makeChat(chatSourceId, displayName)]);
  await repository.upsertMessages([makeMessage(chatSourceId, `${chatSourceId}-m1`, timestampMs)]);
  await repository.refreshChatStats();
  await repository.completeImportRun(runId, { contacts: 0, chats: 1, participants: 0, messages: 1, skipped: 0, warnings: 0 }, 0);
}

function makeLiveEvent(chatSourceId: string, messageId: string, timestampMs: number): LiveMessageEvent {
  return {
    eventKey: `event:${chatSourceId}:${messageId}`,
    eventType: "messages.upsert",
    mode: "notify",
    occurredAtMs: timestampMs,
    chats: [makeChat(chatSourceId, chatSourceId)],
    messages: [makeMessage(chatSourceId, messageId, timestampMs)]
  };
}

function makeChat(chatSourceId: string, displayName: string): ChatRecord {
  return {
    sourceChatId: chatSourceId,
    jid: chatSourceId,
    displayName,
    chatType: "dm"
  };
}

function makeMessage(chatSourceId: string, id: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: `wa-web|${chatSourceId}||0|${id}`,
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

function makeGap(chatSourceId: string): LiveGapWindowRecord {
  return {
    chatSourceId,
    reason: "late_start",
    status: "open",
    startAtMs: 1000,
    endAtMs: 5000,
    requiredLowerBoundAtMs: 1000,
    anchorMessageKey: `wa-web|${chatSourceId}||0|anchor`,
    requestCount: 0,
    confidence: "medium"
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
    maxGapRetries: 5
  };
}

function liveTotals(overrides: Partial<LiveSyncTotals> = {}): LiveSyncTotals {
  return {
    contacts: 0,
    chats: 0,
    participants: 0,
    messages: 0,
    updates: 0,
    gapsOpened: 0,
    gapsClosed: 0,
    warnings: 0,
    ...overrides
  };
}
