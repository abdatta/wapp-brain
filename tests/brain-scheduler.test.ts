import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import {
  auditCatchup,
  computeDueWork,
  drainBrainTasks,
  enqueueEpisodeTasksForChats,
  getSchedulerStatus,
  runBrainMaintenancePass
} from "../src/server/brain/scheduler";
import { buildEvidencePacks, generateEpisodeForPack } from "../src/server/brain/episodes";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MediaAssetRecord, MediaDownloadDescriptor, MessageRecord } from "../src/shared/types";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => {
    Object.assign(config.brain, previous);
  };
}

function textMessage(id: string, chatSourceId: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: "1555@s.whatsapp.net",
    timestampMs,
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `Message ${id}: we settled a detail for the Lisbon trip`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

// Seed one chat `chatSourceId` with `count` visible messages, oldest `agoMs`
// before now (so the newest is quiet enough for the volume trigger by default).
async function seedChat(
  repository: ArchiveRepository,
  chatSourceId: string,
  count: number,
  options: { newestAgoMs?: number } = {}
): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [{ sourceJid: "1555@s.whatsapp.net", displayName: "Riya", phoneNumber: "+1555" }]);
  await repository.upsertChats(runId, [{ sourceChatId: chatSourceId, jid: chatSourceId, displayName: "Chat", chatType: "group" }]);
  const newest = Date.now() - (options.newestAgoMs ?? 2 * HOUR_MS);
  const messages: MessageRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(textMessage(`M${index}`, chatSourceId, newest - (count - 1 - index) * MIN_MS));
  }
  await repository.upsertMessages(messages);
}

