import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRecord, LiveGapWindowRecord, LiveSyncTotals, MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { auditChatGaps } from "../src/server/live/auditor";
import { assertLiveBaselineExists, getLiveBaselineSummary } from "../src/server/live/baseline";
import { getLiveDependencyStatus, isSafeBaileysVersion } from "../src/server/live/dependency";
import { LiveMaintainer } from "../src/server/live/maintainer";
import { messageIdFromKey, messageKey } from "../src/server/identity/keys";
import { normalizeBaileysMessage, normalizeBaileysMessagesWithJidResolver } from "../src/server/live/normalize";
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

    await expect(assertLiveBaselineExists(repository, 14)).rejects.toThrow("Import a WhatsApp backup");

    await seedChat(repository, "baseline@s.whatsapp.net", "Baseline", Date.now());
    const baseline = await getLiveBaselineSummary(repository, 14);

    expect(baseline.ready).toBe(true);
  });

  it("reports stale baselines as advisory without blocking pairing or resume", async () => {
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, "old@s.whatsapp.net", "Old", Date.now() - 20 * 86_400_000);

    const baseline = await getLiveBaselineSummary(repository, 14);

    expect(baseline.ready).toBe(false);
    expect(baseline.status).toBe("too_old");
    await expect(assertLiveBaselineExists(repository, 14)).resolves.toBeUndefined();
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

    expect(message?.sourceMessageKey).toBe("wa|15550000001@s.whatsapp.net|ABC123");
    expect(message?.body).toBe("hello live world");
    expect(JSON.stringify(message?.rawMetadata)).not.toContain("hello live world");
  });

  it("canonicalizes live LID chats to phone JIDs when Baileys has a mapping", async () => {
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "244543240839423@lid", id: "LID123", fromMe: false },
          messageTimestamp: 1781452800,
          message: { conversation: "hello from lid" }
        }
      ],
      "wa-web:messages.upsert",
      async (jid) => (jid === "244543240839423@lid" ? "919051167186:0@s.whatsapp.net" : jid)
    );

    expect(event.chats?.[0]?.sourceChatId).toBe("919051167186@s.whatsapp.net");
    expect(event.messages?.[0]?.chatSourceId).toBe("919051167186@s.whatsapp.net");
    expect(event.messages?.[0]?.sourceMessageKey).toBe("wa|919051167186@s.whatsapp.net|LID123");
  });

  it("strips live device suffixes before deriving archive chat keys", async () => {
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "12136968563:0@s.whatsapp.net", id: "DEVICE123", fromMe: false, participant: "" },
          messageTimestamp: 1781571116,
          message: { conversation: "hello" }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    expect(event.chats?.[0]?.sourceChatId).toBe("12136968563@s.whatsapp.net");
    expect(event.messages?.[0]?.chatSourceId).toBe("12136968563@s.whatsapp.net");
    expect(event.messages?.[0]?.senderSourceJid).toBe("12136968563@s.whatsapp.net");
    expect(event.messages?.[0]?.sourceMessageKey).toBe("wa|12136968563@s.whatsapp.net|DEVICE123");
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

  it("uses Baileys push names for ID-only live DM chats", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "15550000001@s.whatsapp.net", id: "PUSH1", fromMe: false },
          messageTimestamp: 1712000001,
          pushName: "Avery",
          message: { conversation: "hello" }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    await maintainer.start();
    await client.emit(event);
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });

    expect(chats[0]?.displayName).toBe("Avery");
  });

  it("does not overwrite imported DM names with Baileys push names", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    await seedChat(repository, "15550000002@s.whatsapp.net", "Saved Contact", 1712000000000);
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "15550000002@s.whatsapp.net", id: "PUSH2", fromMe: false },
          messageTimestamp: 1712000002,
          pushName: "Push Name",
          message: { conversation: "hello again" }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    await maintainer.start();
    await client.emit(event);
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });

    expect(chats.find((chat) => chat.sourceChatId === "15550000002@s.whatsapp.net")?.displayName).toBe("Saved Contact");
  });

  it("applies delete updates and keeps update-before-base-message as pending", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const base = makeLiveEvent("updates@s.whatsapp.net", "m1", 1712000001000);
    const pendingKey = "wa|updates@s.whatsapp.net|missing";

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

  it("opens gaps only when platform recency is newer than the archive watermark", async () => {
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, "fresh@s.whatsapp.net", "Fresh", 1712095200000);
    await seedChat(repository, "stale@s.whatsapp.net", "Stale", 1712059200000);
    await repository.upsertChats("audit", [
      { ...makeChat("fresh@s.whatsapp.net", "Fresh"), platformRecencyMs: 1712095200000 },
      { ...makeChat("stale@s.whatsapp.net", "Stale"), platformRecencyMs: 1712095200000 }
    ]);

    const result = await auditChatGaps(repository, { trigger: "late_start" }, { maxGapRetries: 5, maxBackfillPerChatDays: 14 });
    const gaps = await repository.listLiveGaps(["open"]);
    const checkpoints = await repository.listLiveCheckpoints();

    expect(result.gapsOpened).toBe(1);
    expect(gaps[0]?.chatSourceId).toBe("stale@s.whatsapp.net");
    expect(gaps[0]?.reason).toBe("watermark_mismatch");
    expect(gaps[0]?.startAtMs).toBe(1712059200000);
    expect(gaps[0]?.endAtMs).toBe(1712095200000);
    expect(checkpoints.find((checkpoint) => checkpoint.chatSourceId === "fresh@s.whatsapp.net")?.health).toBe("healthy");
    expect(checkpoints.find((checkpoint) => checkpoint.chatSourceId === "stale@s.whatsapp.net")?.health).toBe("catching_up");
  });

  it("does not flag quiet chats without platform evidence of missing data", async () => {
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, "quiet@s.whatsapp.net", "Quiet", 1712000001000);

    const result = await auditChatGaps(repository, { trigger: "disconnect" }, { maxGapRetries: 5, maxBackfillPerChatDays: 14 });

    expect(result.gapsOpened).toBe(0);
    expect(await repository.listLiveGaps(["open"])).toHaveLength(0);
  });

  it("closes legacy wall-clock gaps once the evidence-based audit runs", async () => {
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, "legacy@s.whatsapp.net", "Legacy", 1712000001000);
    await repository.upsertLiveGap({
      ...makeGap("legacy@s.whatsapp.net"),
      reason: "disconnect",
      startAtMs: 1712000001000,
      requiredLowerBoundAtMs: 1712000001000,
      endAtMs: 1712095200000
    });

    const result = await auditChatGaps(repository, { trigger: "late_start" }, { maxGapRetries: 5, maxBackfillPerChatDays: 14 });
    const open = await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);

    expect(result.legacyGapsClosed).toBe(1);
    expect(open).toHaveLength(0);
  });

  it("audits downtime on first connect without an in-process disconnect", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    await seedChat(repository, "boot@s.whatsapp.net", "Boot", 1712000001000);
    await repository.upsertChats("audit", [{ ...makeChat("boot@s.whatsapp.net", "Boot"), platformRecencyMs: 1712095200000 }]);

    await maintainer.start();
    await maintainer.runRecoveryOnce();
    await maintainer.stop();

    const gaps = await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);

    expect(gaps.some((gap) => gap.chatSourceId === "boot@s.whatsapp.net" && gap.reason === "watermark_mismatch")).toBe(true);
  });

  it("marks bounded recovery outcomes from evidence, retry budgets, and platform horizons", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const now = 1712000000000;
    const hour = 3_600_000;

    // closable: anchor exists above the floor, history returns evidence at/below it
    await seedChat(repository, "closed@s.whatsapp.net", "Closed", now - 10 * hour);
    await repository.upsertMessages([makeMessage("closed@s.whatsapp.net", "closed-anchor", now)]);
    await repository.upsertLiveGap({
      ...makeGap("closed@s.whatsapp.net"),
      startAtMs: now - 10 * hour,
      endAtMs: now,
      requiredLowerBoundAtMs: now - 10 * hour
    });
    client.historyResults.set("closed@s.whatsapp.net", {
      status: "partial",
      events: [makeLiveEvent("closed@s.whatsapp.net", "older", now - 10 * hour - 1000)],
      messageCount: 1
    });

    // platform horizon: window wider than maxBackfillPerChatDays
    await seedChat(repository, "horizon@s.whatsapp.net", "Horizon", now - 100 * 24 * hour);
    await repository.upsertLiveGap({
      ...makeGap("horizon@s.whatsapp.net"),
      startAtMs: now - 100 * 24 * hour,
      endAtMs: now,
      requiredLowerBoundAtMs: now - 100 * 24 * hour
    });

    // retries exhausted with anchor movement since the last attempt
    await seedChat(repository, "limit@s.whatsapp.net", "Limit", now - 10 * hour);
    await repository.upsertMessages([makeMessage("limit@s.whatsapp.net", "limit-anchor", now)]);
    await repository.upsertLiveGap({
      ...makeGap("limit@s.whatsapp.net"),
      startAtMs: now - 10 * hour,
      endAtMs: now,
      requiredLowerBoundAtMs: now - 10 * hour,
      requestCount: 5,
      anchorMessageKey: "wa|limit@s.whatsapp.net|previous-anchor"
    });

    // retries exhausted with no anchor movement at all
    await seedChat(repository, "stalled@s.whatsapp.net", "Stalled", now - 10 * hour);
    await repository.upsertMessages([makeMessage("stalled@s.whatsapp.net", "stalled-anchor", now)]);
    await repository.upsertLiveGap({
      ...makeGap("stalled@s.whatsapp.net"),
      startAtMs: now - 10 * hour,
      endAtMs: now,
      requiredLowerBoundAtMs: now - 10 * hour,
      requestCount: 5,
      anchorMessageKey: messageKey("stalled@s.whatsapp.net", "stalled-anchor")
    });

    const summary = await recoverDueGaps(repository, client, { ...testOptions(), maxConcurrentChatBackfills: 4 });
    const gaps = await repository.listLiveGaps();

    expect(summary.closed).toBe(1);
    expect(summary.uncertain).toBe(2);
    expect(summary.needsUserAction).toBe(1);
    expect(gaps.find((gap) => gap.chatSourceId === "closed@s.whatsapp.net")?.status).toBe("closed");
    expect(gaps.find((gap) => gap.chatSourceId === "horizon@s.whatsapp.net")?.status).toBe("uncertain");
    expect(gaps.find((gap) => gap.chatSourceId === "limit@s.whatsapp.net")?.status).toBe("needs_user_action");
    expect(gaps.find((gap) => gap.chatSourceId === "stalled@s.whatsapp.net")?.status).toBe("uncertain");
  });

  it("ingests large history chunks in slices and reports sync progress", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const bigBatch: MessageRecord[] = Array.from({ length: 1200 }, (_, index) =>
      makeMessage("bulk@s.whatsapp.net", `bulk-${index}`, 1712000000000 + index)
    );

    await maintainer.start();
    await client.emit({
      eventKey: "history-chunk-1",
      eventType: "messaging-history.set",
      mode: "history",
      chats: [makeChat("bulk@s.whatsapp.net", "Bulk")],
      messages: bigBatch,
      rawMetadata: { progress: 42 }
    });
    const progress = maintainer.getSyncProgress();
    await maintainer.stop();

    const status = await repository.getStatus();

    expect(status.counts.messages).toBe(1200);
    expect(progress.processedMessages).toBe(1200);
    expect(progress.processedEvents).toBe(1);
    expect(progress.historySyncPercent).toBe(42);
    expect(progress.active).toBe(true);
  });

  it("runs recovery on its own schedule without user action", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, { ...testOptions(), recoveryIntervalMs: 1000 });
    const now = 1712000000000;
    await seedChat(repository, "auto@s.whatsapp.net", "Auto", now - 3_600_000);
    await repository.upsertMessages([makeMessage("auto@s.whatsapp.net", "auto-anchor", now)]);
    await repository.upsertLiveGap({
      ...makeGap("auto@s.whatsapp.net"),
      startAtMs: now - 3_600_000,
      endAtMs: now,
      requiredLowerBoundAtMs: now - 3_600_000
    });
    client.historyResults.set("auto@s.whatsapp.net", {
      status: "partial",
      events: [makeLiveEvent("auto@s.whatsapp.net", "auto-cover", now - 3_601_000)],
      messageCount: 1
    });

    await maintainer.start();
    await waitFor(async () => (await repository.listLiveGaps(["closed"])).length > 0, 5_000);
    await maintainer.stop();

    const gaps = await repository.listLiveGaps();

    expect(gaps.find((gap) => gap.chatSourceId === "auto@s.whatsapp.net")?.status).toBe("closed");
  }, 15000);

  it("closes gaps when covering history evidence is ingested asynchronously", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const bound = 1712000000000;
    await seedChat(repository, "async@s.whatsapp.net", "Async", bound);
    const gapId = await repository.upsertLiveGap({
      ...makeGap("async@s.whatsapp.net"),
      startAtMs: bound,
      endAtMs: bound + 3_600_000,
      requiredLowerBoundAtMs: bound
    });

    await maintainer.start();
    await client.emit(makeLiveEvent("async@s.whatsapp.net", "cover", bound - 1000));
    await maintainer.stop();

    const gaps = await repository.listLiveGaps();

    expect(gaps.find((gap) => gap.id === gapId)?.status).toBe("closed");
  });

  it("keeps ingesting after a poisoned event", async () => {
    const repository = new PoisonableRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());

    await maintainer.start();
    await client.emit(makeLiveEvent("poison@s.whatsapp.net", "poison-1", 1712000001000));
    await client.emit(makeLiveEvent("healthy@s.whatsapp.net", "ok-1", 1712000002000));
    await maintainer.stop();

    const status = await repository.getStatus();

    expect(status.counts.messages).toBe(1);
    expect(status.live?.session?.status).toBe("stopped");
  });

  it("reconciles stale connected sessions and running runs at startup", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertLiveSession({ id: "default", status: "connected", clientName: "baileys" });
    await repository.startLiveSyncRun();

    const result = await repository.reconcileLiveState();
    const live = await repository.getLiveStatus();

    expect(result.staleSessions).toBe(1);
    expect(result.staleRuns).toBe(1);
    expect(live.session?.status).toBe("stopped");
    expect(live.currentRun).toBeNull();
  });

  it("records logged-out sessions distinctly", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());

    await maintainer.start();
    await client.emitConnection({ state: "logged_out", lastError: "WhatsApp unlinked this device." });
    const live = await repository.getLiveStatus();
    await maintainer.stop();

    expect(live.session?.status).toBe("logged_out");
    expect(live.session?.lastError).toContain("unlinked");
  });

  it("tombstones the original message when a revoke protocol message arrives", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const base = makeLiveEvent("revoke@s.whatsapp.net", "m1", 1712000001000);

    const revoke = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "revoke@s.whatsapp.net", id: "REV1", fromMe: false },
          messageTimestamp: 1712000101,
          message: { protocolMessage: { type: 0, key: { remoteJid: "revoke@s.whatsapp.net", id: "m1", fromMe: false } } }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    expect(revoke.messages ?? []).toHaveLength(0);
    expect(revoke.updates?.[0]?.updateType).toBe("delete");

    await maintainer.start();
    await client.emit(base);
    await client.emit(revoke);
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.isDeleted).toBe(true);
  });

  it("applies protocol edits to the original message body", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const base = makeLiveEvent("edit@s.whatsapp.net", "m1", 1712000001000);
    const edit = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "edit@s.whatsapp.net", id: "EDIT1", fromMe: false },
          messageTimestamp: 1712000201,
          message: {
            protocolMessage: {
              type: 14,
              key: { remoteJid: "edit@s.whatsapp.net", id: "m1", fromMe: false },
              editedMessage: { conversation: "edited text" }
            }
          }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    await maintainer.start();
    await client.emit(base);
    await client.emit(edit);
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages[0]?.body).toBe("edited text");
  });

  it("stores reactions as updates instead of standalone messages", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const base = makeLiveEvent("react@s.whatsapp.net", "m1", 1712000001000);
    const reaction = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "react@s.whatsapp.net", id: "REACT1", fromMe: false },
          messageTimestamp: 1712000301,
          message: { reactionMessage: { key: { remoteJid: "react@s.whatsapp.net", id: "m1", fromMe: false }, text: "\u{1F44D}" } }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    expect(reaction.messages ?? []).toHaveLength(0);
    expect(reaction.updates?.[0]?.updateType).toBe("reaction");

    await maintainer.start();
    await client.emit(base);
    await client.emit(reaction);
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageType).toBe("text");
  });

  it("unwraps view-once and document-with-caption envelopes to real content", () => {
    const viewOnce = normalizeBaileysMessage(
      {
        key: { remoteJid: "wrap@s.whatsapp.net", id: "VO1", fromMe: false },
        messageTimestamp: 1712000001,
        message: { viewOnceMessageV2: { message: { imageMessage: { caption: "hidden photo", mimetype: "image/jpeg" } } } }
      },
      "wa-web:messages.upsert"
    );
    const docWithCaption = normalizeBaileysMessage(
      {
        key: { remoteJid: "wrap@s.whatsapp.net", id: "DOC1", fromMe: false },
        messageTimestamp: 1712000002,
        message: { documentWithCaptionMessage: { message: { documentMessage: { caption: "the contract", fileName: "contract.pdf", mimetype: "application/pdf" } } } }
      },
      "wa-web:messages.upsert"
    );

    expect(viewOnce?.messageType).toBe("image");
    expect(viewOnce?.hasMedia).toBe(true);
    expect(viewOnce?.caption).toBe("hidden photo");
    expect(docWithCaption?.messageType).toBe("document");
    expect(docWithCaption?.caption).toBe("the contract");
    expect(docWithCaption?.mediaName).toBe("contract.pdf");
  });

  it("applies revokes written from the sender's perspective to the archived original", async () => {
    const repository = new MemoryArchiveRepository();
    const client = new FakeLiveClient();
    const maintainer = new LiveMaintainer(repository, client, testOptions());
    const base = makeLiveEvent("perspective@s.whatsapp.net", "m1", 1712000001000);
    const revoke = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "perspective@s.whatsapp.net", id: "REV9", fromMe: false },
          messageTimestamp: 1712000101,
          // protocol key uses the sender's perspective: fromMe=true, LID chat jid
          message: { protocolMessage: { type: 0, key: { remoteJid: "244543240839423@lid", id: "m1", fromMe: true } } }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    await maintainer.start();
    await client.emit(base);
    await client.emit(revoke);
    await maintainer.stop();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });

    expect(messages[0]?.isDeleted).toBe(true);
  });

  it("extracts edits delivered through the messages.update channel", async () => {
    const { normalizeBaileysMessageUpdatesWithJidResolver } = await import("../src/server/live/normalize");
    const event = await normalizeBaileysMessageUpdatesWithJidResolver(
      [
        {
          key: { remoteJid: "editchan@s.whatsapp.net", id: "m1", fromMe: false },
          update: { message: { editedMessage: { message: { conversation: "corrected text" } } }, messageTimestamp: 1712000500 }
        }
      ],
      (jid) => jid
    );

    expect(event.updates).toHaveLength(1);
    expect(event.updates?.[0]?.updateType).toBe("edit");
    expect(event.updates?.[0]?.metadata?.body).toBe("corrected text");
  });

  it("extracts business template text and labels interactive and secret-encrypted content honestly", () => {
    const template = normalizeBaileysMessage(
      {
        key: { remoteJid: "biz@s.whatsapp.net", id: "TPL1", fromMe: false },
        messageTimestamp: 1712000001,
        message: { templateMessage: { hydratedTemplate: { hydratedContentText: "Your order has shipped", hydratedTitleText: "Order update" } } }
      },
      "wa-web:messages.upsert"
    );
    const secret = normalizeBaileysMessage(
      {
        key: { remoteJid: "dm@s.whatsapp.net", id: "SEC1", fromMe: false },
        messageTimestamp: 1712000002,
        message: { messageContextInfo: {}, secretEncryptedMessage: { secretEncType: 2 } }
      },
      "wa-web:messages.upsert"
    );
    const poll = normalizeBaileysMessage(
      {
        key: { remoteJid: "dm@s.whatsapp.net", id: "POLL1", fromMe: false },
        messageTimestamp: 1712000003,
        message: { messageContextInfo: {}, pollCreationMessageV3: { name: "?" } }
      },
      "wa-web:messages.upsert"
    );

    const interactiveTemplate = normalizeBaileysMessage(
      {
        key: { remoteJid: "biz@s.whatsapp.net", id: "TPL2", fromMe: false },
        messageTimestamp: 1712000004,
        message: { templateMessage: { interactiveMessageTemplate: { body: { text: "Choose a delivery slot" } } } }
      },
      "wa-web:messages.upsert"
    );

    expect(template?.messageType).toBe("template");
    expect(template?.body).toBe("Your order has shipped");
    expect(interactiveTemplate?.body).toBe("Choose a delivery slot");
    // A secret-encrypted edit targets another message (it carries the new
    // content for that message), so it is never a standalone row — it flows
    // through payload retention and is applied in place once decrypted.
    expect(secret).toBeNull();
    // Polls joined the shared vocabulary; the messageContextInfo rider still
    // never names the type.
    expect(poll?.messageType).toBe("poll");
    expect(poll?.body).toBe("?");
  });

  it("records stub messages as system events instead of empty unknown rows", () => {
    const stub = normalizeBaileysMessage(
      {
        key: { remoteJid: "12036000000000@g.us", id: "STUB1", fromMe: false, participant: "15550000001@s.whatsapp.net" },
        messageTimestamp: 1712000001,
        messageStubType: 27,
        messageStubParameters: ["15550000002@s.whatsapp.net"]
      },
      "wa-web:messages.upsert"
    );

    expect(stub?.messageType).toBe("system");
    expect(stub?.direction).toBe("system");
    expect(stub?.rawMetadata?.stubType).toBe(27);
  });

  it("escapes the key delimiter so hostile message ids cannot collide", () => {
    const tricky = messageKey("chat@s.whatsapp.net", "id|with|pipes%");
    const plain = messageKey("chat@s.whatsapp.net", "normal-id");

    expect(tricky.split("|")).toHaveLength(3);
    expect(messageIdFromKey(tricky)).toBe("id|with|pipes%");
    expect(plain).toBe("wa|chat@s.whatsapp.net|normal-id");
  });

  it("does not fabricate phone numbers from LID or group identifiers", async () => {
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: "244543240839423@lid", id: "LIDPHONE1", fromMe: false },
          messageTimestamp: 1712000001,
          pushName: "Lid Person",
          message: { conversation: "hello" }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    expect(event.contacts?.[0]?.pushName).toBe("Lid Person");
    expect(event.contacts?.[0]?.phoneNumber).toBeNull();
  });

  it("normalizes Baileys v7 group participant objects without crashing", async () => {
    const { normalizeBaileysGroupParticipantsWithJidResolver } = await import("../src/server/live/normalize");
    const event = await normalizeBaileysGroupParticipantsWithJidResolver(
      {
        id: "12036000000000@g.us",
        action: "add",
        participants: [
          { id: "244543240839423@lid", phoneNumber: "15550000001@s.whatsapp.net" },
          { id: "15550000002@s.whatsapp.net" },
          "15550000003@s.whatsapp.net",
          null,
          { id: null } as never,
          42 as never
        ]
      },
      (jid) => jid,
      1712000001000
    );

    expect(event.participants?.map((participant) => participant.sourceJid)).toEqual([
      "15550000001@s.whatsapp.net",
      "15550000002@s.whatsapp.net",
      "15550000003@s.whatsapp.net"
    ]);
    expect(event.participants?.every((participant) => participant.chatSourceId === "12036000000000@g.us")).toBe(true);
  });

  it("sorts chats by conversation recency, ignoring system events (memory)", async () => {
    const repository = new MemoryArchiveRepository();
    const runId = await repository.startImportRun({ fixture: "sorting" });
    await repository.upsertChats(runId, [makeChat("quiettext@s.whatsapp.net", "Quiet Text"), makeChat("noisyevents@s.whatsapp.net", "Noisy Events")]);
    await repository.upsertMessages([
      makeMessage("quiettext@s.whatsapp.net", "t1", 2000),
      makeMessage("noisyevents@s.whatsapp.net", "t0", 1000),
      makeSystemEvent("noisyevents@s.whatsapp.net", "e1", 9000)
    ]);
    await repository.refreshChatStats();

    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });

    expect(chats.map((chat) => chat.sourceChatId)).toEqual(["quiettext@s.whatsapp.net", "noisyevents@s.whatsapp.net"]);
    expect(chats[1]?.lastMessageAt).toBe(new Date(1000).toISOString());
  });

  it("sorts chats by conversation recency, ignoring system events (sqlite)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-sorting-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const runId = await repository.startImportRun({ fixture: "sorting" });
      await repository.upsertChats(runId, [makeChat("quiettext@s.whatsapp.net", "Quiet Text"), makeChat("noisyevents@s.whatsapp.net", "Noisy Events")]);
      await repository.upsertMessages([
        makeMessage("quiettext@s.whatsapp.net", "t1", 2000),
        makeMessage("noisyevents@s.whatsapp.net", "t0", 1000),
        makeSystemEvent("noisyevents@s.whatsapp.net", "e1", 9000)
      ]);
      await repository.refreshChatStats();

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });

      expect(chats.map((chat) => chat.sourceChatId)).toEqual(["quiettext@s.whatsapp.net", "noisyevents@s.whatsapp.net"]);
      expect(chats[1]?.lastMessageAt).toBe(new Date(1000).toISOString());
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates older archives to accept the logged_out session status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-live-migration-"));
    const archivePath = path.join(tempDir, "archive.sqlite");
    try {
      const raw = new Database(archivePath);
      raw.exec(
        `CREATE TABLE live_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('not_configured','pairing','connected','disconnected','stopped','error')),
          client_name TEXT NOT NULL,
          linked_device_jid TEXT NULL,
          last_connected_at TEXT NULL,
          last_disconnected_at TEXT NULL,
          last_error TEXT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )`
      );
      raw.prepare(`INSERT INTO live_sessions (id, status, client_name) VALUES ('default', 'stopped', 'baileys')`).run();
      raw.close();

      let repository = new SqliteArchiveRepository(archivePath);
      await repository.upsertLiveSession({ id: "default", status: "logged_out", clientName: "baileys" });
      let live = await repository.getLiveStatus();
      expect(live.session?.status).toBe("logged_out");
      await repository.close();

      // Idempotent: reopening must not error or lose data.
      repository = new SqliteArchiveRepository(archivePath);
      live = await repository.getLiveStatus();
      expect(live.session?.status).toBe("logged_out");
      await repository.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
  }, 40000);
});

class PoisonableRepository extends MemoryArchiveRepository {
  async upsertMessages(messages: MessageRecord[]): Promise<number> {
    if (messages.some((message) => message.chatSourceId.startsWith("poison@"))) {
      throw new Error("Synthetic poisoned event");
    }
    return super.upsertMessages(messages);
  }
}

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

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 25_000;
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
    sourceMessageKey: `wa|${chatSourceId}|${id}`,
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

function makeSystemEvent(chatSourceId: string, id: string, timestampMs: number): MessageRecord {
  return {
    ...makeMessage(chatSourceId, id, timestampMs),
    direction: "system",
    messageType: "system",
    rawTypeCode: "system",
    body: null
  };
}

function makeGap(chatSourceId: string): LiveGapWindowRecord {
  return {
    chatSourceId,
    reason: "watermark_mismatch",
    status: "open",
    startAtMs: 1000,
    endAtMs: 5000,
    requiredLowerBoundAtMs: 1000,
    anchorMessageKey: `wa|${chatSourceId}|anchor`,
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
    maxGapRetries: 5,
    recoveryIntervalMs: 60_000,
    auditSettleMs: 0
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
