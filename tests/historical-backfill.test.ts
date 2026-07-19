// Historical backfill (historical-backfill): resume-after-kill, D12 ordering
// with the significance floor, per-run pacing overrides with named stops,
// strict mode, the dashboard DTO (both repositories), and the sliding worker
// pool's semantics (overlap, per-chat isolation, degrade-without-failure).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import type { ArchiveRepository } from "../src/server/db/repository";
import { messageKey } from "../src/server/identity/keys";
import { enableBrainProvider } from "../src/server/brain/provider";
import { auditCatchup } from "../src/server/brain/scheduler";
import { getBrainBackfillStatus, getBrainRunProgress, startBrainRun } from "../src/server/brain/runJob";
import type { BrainRunRequest } from "../src/server/brain/runJob";
import type { MessageRecord } from "../src/shared/types";

// The claude-cli stub envelope: one committed model episode per call, with a
// small stagger so pooled calls genuinely interleave.
const OK_STUB = `let data=""; process.stdin.on("data",(c)=>{data+=c;}); process.stdin.on("end",()=>{
  const delay = 120 + (process.pid % 5) * 60;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
      result: JSON.stringify({ summary: "Backfill stub episode.", topics: ["backfill"],
        claims: [{ kind: "commitment", text: "Someone will send the report by Friday.", cites: [1], confidence: "stated" },
                 { kind: "fact", text: "The plan was agreed.", cites: [1], confidence: "stated" }] }),
      usage: { input_tokens: 500, output_tokens: 80 } }));
  }, delay);
});`;

// A stub whose payload cites an alias that never exists — validation fails on
// both attempts, so default mode falls back to extractive and strict throws.
const FAILING_STUB = `let data=""; process.stdin.on("data",(c)=>{data+=c;}); process.stdin.on("end",()=>{
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    result: JSON.stringify({ summary: "Bad stub.", topics: ["bad"],
      claims: [{ kind: "fact", text: "Cites a ghost.", cites: ["m999"], confidence: "stated" }] }),
    usage: { input_tokens: 100, output_tokens: 20 } }));
});`;

// The CALL itself fails (error envelope) — this degrades provider HEALTH after
// the consecutive-failure threshold, unlike FAILING_STUB whose call succeeds
// but whose payload fails validation (health stays clean, just a fallback).
const ERROR_STUB = `let data=""; process.stdin.on("data",(c)=>{data+=c;}); process.stdin.on("end",()=>{
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true,
    result: "API Error 429: usage_limit_reached" }));
});`;

let tempDir: string;
let previousBrainConfig: Record<string, unknown>;

