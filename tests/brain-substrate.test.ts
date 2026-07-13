import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { buildEvidencePacks, generateEpisodeForPack } from "../src/server/brain/episodes";
import { drainBrainTasks, runBrainMaintenancePass } from "../src/server/brain/scheduler";
import {
  claudeCliInvocation,
  disableBrainProvider,
  enableBrainProvider,
  generateStructured,
  getBrainProviderStatus,
  parseModelJson,
  probeBrainProvider,
  setBrainProviderModel
} from "../src/server/brain/provider";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";

const DAY_MS = 86_400_000;

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => {
    Object.assign(config.brain, previous);
  };
}

function message(id: string, chatSourceId: string, overrides: Partial<MessageRecord>): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: null,
    timestampMs: Date.now(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `body of ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...overrides
  };
}

async function seedChat(repository: ArchiveRepository, chatSourceId: string, messages: MessageRecord[]): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertChats(runId, [{ sourceChatId: chatSourceId, jid: chatSourceId, displayName: "Chat", chatType: "group" }]);
  await repository.upsertMessages(messages);
}

describe("brain substrate", () => {
  it("keeps the task queue idempotent, prioritized, and restart-safe", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-queue-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const first = await repository.enqueueBrainTasks([
        { kind: "episode", chatSourceId: "a@g.us", dedupeKey: "ep:a:1", priority: 1 },
        { kind: "episode", chatSourceId: "b@g.us", dedupeKey: "ep:b:1", priority: 5 }
      ]);
      expect(first).toBe(2);
      // Re-enqueueing known work is a no-op by dedupe key.
      expect(await repository.enqueueBrainTasks([{ kind: "episode", chatSourceId: "a@g.us", dedupeKey: "ep:a:1" }])).toBe(0);

      const claimed = await repository.claimDueBrainTasks(1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].dedupeKey).toBe("ep:b:1"); // higher priority first

      // A failed task with retry returns to pending after its backoff.
      await repository.failBrainTask(claimed[0].id, "transient", { retryInMs: 60_000 });
      expect((await repository.claimDueBrainTasks(5)).map((task) => task.dedupeKey)).toEqual(["ep:a:1"]);
      const later = await repository.claimDueBrainTasks(5, Date.now() + 120_000);
      expect(later.map((task) => task.dedupeKey)).toContain("ep:b:1");
      const retried = later.find((task) => task.dedupeKey === "ep:b:1")!;
      expect(retried.attempts).toBe(1);
      await repository.completeBrainTask(retried.id);
      expect((await repository.getBrainTaskSummary()).done).toBe(1);

      // Restart recovery: stale running tasks (ep:a:1, claimed earlier and
      // never finished) return to pending.
      const reset = await repository.resetInFlightBrainTasks(0);
      expect(reset).toBe(1);
      const summary = await repository.getBrainTaskSummary();
      expect(summary.running).toBe(0);
      expect(summary.pending).toBe(1);

      // Terminal failure sticks.
      const [task] = await repository.claimDueBrainTasks(1);
      await repository.failBrainTask(task.id, "permanent", {});
      expect((await repository.getBrainTaskSummary()).failed).toBe(1);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives backlog from watermarks and advances coverage only forward", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-watermark-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const base = Date.now() - 3 * DAY_MS;
      await seedChat(repository, "chat@g.us", [
        message("M1", "chat@g.us", { timestampMs: base }),
        message("M2", "chat@g.us", { timestampMs: base + DAY_MS }),
        message("M3", "chat@g.us", { timestampMs: base + 2 * DAY_MS }),
        // System noise never counts toward backlog.
        message("S1", "chat@g.us", { timestampMs: base + 2 * DAY_MS, direction: "system", messageType: "system", body: null })
      ]);
      let backlog = await repository.getBrainChatBacklog({ limit: 10 });
      expect(backlog).toHaveLength(1);
      expect(backlog[0].pendingVisibleMessages).toBe(3);

      await repository.advanceBrainWatermark("chat@g.us", base + DAY_MS);
      backlog = await repository.getBrainChatBacklog({ limit: 10 });
      expect(backlog[0].pendingVisibleMessages).toBe(1);

      // Watermarks never regress.
      await repository.advanceBrainWatermark("chat@g.us", base);
      backlog = await repository.getBrainChatBacklog({ limit: 10 });
      expect(backlog[0].pendingVisibleMessages).toBe(1);

      const status = await repository.getBrainStatus();
      expect(status.totalVisibleMessages).toBe(3);
      expect(status.assimilatedVisibleMessages).toBe(2);
      expect(status.chatsWithBacklog).toBe(1);

      // Full coverage empties the backlog.
      await repository.advanceBrainWatermark("chat@g.us", base + 2 * DAY_MS);
      expect(await repository.getBrainChatBacklog({ limit: 10 })).toHaveLength(0);
      expect((await repository.getBrainStatus()).coveragePercent).toBe(100);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks runs and model usage in the ledger", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-ledger-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const runId = await repository.startBrainRun("manual", "America/Los_Angeles");
      await repository.recordBrainLlmUsage({ purpose: "episode", provider: "claude-cli", inputTokens: 6000, outputTokens: 900 });
      await repository.recordBrainLlmUsage({ purpose: "episode", provider: "claude-cli", inputTokens: 5000, outputTokens: 800 });
      const usage = await repository.getBrainLlmUsage({ sinceMs: Date.now() - 60_000 });
      expect(usage.calls).toBe(2);
      expect(usage.inputTokens).toBe(11_000);
      await repository.completeBrainRun(runId, { episodes: 2 });
      const status = await repository.getBrainStatus();
      expect(status.latestRun?.status).toBe("completed");
      expect(status.latestRun?.totals?.episodes).toBe(2);
      expect(status.usageToday.calls).toBe(2);

      const failedRun = await repository.startBrainRun("nightly");
      await repository.failBrainRun(failedRun, "budget_exceeded", "Daily model-call budget reached.");
      expect((await repository.getBrainStatus()).latestRun?.status).toBe("budget_exceeded");
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mirrors the substrate in the in-memory repository", async () => {
    const repository = new MemoryArchiveRepository();
    const base = Date.now() - DAY_MS;
    await seedChat(repository, "mirror@g.us", [message("M1", "mirror@g.us", { timestampMs: base })]);
    expect(await repository.enqueueBrainTasks([{ kind: "episode", dedupeKey: "k1" }])).toBe(1);
    expect(await repository.enqueueBrainTasks([{ kind: "episode", dedupeKey: "k1" }])).toBe(0);
    const backlog = await repository.getBrainChatBacklog({ limit: 5 });
    expect(backlog[0]?.pendingVisibleMessages).toBe(1);
    await repository.advanceBrainWatermark("mirror@g.us", base);
    expect(await repository.getBrainChatBacklog({ limit: 5 })).toHaveLength(0);
    const status = await repository.getBrainStatus();
    expect(status.coveragePercent).toBe(100);
    expect(status.tasks.pending).toBe(1);
  });
});

describe("brain model provider", () => {
  it("refuses model generation without explicit opt-in and reports honest status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-provider-"));
    const restore = configureBrain({
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "extractive"
    });
    try {
      await expect(
        generateStructured({ system: "s", user: "u", maxOutputTokens: 64 })
      ).rejects.toThrow(/no model provider/i);
      expect(getBrainProviderStatus().modelBacked).toBe(false);

      // Configured but not opted in: still refused.
      Object.assign(config.brain, { provider: "claude-cli" });
      await expect(generateStructured({ system: "s", user: "u", maxOutputTokens: 64 })).rejects.toThrow(/opt-in/i);
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the claude-cli adapter against a stub, extracts envelope errors, degrades, and recovers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-provider-stub-"));
    const okStub = path.join(tempDir, "stub-ok.cjs");
    const failStub = path.join(tempDir, "stub-429.cjs");
    await writeFile(
      okStub,
      `let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: JSON.stringify({ ok: true, sawPrompt: input.length > 0 }),
    usage: { input_tokens: 42, output_tokens: 7 }
  }));
});`,
      "utf8"
    );
    await writeFile(
      failStub,
      `process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: true, api_error_status: 429,
    result: "You've hit your org's monthly spend limit"
  }));
  process.exit(1);
});`,
      "utf8"
    );
    const restore = configureBrain({
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${okStub}`,
      providerFailureThreshold: 2
    });
    try {
      enableBrainProvider("claude-cli");
      const invocation = claudeCliInvocation();
      expect(invocation.command).toBe("node");
      expect(invocation.args[0]).toBe(okStub);

      const result = await generateStructured({ system: "probe", user: "answer", maxOutputTokens: 64 });
      expect((result.json as { ok: boolean; sawPrompt: boolean }).ok).toBe(true);
      expect((result.json as { sawPrompt: boolean }).sawPrompt).toBe(true);
      expect(result.usage.inputTokens).toBe(42);
      expect(getBrainProviderStatus().health.lastOkAt).not.toBeNull();

      // Envelope errors surface their real reason and degrade after the threshold.
      Object.assign(config.brain, { claudeCommand: `node ${failStub}` });
      await expect(generateStructured({ system: "s", user: "u", maxOutputTokens: 64 })).rejects.toThrow(/spend limit/i);
      await expect(generateStructured({ system: "s", user: "u", maxOutputTokens: 64 })).rejects.toThrow(/spend limit/i);
      const degraded = getBrainProviderStatus();
      expect(degraded.degraded).toBe(true);
      expect(degraded.health.lastError).toContain("monthly spend limit");
      expect(degraded.health.lastError).toContain("429");

      // While degraded, normal generation refuses fast without a model call.
      await expect(generateStructured({ system: "s", user: "u", maxOutputTokens: 64 })).rejects.toThrow(/degraded/i);

      // A successful probe clears the degraded state.
      Object.assign(config.brain, { claudeCommand: `node ${okStub}` });
      const probe = await probeBrainProvider();
      expect(probe.ok).toBe(true);
      expect(probe.status.degraded).toBe(false);
      expect(probe.status.health.consecutiveFailures).toBe(0);

      disableBrainProvider();
      expect(getBrainProviderStatus().modelBacked).toBe(false);
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists model selection, applies per-run overrides, and rejects unsafe names", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-provider-model-"));
    const restore = configureBrain({ providerConfigPath: path.join(tempDir, "provider.json"), provider: "claude-cli" });
    try {
      enableBrainProvider("claude-cli");
      // Sonnet 5 (explicit id, never a floating alias) is the default digest
      // model; selection persists; catalog exposed.
      expect(getBrainProviderStatus().model).toBe("claude-sonnet-5");
      const status = setBrainProviderModel("claude-cli", "claude-fable-5");
      expect(status.model).toBe("claude-fable-5");
      expect(status.models["claude-cli"]).toContain("claude-sonnet-5");
      expect(status.models.codex).toContain("gpt-5.6-luna");

      // The model reaches the CLI invocation (WSL bridge string and args).
      const bridged = claudeCliInvocation("claude-fable-5");
      expect(bridged.args.join(" ")).toContain("--model claude-fable-5");

      // Unsafe names never reach a shell string.
      expect(() => setBrainProviderModel("claude-cli", 'fable"; rm -rf ~')).toThrow(/letters, digits/i);
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses codex without a stored session instead of starting an interactive login", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-codex-nosession-"));
    const previousSessionPath = config.memory.codexSessionPath;
    const restore = configureBrain({
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "codex"
    });
    // Point the session lookup at a file that does not exist.
    config.memory.codexSessionPath = path.join(tempDir, "codex-session.json");
    try {
      enableBrainProvider("codex");
      const status = getBrainProviderStatus();
      expect(status.sessionMissing).toBe(true);
      expect(status.message).toContain("login-codex");
      // Generation refuses fast — the observed failure mode was connect()
      // blocking the whole server in an interactive OAuth flow.
      await expect(generateStructured({ system: "s", user: "u", maxOutputTokens: 64 })).rejects.toThrow(/no local session/i);
      // Model-mode runs refuse up front with the same actionable message.
      const repository = new MemoryArchiveRepository();
      const { startBrainRun } = await import("../src/server/brain/runJob");
      const refused = startBrainRun(repository, { mode: "model" });
      expect(refused.started).toBe(false);
      expect(refused.refusal).toContain("login-codex");
    } finally {
      config.memory.codexSessionPath = previousSessionPath;
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses model JSON defensively and keeps provider state free of content", async () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('noise before {"a":{"b":2}} noise after')).toEqual({ a: { b: 2 } });
    expect(() => parseModelJson("no json here")).toThrow(/not parseable/i);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-provider-priv-"));
    const restore = configureBrain({ providerConfigPath: path.join(tempDir, "provider.json"), provider: "claude-cli" });
    try {
      enableBrainProvider("claude-cli");
      const serialized = JSON.stringify(getBrainProviderStatus());
      expect(serialized).not.toContain("FAKE_SECRET_DO_NOT_LOG");
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("brain correctness debts", () => {
  it("keeps a message tied to the watermark visible and never re-opens the seen boundary (D1)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-tie-"));
    const restore = configureBrain({ rootDir: tempDir, provider: "extractive" });
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const base = Date.now() - 2 * DAY_MS;
      await seedChat(repository, "tie@g.us", [
        message("T1", "tie@g.us", { timestampMs: base }),
        message("T2", "tie@g.us", { timestampMs: base + DAY_MS })
      ]);
      // Commit a real episode; the watermark cursor advances to (T2.ts, T2.rowid).
      const packs = await buildEvidencePacks(repository, { chatSourceId: "tie@g.us", startAtMs: 0, endAtMs: Date.now() });
      await generateEpisodeForPack(repository, packs[0], { generator: "extractive" });
      // The seen boundary is not re-opened even if the digest didn't cite it.
      expect(await repository.getBrainChatBacklog({ limit: 10 })).toHaveLength(0);

      // A NEW message arrives sharing T2's exact timestamp (higher rowid).
      await repository.upsertMessages([message("T3", "tie@g.us", { timestampMs: base + DAY_MS })]);
      const backlog = await repository.getBrainChatBacklog({ limit: 10 });
      expect(backlog).toHaveLength(1);
      expect(backlog[0].pendingVisibleMessages).toBe(1);
      // covered ⟺ selected: assimilated + pending == total, no phantom coverage.
      const status = await repository.getBrainStatus();
      expect(status.totalVisibleMessages).toBe(3);
      expect(status.assimilatedVisibleMessages).toBe(2);
      expect(status.assimilatedVisibleMessages + backlog[0].pendingVisibleMessages).toBe(status.totalVisibleMessages);
    } finally {
      await repository.close?.();
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("never reports phantom coverage for a timestamp-0 message without a watermark (D1)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-zero-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedChat(repository, "zero@g.us", [message("Z1", "zero@g.us", { timestampMs: 0 })]);
      const status = await repository.getBrainStatus();
      expect(status.totalVisibleMessages).toBe(1);
      expect(status.assimilatedVisibleMessages).toBe(0);
      expect(status.coveragePercent).toBe(0);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rekeys episodes, citations, and the watermark and drops stranded tasks on identity merge (D2)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-merge-"));
    const restore = configureBrain({ rootDir: tempDir, provider: "extractive" });
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    const lid = "111@lid";
    const pn = "222@s.whatsapp.net";
    try {
      const base = Date.now() - 2 * DAY_MS;
      await seedChat(repository, lid, [
        message("A1", lid, { timestampMs: base }),
        message("A2", lid, { timestampMs: base + DAY_MS })
      ]);
      const packs = await buildEvidencePacks(repository, { chatSourceId: lid, startAtMs: 0, endAtMs: Date.now() });
      await generateEpisodeForPack(repository, packs[0], { generator: "extractive" });
      expect(await repository.getBrainChatBacklog({ limit: 10 })).toHaveLength(0);
      // A stale pending task under the pre-merge identity.
      await repository.enqueueBrainTasks([{ kind: "episode", chatSourceId: lid, dedupeKey: `episode:${lid}:0` }]);

      const merged = await repository.mergeIdentity(lid, pn);
      expect(merged.chatsMerged).toBeGreaterThan(0);

      // Episode + citations follow the surviving identity via the rowid anchor.
      const episodes = await repository.listBrainEpisodes({ limit: 10 });
      expect(episodes).toHaveLength(1);
      expect(episodes[0].chatSourceId).toBe(pn);
      const citation = episodes[0].claims[0].citations[0];
      expect(citation.sourceChatId).toBe(pn);
      expect(citation.sourceMessageKey).toContain(pn);
      expect(citation.messageId).not.toBeNull();
      // Watermark survived under pn: no phantom backlog, no duplicate re-assimilation.
      const backlog = await repository.getBrainChatBacklog({ limit: 10 });
      expect(backlog.find((item) => item.chatSourceId === pn)?.pendingVisibleMessages ?? 0).toBe(0);
      // Stranded task dropped so the drain never re-covers the orphaned window.
      expect((await repository.getBrainTaskSummary()).pending).toBe(0);
    } finally {
      await repository.close?.();
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stores the per-episode fallback reason when a model run falls back to extractive (D3)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-fallback-"));
    const badStub = path.join(tempDir, "bad.cjs");
    await writeFile(
      badStub,
      `process.stdin.resume(); process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ summary: "s", claims: [{ kind: "fact", text: "t", cites: ["m999"] }] }),
          usage: { input_tokens: 1, output_tokens: 1 } }));
      });`,
      "utf8"
    );
    const restore = configureBrain({
      rootDir: tempDir,
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${badStub}`
    });
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      enableBrainProvider("claude-cli");
      await seedChat(repository, "fb@g.us", [
        message("F1", "fb@g.us", { timestampMs: Date.now() - 2 * DAY_MS, body: "We decided the launch date is May 4" }),
        message("F2", "fb@g.us", { timestampMs: Date.now() - DAY_MS, body: "Great, I will book the venue" })
      ]);
      const packs = await buildEvidencePacks(repository, { chatSourceId: "fb@g.us", startAtMs: 0, endAtMs: Date.now() });
      const result = await generateEpisodeForPack(repository, packs[0], { generator: "model", model: "claude-haiku-4-5" });
      expect(result.fellBackToExtractive).toBe(true);
      const episodes = await repository.listBrainEpisodes({ chatSourceId: "fb@g.us", limit: 5 });
      expect(episodes[0].generator).toBe("extractive");
      expect(episodes[0].fallbackReason).toBeTruthy();
    } finally {
      disableBrainProvider();
      await repository.close?.();
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("counts only chats that produced an episode, not empty windows visited (D3)", async () => {
    const repository = new MemoryArchiveRepository();
    // A regen task whose window has no messages: visited, produces nothing.
    await repository.enqueueBrainTasks([
      {
        kind: "episode",
        chatSourceId: "empty@g.us",
        payload: { chatSourceId: "empty@g.us", sinceMs: 0, throughMs: Date.now(), regen: true },
        dedupeKey: "episode:empty@g.us:regen"
      }
    ]);
    const result = await drainBrainTasks(repository, { maxTasks: 5, mode: "extractive", model: null, provider: "extractive", runId: null });
    expect(result.tasksDone).toBe(1);
    expect(result.chatsProduced).toBe(0);
    expect(result.episodes).toBe(0);
  });

  it("persists accumulated totals on a non-completed terminal run (D3)", async () => {
    const repository = new MemoryArchiveRepository();
    const runId = await repository.startBrainRun("manual");
    await repository.failBrainRun(runId, "budget_exceeded", "budget reached", {
      episodes: 3,
      claims: 9,
      chats: 2,
      chatsVisited: 4,
      modelCalls: 3,
      skippedForBudget: 5
    });
    const status = await repository.getBrainStatus();
    expect(status.latestRun?.status).toBe("budget_exceeded");
    expect(status.latestRun?.totals?.episodes).toBe(3);
    expect(status.latestRun?.totals?.skippedForBudget).toBe(5);
  });

  it("marks the auto-pass run failed when the drain throws, without waiting for a restart (D4)", async () => {
    class ThrowingRepository extends MemoryArchiveRepository {
      async claimDueBrainTasks(): Promise<never> {
        throw new Error("simulated DB error inside the drain");
      }
    }
    const repository = new ThrowingRepository();
    const restore = configureBrain({ scheduler: "auto" });
    try {
      // A pending task makes the pass run rather than short-circuit as nothing-due.
      await repository.enqueueBrainTasks([{ kind: "episode", chatSourceId: "x@g.us", dedupeKey: "episode:x:1" }]);
      await expect(runBrainMaintenancePass(repository, { force: true })).rejects.toThrow(/simulated DB error/);
      const status = await repository.getBrainStatus();
      expect(status.latestRun?.status).toBe("failed");
      expect(status.activeRun).toBeNull();
    } finally {
      restore();
    }
  });

  it("records estimated token usage rather than a silent zero (D6)", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.recordBrainLlmUsage({ purpose: "episode", provider: "codex/gpt", inputTokens: 120, outputTokens: 40, estimated: true });
    const usage = await repository.getBrainLlmUsage({ day: new Date().toISOString().slice(0, 10) });
    expect(usage.calls).toBe(1);
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(40);
  });
});