async function withSqlite<T>(run: (repository: SqliteArchiveRepository) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-sched-"));
  const restore = configureBrain({ rootDir: tempDir, providerConfigPath: path.join(tempDir, "provider.json"), provider: "extractive" });
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close?.();
    restore();
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("brain scheduler", () => {
  it("catches up uncovered windows and drains them into episodes (auto pass, extractive)", async () => {
    await withSqlite(async (repository) => {
      Object.assign(config.brain, { scheduler: "auto" });
      await seedChat(repository, "trip@g.us", 6);

      // Catch-up audit enqueues an episode task for the coverage gap.
      const catchup = await auditCatchup(repository);
      expect(catchup.chats).toBe(1);
      expect(catchup.enqueued).toBe(1);
      expect((await repository.getBrainTaskSummary()).pending).toBe(1);

      // The auto pass drains it: episodes commit, the task is done, coverage
      // reaches 100%, and a completed nightly run is recorded.
      const result = await runBrainMaintenancePass(repository);
      expect(result.ran).toBe(true);
      expect(result.episodes).toBeGreaterThan(0);
      expect((await repository.getBrainStatus()).coveragePercent).toBe(100);
      expect((await repository.getBrainTaskSummary()).done).toBeGreaterThan(0);
      expect((await repository.getBrainStatus()).latestRun?.status).toBe("completed");
      expect((await repository.getBrainStatus()).latestRun?.kind).toBe("nightly");
      expect(await repository.listBrainEpisodes({ limit: 10 })).toHaveLength(1);

      // Idempotent: a second pass with nothing due neither runs nor duplicates.
      const again = await runBrainMaintenancePass(repository);
      expect(again.ran).toBe(false);
      expect(await repository.listBrainEpisodes({ limit: 10 })).toHaveLength(1);
    });
  });

  it("computes dueness and alerts under a paused scheduler without spending", async () => {
    await withSqlite(async (repository) => {
      Object.assign(config.brain, { scheduler: "paused" });
      await seedChat(repository, "quiet@g.us", 6);

      const scheduler = await getSchedulerStatus(repository);
      expect(scheduler.mode).toBe("paused");
      expect(scheduler.runDue).toBe(true);
      expect(scheduler.dueReason).toContain("waiting to be assimilated");

      // Paused: the pass is a no-op, no episodes, no runs.
      const result = await runBrainMaintenancePass(repository);
      expect(result).toEqual({ ran: false, reason: "paused" });
      expect(await repository.listBrainEpisodes({ limit: 10 })).toHaveLength(0);
      expect((await repository.getBrainStatus()).latestRun).toBeNull();
    });
  });

  it("applies the significance gate and volume trigger to dueness", async () => {
    await withSqlite(async (repository) => {
      Object.assign(config.brain, { significanceMin: 5, volumeTrigger: 8, cutoffHour: new Date().getHours() });
      // Tiny chat (3 pending) is below significance and volume — not due.
      await seedChat(repository, "tiny@g.us", 3);
      // Busy chat (10 pending), quiet for hours — nightly-due (>= significance).
      await seedChat(repository, "busy@g.us", 10);

      const due = await computeDueWork(repository);
      const dueIds = due.dueChats.map((chat) => chat.chatSourceId);
      expect(dueIds).toContain("busy@g.us");
      expect(dueIds).not.toContain("tiny@g.us");

      // Volume trigger fires for a small-but-noisy chat when the gate is raised
      // above every chat's pending count: significance no longer qualifies
      // anything, but crossing the volume threshold while quiet does.
      Object.assign(config.brain, { significanceMin: 100, volumeTrigger: 3 });
      const volume = await computeDueWork(repository);
      const volumeIds = volume.dueChats.map((chat) => chat.chatSourceId);
      expect(volumeIds).toContain("busy@g.us");
      expect(volumeIds).toContain("tiny@g.us");

      // A busy chat that is still active (newest message seconds ago) is NOT
      // volume-due — an episode never splits an in-progress exchange.
      await seedChat(repository, "live@g.us", 5, { newestAgoMs: 5_000 });
      const active = await computeDueWork(repository);
      expect(active.dueChats.map((chat) => chat.chatSourceId)).not.toContain("live@g.us");
    });
  });

  it("resumes cleanly after a crash mid-drain (reset in-flight, no duplicate episodes)", async () => {
    await withSqlite(async (repository) => {
      await seedChat(repository, "resume@g.us", 6);
      await enqueueEpisodeTasksForChats(repository, await repository.getBrainChatBacklog({ limit: 10 }));

      // Simulate a crash: claim the task (now 'running') and never finish it.
      const claimed = await repository.claimDueBrainTasks(1);
      expect(claimed).toHaveLength(1);
      expect((await repository.getBrainTaskSummary()).running).toBe(1);

      // Restart recovery returns the in-flight task to pending; draining then
      // finishes it. Watermarks make the interrupted attempt free.
      expect(await repository.resetInFlightBrainTasks(0)).toBe(1);
      const drain = await drainBrainTasks(repository, { maxTasks: 10, mode: "extractive", model: null, provider: "extractive", runId: null });
      expect(drain.episodes).toBeGreaterThan(0);
      expect((await repository.getBrainStatus()).coveragePercent).toBe(100);

      // Re-draining finds nothing due and commits no duplicate episodes.
      const episodesAfterFirst = (await repository.listBrainEpisodes({ limit: 20 })).length;
      const drainAgain = await drainBrainTasks(repository, { maxTasks: 10, mode: "extractive", model: null, provider: "extractive", runId: null });
      expect(drainAgain.episodes).toBe(0);
      expect((await repository.listBrainEpisodes({ limit: 20 })).length).toBe(episodesAfterFirst);
    });
  });

  it("serializes brain spend behind the cross-process brain lock", async () => {
    await withSqlite(async (repository) => {
      Object.assign(config.brain, { scheduler: "auto" });
      await seedChat(repository, "locked@g.us", 6);
      // Another process (or a CLI run) holds the brain lock.
      const foreign = randomUUID();
      expect(await repository.tryAcquireBrainLock(foreign, 60_000)).toBe(true);

      const blocked = await runBrainMaintenancePass(repository, { force: true });
      expect(blocked).toEqual({ ran: false, reason: "locked" });
      expect(await repository.listBrainEpisodes({ limit: 10 })).toHaveLength(0);

      // Once released, the pass proceeds.
      await repository.releaseBrainLock(foreign);
      const result = await runBrainMaintenancePass(repository, { force: true });
      expect(result.ran).toBe(true);
      expect(result.episodes).toBeGreaterThan(0);
    });
  });
});

describe("brain staleness propagation", () => {
  async function seedEpisodeCitingFirstMessage(
    repository: ArchiveRepository,
    chatSourceId: string
  ): Promise<{ episodeId: string; citedKey: string }> {
    await seedChat(repository, chatSourceId, 4);
    const packs = await buildEvidencePacks(repository, { chatSourceId, startAtMs: 0, endAtMs: Date.now() });
    const result = await generateEpisodeForPack(repository, packs[0], { generator: "extractive" });
    const citedKey = result.episode.claims[0].citations[0].sourceMessageKey;
    return { episodeId: result.episode.id, citedKey };
  }

  function editUpdate(chatSourceId: string, citedKey: string) {
    return {
      eventKey: `edit-${citedKey}`,
      chatSourceId,
      sourceMessageKey: citedKey,
      updateType: "edit" as const,
      occurredAtMs: Date.now(),
      metadata: { body: "edited body — the plan changed" }
    };
  }

  it("marks an episode stale and enqueues regeneration when a cited message is edited", async () => {
    await withSqlite(async (repository) => {
      const { episodeId, citedKey } = await seedEpisodeCitingFirstMessage(repository, "edit@g.us");
      const applied = await repository.applyLiveMessageUpdates([editUpdate("edit@g.us", citedKey)]);
      expect(applied.applied).toBe(1);

      const episode = (await repository.listBrainEpisodes({ limit: 5 })).find((candidate) => candidate.id === episodeId);
      expect(episode?.status).toBe("stale");
      // A dedupe-keyed regeneration task exists for exactly this episode.
      const tasks = await repository.claimDueBrainTasks(5);
      expect(tasks.some((task) => task.dedupeKey === `regen:${episodeId}` && task.kind === "episode")).toBe(true);
    });
  });

  it("marks an episode stale when a cited message is deleted", async () => {
    await withSqlite(async (repository) => {
      const { episodeId, citedKey } = await seedEpisodeCitingFirstMessage(repository, "del@g.us");
      await repository.applyLiveMessageUpdates([
        { eventKey: `del-${citedKey}`, chatSourceId: "del@g.us", sourceMessageKey: citedKey, updateType: "delete", occurredAtMs: Date.now() }
      ]);
      const episode = (await repository.listBrainEpisodes({ limit: 5 })).find((candidate) => candidate.id === episodeId);
      expect(episode?.status).toBe("stale");
      expect((await repository.getBrainTaskSummary()).pending).toBeGreaterThan(0);
    });
  });

  it("marks an episode stale when media lands on a cited message (interpretation upgrade)", async () => {
    await withSqlite(async (repository) => {
      const { episodeId, citedKey } = await seedEpisodeCitingFirstMessage(repository, "media@g.us");
      const descriptor: MediaDownloadDescriptor = {
        mediaType: "image",
        mediaKey: "k",
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTimestamp: null,
        mimeType: "image/jpeg",
        fileName: null,
        fileLength: null,
        width: null,
        height: null,
        durationSeconds: null
      };
      await repository.enqueueMediaDownloads([
        { messageKey: citedKey, chatSourceId: "media@g.us", sourceMessageId: "M0", descriptor, thumbnail: null, isViewOnce: false, priority: 0 }
      ]);
      const [queued] = await repository.claimDueMediaDownloads(1);
      expect(queued).toBeTruthy();
      const asset: MediaAssetRecord = {
        messageKey: citedKey,
        chatSourceId: "media@g.us",
        sha256: "abc123",
        storagePath: "media/abc123.jpg",
        mimeType: "image/jpeg",
        byteSize: 1024,
        width: null,
        height: null,
        durationMs: null,
        source: "live-download",
        isViewOnce: false
      };
      await repository.completeMediaDownload(queued.id!, asset);

      const episode = (await repository.listBrainEpisodes({ limit: 5 })).find((candidate) => candidate.id === episodeId);
      expect(episode?.status).toBe("stale");
    });
  });

  it("mirrors staleness on edit in the in-memory repository", async () => {
    const restore = configureBrain({ provider: "extractive" });
    const repository = new MemoryArchiveRepository();
    try {
      const { episodeId, citedKey } = await seedEpisodeCitingFirstMessage(repository, "mem@g.us");
      await repository.applyLiveMessageUpdates([editUpdate("mem@g.us", citedKey)]);
      const episode = (await repository.listBrainEpisodes({ limit: 5 })).find((candidate) => candidate.id === episodeId);
      expect(episode?.status).toBe("stale");
      expect((await repository.claimDueBrainTasks(5)).some((task) => task.dedupeKey === `regen:${episodeId}`)).toBe(true);
    } finally {
      restore();
    }
  });
});