async function useStub(script: string): Promise<void> {
  const stub = path.join(tempDir, `stub-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(stub, script, "utf8");
  Object.assign(config.brain, { claudeCommand: `node ${stub}` });
  enableBrainProvider("claude-cli");
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-backfill-"));
  previousBrainConfig = { ...config.brain };
  Object.assign(config.brain, {
    rootDir: tempDir,
    providerConfigPath: path.join(tempDir, "provider.json"),
    provider: "claude-cli"
  });
});

afterEach(async () => {
  Object.assign(config.brain, previousBrainConfig);
  await rm(tempDir, { recursive: true, force: true });
});

function message(id: string, chat: string, over: Partial<MessageRecord> & { timestampMs: number }): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(chat, id),
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId: chat,
    senderSourceJid: "1555@s.whatsapp.net",
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `plan update ${id} — send the report by Friday`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...over
  };
}

// Seed `chats` chats, each with `messagesPerChat` messages; chat 0 is the
// newest (largest timestamps), each later chat is one hour older.
async function seedChats(
  repository: ArchiveRepository,
  options: { chats: number; messagesPerChat?: number; baseMs?: number }
): Promise<string[]> {
  const runId = await repository.startImportRun({ test: true });
  const messagesPerChat = options.messagesPerChat ?? 6;
  const base = options.baseMs ?? Date.now() - 24 * 3_600_000;
  const ids: string[] = [];
  for (let index = 0; index < options.chats; index += 1) {
    const chat = `bf-${index}@g.us`;
    ids.push(chat);
    await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: `Backfill ${index}`, chatType: "group" }]);
    await repository.upsertMessages(
      Array.from({ length: messagesPerChat }, (_, m) =>
        message(`M${m}-${index}`, chat, { timestampMs: base - index * 3_600_000 + m * 60_000 })
      )
    );
  }
  await repository.setArchiveOwnerName("Abhishek");
  return ids;
}

async function runBackfill(repository: ArchiveRepository, request: Partial<BrainRunRequest>): Promise<ReturnType<typeof getBrainRunProgress>> {
  const started = startBrainRun(repository, { mode: "model", model: "stub-model", backfill: true, ...request });
  expect(started.started, started.refusal ?? "").toBe(true);
  while (getBrainRunProgress().state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getBrainRunProgress();
}

describe("backfill run kind (H1)", () => {
  it("audits, drains the queue, reports honest totals, and refuses invalid combinations", async () => {
    await useStub(OK_STUB);
    const repository = new MemoryArchiveRepository();
    await seedChats(repository, { chats: 3 });

    expect(startBrainRun(repository, { mode: "model", backfill: true, regenerate: true }).refusal).toMatch(/one at a time/);
    expect(startBrainRun(repository, { mode: "model", backfill: true, chatSourceId: "x@g.us" }).refusal).toMatch(/whole uncovered archive/);
    expect(startBrainRun(repository, { mode: "model", strict: true }).refusal).toMatch(/backfill runs only/);
    expect(startBrainRun(repository, { mode: "extractive", backfill: true, strict: true }).refusal).toMatch(/needs a model/);

    const final = await runBackfill(repository, {});
    expect(final.state).toBe("completed");
    expect(final.kind).toBe("backfill");
    expect(final.episodesCommitted).toBe(3);
    // Progress-bar denominator, precomputed at start: 3 chats × 6 messages, no
    // prior episode to observe → default pack size → one episode per chat.
    expect(final.estimatedEpisodes).toBe(3);
    expect(final.extractiveEpisodes).toBe(0);
    expect(final.queuedTasks).toBe(0);
    expect(final.tokensUsed).toBe(3 * 580);
    const run = await repository.getBrainRun(final.runId!);
    expect(run?.kind).toBe("backfill");
    expect(run?.totals?.queuedAtStart).toBe(3);
    expect(run?.totals?.queuedRemaining).toBe(0);
    expect((await repository.getBrainChatBacklog({ limit: 100 })).length).toBe(0);
  });
});

describe("resume after kill (4.1)", () => {
  it("reclaims orphaned claims, re-audits idempotently, and never duplicates episodes", async () => {
    await useStub(OK_STUB);
    const repository = new MemoryArchiveRepository();
    const chats = await seedChats(repository, { chats: 3 });

    // First pass covers only one task (the scoped confidence knob).
    const first = await runBackfill(repository, { maxChats: 1 });
    expect(first.state).toBe("completed");
    expect(first.episodesCommitted).toBe(1);

    // Simulate a kill mid-drain: claim a task and leave it 'running'.
    await auditCatchup(repository);
    const [orphan] = await repository.claimDueBrainTasks(1, Date.now(), "episode");
    expect(orphan).toBeTruthy();
    expect((await repository.getBrainTaskSummary()).running).toBe(1);

    // The next backfill reclaims the orphan and finishes everything.
    const second = await runBackfill(repository, {});
    expect(second.state).toBe("completed");
    expect(second.episodesCommitted).toBe(2);
    expect((await repository.getBrainTaskSummary()).running).toBe(0);

    // Zero duplicates: exactly one episode per chat, and a re-audit is a no-op.
    for (const chat of chats) {
      expect((await repository.listBrainEpisodes({ chatSourceId: chat, status: "current", limit: 10 })).length, chat).toBe(1);
    }
    expect((await auditCatchup(repository)).enqueued).toBe(0);
    const third = await runBackfill(repository, {});
    expect(third.state).toBe("completed");
    expect(third.episodesCommitted).toBe(0);
  });

  it("releases a dead run's brain lock at reconcile so resume never waits out the TTL", async () => {
    const sqlite = new SqliteArchiveRepository(path.join(tempDir, "lock-drill.sqlite"));
    try {
      for (const repository of [sqlite, new MemoryArchiveRepository()] as ArchiveRepository[]) {
        // A killed backfill leaves its run 'running' and its run-id-keyed lock held.
        const deadRunId = await repository.startBrainRun("backfill");
        expect(await repository.tryAcquireBrainLock(deadRunId, 30 * 60_000)).toBe(true);
        // Another pass cannot acquire while the dead holder's TTL runs…
        expect(await repository.tryAcquireBrainLock("someone-else", 30 * 60_000)).toBe(false);
        // …until boot reconciliation proves the holder dead and releases it.
        expect(await repository.reconcileBrainRuns()).toBe(1);
        expect((await repository.getBrainRun(deadRunId))?.status).toBe("interrupted");
        expect(await repository.tryAcquireBrainLock("someone-else", 30 * 60_000)).toBe(true);
        await repository.releaseBrainLock("someone-else");
      }
    } finally {
      await sqlite.close?.();
    }
  });
});

describe("ordering and the significance floor (4.2)", () => {
  it("claims newest chats first and drains sub-significance chats last as week-bounded packs", async () => {
    const repository = new MemoryArchiveRepository();
    const runId = await repository.startImportRun({ test: true });
    await repository.setArchiveOwnerName("Abhishek");
    const base = Date.now() - 24 * 3_600_000;
    // old/new are significant (>= significanceMin pending); tiny is not.
    const seed: Array<[string, number, number]> = [
      ["old@g.us", base - 6 * 3_600_000, config.brain.significanceMin + 1],
      ["new@g.us", base, config.brain.significanceMin + 1],
      ["tiny@g.us", base + 3_600_000, Math.max(1, config.brain.significanceMin - 1)]
    ];
    for (const [chat, at, count] of seed) {
      await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: chat, chatType: "group" }]);
      await repository.upsertMessages(Array.from({ length: count }, (_, m) => message(`M${m}`, chat, { timestampMs: at + m * 60_000 })));
    }
    await auditCatchup(repository);
    const order: string[] = [];
    for (;;) {
      const [task] = await repository.claimDueBrainTasks(1, Date.now(), "episode");
      if (!task) break;
      order.push(task.chatSourceId!);
    }
    // tiny@g.us is the NEWEST chat but drains LAST (priority floor 0).
    expect(order).toEqual(["new@g.us", "old@g.us", "tiny@g.us"]);
  });

  it("assimilates within a chat oldest-first from the watermark", async () => {
    await useStub(OK_STUB);
    const repository = new MemoryArchiveRepository();
    const runId = await repository.startImportRun({ test: true });
    await repository.setArchiveOwnerName("Abhishek");
    const chat = "span@g.us";
    await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: "Span", chatType: "group" }]);
    // Two clusters more than a week apart force two chronological packs.
    const early = Date.now() - 30 * 24 * 3_600_000;
    const late = Date.now() - 2 * 24 * 3_600_000;
    await repository.upsertMessages([
      message("E1", chat, { timestampMs: early }),
      message("E2", chat, { timestampMs: early + 60_000 }),
      message("L1", chat, { timestampMs: late }),
      message("L2", chat, { timestampMs: late + 60_000 })
    ]);
    const final = await runBackfill(repository, {});
    expect(final.state).toBe("completed");
    const episodes = await repository.listBrainEpisodes({ chatSourceId: chat, status: "current", limit: 10 });
    expect(episodes.length).toBe(2);
    const sorted = [...episodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.startAtMs - b.startAtMs);
    // Committed oldest window first.
    expect(sorted[0]!.startAtMs).toBeLessThan(sorted[1]!.startAtMs);
  });
});

describe("pacing overrides and named budget stops (4.3)", () => {
  it("imposes NO hourly ceiling when the override is absent — the config pace never stops a turbo", async () => {
    await useStub(OK_STUB);
    // A punishingly low configured hourly pace that WOULD stop a run if it
    // applied: it must not, because backfill's blank hourly means "no ceiling".
    Object.assign(config.brain, { maxCallsPerHour: 2, maxCallsPerDay: 10_000 });
    const repository = new MemoryArchiveRepository();
    await seedChats(repository, { chats: 5 });
    const final = await runBackfill(repository, { concurrency: 1 });
    // All five drain despite the config's 2/hour — the pace was ignored.
    expect(final.state).toBe("completed");
    expect(final.episodesCommitted).toBe(5);
    expect(final.modelCalls).toBe(5);
    expect((await repository.getBrainChatBacklog({ limit: 100 })).length).toBe(0);
  });

  it("stops at the hourly override with the pace named and the override persisted", async () => {
    await useStub(OK_STUB);
    const repository = new MemoryArchiveRepository();
    await seedChats(repository, { chats: 3 });
    const final = await runBackfill(repository, { callsPerHour: 1, concurrency: 1 });
    expect(final.state).toBe("budget_exceeded");
    expect(final.modelCalls).toBe(1);
    const run = await repository.getBrainRun(final.runId!);
    expect(run?.status).toBe("budget_exceeded");
    expect(run?.errorMessage ?? "").toContain("Hourly pace (1 calls/hour)");
    expect(run?.totals?.callsPerHourOverride).toBe(1);
    // Remaining work stays pending for the next run.
    expect((await repository.getBrainTaskSummary()).pending).toBeGreaterThan(0);
  });

  it("stops at the daily override, the per-run call ceiling, and the token budget — each named", async () => {
    await useStub(OK_STUB);
    const repository = new MemoryArchiveRepository();
    await seedChats(repository, { chats: 3 });
    const daily = await runBackfill(repository, { callsPerDay: 1, concurrency: 1 });
    expect(daily.state).toBe("budget_exceeded");
    expect((await repository.getBrainRun(daily.runId!))?.errorMessage).toContain("Daily model-call budget (1)");

    const calls = await runBackfill(repository, { maxModelCalls: 1, concurrency: 1, callsPerHour: 1000, callsPerDay: 10_000 });
    expect(calls.state).toBe("budget_exceeded");
    expect((await repository.getBrainRun(calls.runId!))?.errorMessage).toContain("Model-call ceiling for this run (1 call(s))");

    const tokens = await runBackfill(repository, { maxTokens: 100, concurrency: 1, callsPerHour: 1000, callsPerDay: 10_000 });
    expect(tokens.state).toBe("budget_exceeded");
    expect((await repository.getBrainRun(tokens.runId!))?.errorMessage).toContain("Token budget for this run (100 tokens)");

    // Coverage only ever moved forward; a wide-open run finishes the rest.
    const rest = await runBackfill(repository, { callsPerHour: 1000, callsPerDay: 10_000 });
    expect(rest.state).toBe("completed");
    expect((await repository.getBrainChatBacklog({ limit: 100 })).length).toBe(0);
  });
});

describe("strict mode (4.4)", () => {
  it("commits nothing on double failure, keeps the watermark, and fails the task visibly", async () => {
    await useStub(FAILING_STUB);
    const repository = new MemoryArchiveRepository();
    const [chat] = await seedChats(repository, { chats: 1 });
    const backlogBefore = await repository.getBrainChatBacklog({ limit: 10 });
    const final = await runBackfill(repository, { strict: true, callsPerHour: 1000 });
    // The run itself completes (drain exhausted: the failed task is backing off).
    expect(final.state).toBe("completed");
    expect(final.episodesCommitted).toBe(0);
    // No placeholder, no watermark movement.
    expect((await repository.listBrainEpisodes({ chatSourceId: chat!, limit: 10 })).length).toBe(0);
    const backlogAfter = await repository.getBrainChatBacklog({ limit: 10 });
    expect(backlogAfter[0]?.assimilatedThroughMs).toBe(backlogBefore[0]?.assimilatedThroughMs);
    // The failure is visible: the task carries attempts and the strict error.
    const summary = await repository.getBrainTaskSummary();
    expect(summary.pending + summary.failed).toBeGreaterThan(0);
    const [task] = await repository.claimDueBrainTasks(1, Date.now() + 3_600_000, "episode");
    expect(task?.attempts).toBe(1);
    expect(task?.lastError ?? "").toContain("Strict mode");
  });

  it("default mode commits the placeholder instead, and the sweep selects it", async () => {
    await useStub(FAILING_STUB);
    const repository = new MemoryArchiveRepository();
    const [chat] = await seedChats(repository, { chats: 1 });
    const final = await runBackfill(repository, { callsPerHour: 1000 });
    expect(final.state).toBe("completed");
    expect(final.episodesCommitted).toBe(1);
    expect(final.extractiveEpisodes).toBe(1);
    const [episode] = await repository.listBrainEpisodes({ chatSourceId: chat!, status: "current", limit: 1 });
    expect(episode?.generator).toBe("extractive");
    expect(episode?.attemptedModel).toBe("stub-model");
    // Coverage advanced (never blocks on model quality)…
    expect((await repository.getBrainChatBacklog({ limit: 10 })).length).toBe(0);
    // …and the placeholder is exactly what the sweep selects.
    const sweep = await repository.listRegenerableBrainEpisodes({ currentVersion: 999, onlyExtractive: true, limit: 10 });
    expect(sweep.map((row) => row.id)).toEqual([episode!.id]);
  });
});

describe("mid-run provider-degradation guard", () => {
  it("STOPS the run when the provider degrades instead of flooding the queue with placeholders", async () => {
    // The overnight-run lesson: when codex hit its usage limit the drain kept
    // going and turned the entire remaining queue into extractive placeholders
    // in minutes. The guard must halt the run the moment the provider latches
    // degraded, leaving the rest pending for a clean resume.
    await useStub(ERROR_STUB);
    // Deterministic degrade: threshold 3, serial drain. Chat 1 racks up
    // failures and falls back; chat 2's failures trip the threshold; the guard
    // stops before chat 3 — so only a couple placeholders, not all 15.
    Object.assign(config.brain, { providerFailureThreshold: 3, maxCallsPerHour: 100_000, maxCallsPerDay: 100_000 });
    const repository = new MemoryArchiveRepository();
    await seedChats(repository, { chats: 15 });
    const final = await runBackfill(repository, { concurrency: 1, callsPerDay: 100_000 });

    // Named, resumable stop — not a false "completed", not a hard "failed".
    expect(final.state).toBe("interrupted");
    const run = await repository.getBrainRun(final.runId!);
    expect(run?.status).toBe("interrupted");
    expect(run?.errorMessage ?? "").toMatch(/unavailable/i);
    // Only a handful of placeholders escaped before the halt — NOT all 15.
    expect(final.episodesCommitted).toBeLessThanOrEqual(4);
    expect(final.extractiveEpisodes).toBe(final.episodesCommitted);
    // The bulk of the queue is still pending, ready to resume after recovery.
    expect((await repository.getBrainTaskSummary()).pending).toBeGreaterThanOrEqual(10);
    expect((await repository.getBrainChatBacklog({ limit: 100 })).length).toBeGreaterThanOrEqual(10);
  });
});

describe("dashboard DTO (4.5, both repositories)", () => {
  async function withRepos(test: (repository: ArchiveRepository, kind: string) => Promise<void>): Promise<void> {
    const sqlite = new SqliteArchiveRepository(path.join(tempDir, `dash-${Math.random().toString(36).slice(2)}.sqlite`));
    try {
      await test(sqlite, "sqlite");
    } finally {
      await sqlite.close?.();
    }
    await test(new MemoryArchiveRepository(), "memory");
  }

  it("computes coverage, queue, drain rate, canary counts, and per-model spend", async () => {
    await useStub(OK_STUB);
    await withRepos(async (repository, kind) => {
      await seedChats(repository, { chats: 2, messagesPerChat: 4 });
      await repository.recordBrainLlmUsage({ purpose: "episode", provider: "codex/terra", inputTokens: 100, outputTokens: 10 });
      await repository.recordBrainLlmUsage({ purpose: "episode", provider: "codex/terra", inputTokens: 200, outputTokens: 20 });
      await repository.recordBrainLlmUsage({ purpose: "episode", provider: "claude/haiku", inputTokens: 50, outputTokens: 5 });
      const before = await repository.getBrainBackfillStats();
      expect(before.totalVisibleMessages, kind).toBe(8);
      expect(before.assimilatedVisibleMessages, kind).toBe(0);
      expect(before.pendingChats, kind).toBe(2);
      expect(before.currentEpisodes, kind).toBe(0);
      expect(before.spendByModel.length, kind).toBe(2);
      const terra = before.spendByModel.find((row) => row.provider === "codex/terra")!;
      expect(terra.calls, kind).toBe(2);
      expect(terra.inputTokens, kind).toBe(300);
      expect(terra.callsToday, kind).toBe(2);

      const final = await runBackfill(repository, { callsPerHour: 1000, callsPerDay: 10_000 });
      expect(final.state, kind).toBe("completed");
      const stats = await repository.getBrainBackfillStats();
      expect(stats.assimilatedVisibleMessages, kind).toBe(8);
      expect(stats.pendingChats, kind).toBe(0);
      expect(stats.queuedEpisodeTasks, kind).toBe(0);
      expect(stats.episodesLastHour, kind).toBe(2);
      expect(stats.currentEpisodes, kind).toBe(2);
      expect(stats.avgEpisodeMessages, kind).toBe(4);
      expect(stats.modelAttemptedEpisodes, kind).toBe(2);
      expect(stats.fallbackEpisodes, kind).toBe(0);
      expect(stats.sweepableExtractive, kind).toBe(0);

      const dto = await getBrainBackfillStatus(repository);
      expect(dto.coveragePercent, kind).toBe(100);
      expect(dto.pendingMessages, kind).toBe(0);
      expect(dto.running, kind).toBeNull();
      // Trailing hour has 2 episodes: a rate exists, but the ETA denominator
      // (10 episodes) is not met — the ETA must be honest and stay null.
      expect(dto.drainRatePerHour, kind).toBe(2);
      expect(dto.etaHours, kind).toBeNull();
      expect(dto.fallback.totalEpisodes, kind).toBe(2);
      expect(dto.fallback.ratePercent, kind).toBe(0);
      expect(dto.fallback.warning, kind).toBe(false);
    });
  });

  it("raises the canary warning only past the threshold with the minimum denominator", async () => {
    await useStub(FAILING_STUB);
    await withRepos(async (repository, kind) => {
      // 3 fallbacks out of 3 attempts — 100% rate but UNDER the 20-episode
      // denominator: loud in counts, but no warning flag yet.
      await seedChats(repository, { chats: 3, messagesPerChat: 3 });
      const final = await runBackfill(repository, { callsPerHour: 1000, callsPerDay: 10_000 });
      expect(final.state, kind).toBe("completed");
      const dto = await getBrainBackfillStatus(repository);
      expect(dto.fallback.extractiveEpisodes, kind).toBe(3);
      expect(dto.fallback.ratePercent, kind).toBe(100);
      expect(dto.fallback.warning, kind).toBe(false);
      expect(dto.sweepableExtractive, kind).toBe(3);
    });
  });
});

describe("sliding worker pool (4.6)", () => {
  it("overlaps across chats and matches the serial outcome exactly", async () => {
    await useStub(OK_STUB);
    // The same 6-chat workload twice: serial (concurrency 1) then pooled
    // (concurrency 3) on a fresh repository. Overlap is proven against the
    // MEASURED serial wall — immune to per-machine spawn-cost variance — and
    // a batch-barrier pool would not reach this bound on staggered latencies.
    const serialRepo = new MemoryArchiveRepository();
    await seedChats(serialRepo, { chats: 6, messagesPerChat: 4 });
    const serialStart = Date.now();
    const serial = await runBackfill(serialRepo, { concurrency: 1, callsPerHour: 1000, callsPerDay: 10_000 });
    const serialWallMs = Date.now() - serialStart;
    expect(serial.state).toBe("completed");
    expect(serial.episodesCommitted).toBe(6);

    const pooledRepo = new MemoryArchiveRepository();
    const chats = await seedChats(pooledRepo, { chats: 6, messagesPerChat: 4 });
    const pooledStart = Date.now();
    const pooled = await runBackfill(pooledRepo, { concurrency: 3, callsPerHour: 1000, callsPerDay: 10_000 });
    const pooledWallMs = Date.now() - pooledStart;
    expect(pooled.state).toBe("completed");
    expect(pooled.episodesCommitted).toBe(6);
    expect(pooledWallMs, `pooled ${pooledWallMs}ms vs serial ${serialWallMs}ms`).toBeLessThan(serialWallMs * 0.7);

    // Serial outcome equivalence: identical per-chat episodes, watermarks
    // advanced everywhere, citations isolated to their own chat.
    for (const chat of chats) {
      const pooledEpisodes = await pooledRepo.listBrainEpisodes({ chatSourceId: chat, status: "current", limit: 10 });
      const serialEpisodes = await serialRepo.listBrainEpisodes({ chatSourceId: chat, status: "current", limit: 10 });
      expect(pooledEpisodes.length, chat).toBe(serialEpisodes.length);
      expect(pooledEpisodes.length, chat).toBe(1);
      expect(pooledEpisodes[0]!.claims.length, chat).toBe(serialEpisodes[0]!.claims.length);
      for (const claim of pooledEpisodes[0]!.claims) {
        for (const citation of claim.citations) {
          expect(citation.sourceChatId, chat).toBe(chat);
        }
      }
    }
    expect((await pooledRepo.getBrainChatBacklog({ limit: 100 })).length).toBe(0);
  });

  it("provider failure degrades to fallbacks without failing the run (honest totals)", async () => {
    await useStub(FAILING_STUB);
    const repository = new MemoryArchiveRepository();
    await seedChats(repository, { chats: 4, messagesPerChat: 3 });
    const final = await runBackfill(repository, { concurrency: 3, callsPerHour: 1000, callsPerDay: 10_000 });
    expect(final.state).toBe("completed");
    expect(final.episodesCommitted).toBe(4);
    expect(final.extractiveEpisodes).toBe(4);
  });
});
