// Brain scheduler: dueness computation and the queue-driven auto pass.
//
// Coverage truth lives in per-chat watermarks, so "what is due" is DERIVED live
// (never a stored counter): computeDueWork reads the backlog and applies the
// nightly cutoff, volume trigger, and significance gate. Under manual-first
// control (WAPP_BRAIN_SCHEDULER=paused, the default) dueness only alerts; only
// runBrainMaintenancePass — appended as the last recovery-tick pass under a
// cross-process `brain` job lock — spends the budget, and only when scheduling
// is set to auto.
//
// Work flows through the durable brain_tasks queue: due chats enqueue idempotent
// `episode` tasks (dedupe-keyed by chat + watermark), the pass drains a bounded
// batch, and a crash mid-drain is free — resetInFlightBrainTasks returns claimed
// work to pending on the next pass. Spend is rate-limited from the token ledger:
// the hourly cap paces the drain, the daily cap is a hard BUDGET_EXCEEDED stop.

import { randomUUID } from "node:crypto";
import type { BrainChatBacklogItem, BrainSchedulerStatus, BrainStatusSummary } from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { publicErrorMessage } from "../privacy";
import { buildEvidencePacks, generateEpisodeForPack } from "./episodes";
import { getBrainProviderStatus } from "./provider";

// A busy chat must be quiet this long before its intra-day volume episode fires,
// so an episode never splits an in-progress exchange.
const QUIET_WINDOW_MS = 30 * 60_000;
const BRAIN_LOCK_TTL_MS = 30 * 60_000;
// Bounded work per tick keeps the event loop responsive; the hourly ledger cap
// is the real rate limiter across ticks.
const MAX_TASKS_PER_PASS = 25;
// Volume-triggered chats jump ahead of the recency-ordered backlog.
const VOLUME_PRIORITY_BOOST = 10_000_000_000;
const TASK_BACKOFF_BASE_MS = 30_000;
const TASK_MAX_BACKOFF_MS = 60 * 60_000;
const TASK_MAX_ATTEMPTS = 8;

export interface BrainDueWork {
  runDue: boolean;
  dueReason: string | null;
  dueChats: BrainChatBacklogItem[];
  cutoffPassed: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// Most recent local occurrence of the nightly cutoff hour.
function nightlyBoundaryMs(nowMs: number): number {
  const boundary = new Date(nowMs);
  boundary.setHours(config.brain.cutoffHour, 0, 0, 0);
  if (boundary.getTime() > nowMs) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.getTime();
}

function utcMidnightMs(nowMs: number): number {
  const day = new Date(nowMs);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime();
}

// Significance gate: chats with fewer than the significance minimum of pending
// messages are NOT nightly-due — they wait to accumulate (or the startup
// catch-up audit picks them up) rather than burning a nightly call each.
function isNightlyDue(chat: BrainChatBacklogItem): boolean {
  return chat.pendingVisibleMessages >= config.brain.significanceMin;
}

// Volume trigger: a busy chat crossing the pending threshold AND quiet for the
// settle window earns an intra-day episode, before the nightly cutoff.
function isVolumeDue(chat: BrainChatBacklogItem, nowMs: number): boolean {
  return (
    chat.pendingVisibleMessages >= config.brain.volumeTrigger &&
    chat.newestVisibleMs != null &&
    nowMs - chat.newestVisibleMs >= QUIET_WINDOW_MS
  );
}

// Live-derived dueness: read the backlog, apply the triggers. Never mutates.
export async function computeDueWork(repository: ArchiveRepository, nowMs: number = Date.now()): Promise<BrainDueWork> {
  const backlog = await repository.getBrainChatBacklog({ limit: 1000 });
  const status = await repository.getBrainStatus();
  const boundary = nightlyBoundaryMs(nowMs);
  const lastFinished = status.latestRun?.finishedAt ? Date.parse(status.latestRun.finishedAt) : null;
  const cutoffPassed = lastFinished == null || lastFinished < boundary;
  const dueChats = backlog.filter((chat) => isVolumeDue(chat, nowMs) || (cutoffPassed && isNightlyDue(chat)));
  const pending = Math.max(0, status.totalVisibleMessages - status.assimilatedVisibleMessages);
  const runDue = dueChats.length > 0;
  const dueReason = runDue
    ? `${pending.toLocaleString()} message(s) across ${dueChats.length.toLocaleString()} chat(s) are waiting to be assimilated` +
      (cutoffPassed
        ? ` and no run has completed since the ${pad2(config.brain.cutoffHour)}:00 cutoff.`
        : ` (a busy chat crossed the volume trigger).`)
    : null;
  return { runDue, dueReason, dueChats, cutoffPassed };
}

// Cheap dueness for the brain overview API (polled by the UI): derive the alert
// from an already-computed status summary — NO extra queries. The auto pass
// recomputes precisely from the full backlog via computeDueWork before it
// spends, so this only needs to be a good-enough alert, not the spend decision.
export function schedulerStatusFromSummary(status: BrainStatusSummary, nowMs: number = Date.now()): BrainSchedulerStatus {
  const boundary = nightlyBoundaryMs(nowMs);
  const lastFinished = status.latestRun?.finishedAt ? Date.parse(status.latestRun.finishedAt) : null;
  const cutoffPassed = lastFinished == null || lastFinished < boundary;
  const pending = Math.max(0, status.totalVisibleMessages - status.assimilatedVisibleMessages);
  const nightlyDue = cutoffPassed && status.chatsWithBacklog > 0;
  const volumeDue = status.backlogSample.some((chat) => isVolumeDue(chat, nowMs));
  const runDue = nightlyDue || volumeDue;
  const dueReason = runDue
    ? `${pending.toLocaleString()} message(s) across ${status.chatsWithBacklog.toLocaleString()} chat(s) are waiting to be assimilated` +
      (nightlyDue
        ? ` and no run has completed since the ${pad2(config.brain.cutoffHour)}:00 cutoff.`
        : ` (a busy chat crossed the volume trigger).`)
    : null;
  return { mode: config.brain.scheduler, runDue, dueReason };
}

// Convenience for callers without a status in hand (one getBrainStatus).
export async function getSchedulerStatus(repository: ArchiveRepository, nowMs: number = Date.now()): Promise<BrainSchedulerStatus> {
  return schedulerStatusFromSummary(await repository.getBrainStatus(), nowMs);
}

// Enqueue one idempotent `episode` task per due chat. The dedupe key includes
// the current watermark, so re-enqueueing the same uncovered window is a no-op
// but a fresh window (after a commit advanced the watermark) enqueues anew.
export async function enqueueEpisodeTasksForChats(
  repository: ArchiveRepository,
  chats: BrainChatBacklogItem[],
  nowMs: number = Date.now()
): Promise<number> {
  const tasks = chats
    .filter((chat) => chat.pendingVisibleMessages > 0 && chat.newestVisibleMs != null)
    .map((chat) => ({
      kind: "episode" as const,
      chatSourceId: chat.chatSourceId,
      payload: { chatSourceId: chat.chatSourceId, sinceMs: chat.assimilatedThroughMs + 1, throughMs: chat.newestVisibleMs },
      dedupeKey: `episode:${chat.chatSourceId}:${chat.assimilatedThroughMs}`,
      priority: Math.floor((chat.newestVisibleMs ?? 0) / 1000) + (isVolumeDue(chat, nowMs) ? VOLUME_PRIORITY_BOOST : 0)
    }));
  return repository.enqueueBrainTasks(tasks);
}

// Startup catch-up audit: assimilation correctness must not depend on schedules
// firing, so on boot every uncovered window becomes a queued task. Chat priority
// is newest-first; within-chat oldest-first is inherent to buildEvidencePacks
// (chronological packs). Under manual mode these sit pending and surface as due
// work; under auto mode the next pass drains them rate-limited.
export async function auditCatchup(repository: ArchiveRepository, nowMs: number = Date.now()): Promise<{ enqueued: number; chats: number }> {
  const backlog = await repository.getBrainChatBacklog({ limit: 5000 });
  const newestFirst = [...backlog].sort((a, b) => (b.newestVisibleMs ?? 0) - (a.newestVisibleMs ?? 0));
  const enqueued = await enqueueEpisodeTasksForChats(repository, newestFirst, nowMs);
  return { enqueued, chats: newestFirst.length };
}

interface DrainOptions {
  maxTasks: number;
  mode: "model" | "extractive";
  model: string | null;
  provider: string;
  runId: string | null;
}

export interface DrainResult {
  episodes: number;
  claims: number;
  modelCalls: number;
  tasksDone: number;
  dailyExceeded: boolean;
  rateLimited: boolean;
}

// Execute one `episode` task: build packs for its window and commit cited
// episodes. Forward tasks clamp their start to the current watermark so a manual
// run that already advanced coverage is never re-covered (no duplicate
// episodes); regeneration tasks (from staleness) rebuild their exact window.
async function executeEpisodeTask(
  repository: ArchiveRepository,
  task: { chatSourceId: string | null; payload: Record<string, unknown> | null },
  options: DrainOptions
): Promise<{ episodes: number; claims: number; modelCalls: number }> {
  const payload = task.payload ?? {};
  const chatSourceId = String(payload.chatSourceId ?? task.chatSourceId ?? "");
  if (!chatSourceId) {
    return { episodes: 0, claims: 0, modelCalls: 0 };
  }
  const regen = payload.regen === true;
  let startAtMs = Number(payload.sinceMs ?? 0);
  let endAtMs = Number(payload.throughMs ?? Date.now());
  if (!regen) {
    const item = (await repository.getBrainChatBacklog({ limit: 5000 })).find((candidate) => candidate.chatSourceId === chatSourceId);
    if (!item) {
      // Watermark already covers this window (e.g. a manual run got here first).
      return { episodes: 0, claims: 0, modelCalls: 0 };
    }
    startAtMs = Math.max(startAtMs, item.assimilatedThroughMs + 1);
    endAtMs = Math.max(endAtMs, item.newestVisibleMs ?? endAtMs);
  }
  const packs = await buildEvidencePacks(repository, { chatSourceId, startAtMs, endAtMs });
  let episodes = 0;
  let claims = 0;
  let modelCalls = 0;
  for (const pack of packs) {
    const result = await generateEpisodeForPack(repository, pack, { generator: options.mode, model: options.model, runId: options.runId });
    episodes += 1;
    claims += result.episode.claims.length;
    if (result.usage) {
      modelCalls += 1;
      await repository.recordBrainLlmUsage({
        purpose: regen ? "episode-regen" : "episode",
        provider: `${options.provider}/${options.model ?? "default"}`,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens
      });
    }
    // Yield between packs so live ingestion and HTTP stay responsive.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { episodes, claims, modelCalls };
}

// Drain due tasks under the budget. Budget is read from the ledger before each
// task: the hourly cap paces the drain (leaves work pending), the daily cap is a
// hard stop. A failing task backs off exponentially and retires after the
// attempt cap so one poison task can never starve the queue.
export async function drainBrainTasks(repository: ArchiveRepository, options: DrainOptions): Promise<DrainResult> {
  let episodes = 0;
  let claims = 0;
  let modelCalls = 0;
  let tasksDone = 0;
  let dailyExceeded = false;
  let rateLimited = false;
  while (tasksDone < options.maxTasks) {
    if (options.mode === "model") {
      const now = Date.now();
      const daily = await repository.getBrainLlmUsage({ sinceMs: utcMidnightMs(now) });
      if (daily.calls + modelCalls >= config.brain.maxCallsPerDay) {
        dailyExceeded = true;
        break;
      }
      const hourly = await repository.getBrainLlmUsage({ sinceMs: now - 3600_000 });
      if (hourly.calls + modelCalls >= config.brain.maxCallsPerHour) {
        rateLimited = true;
        break;
      }
    }
    const [task] = await repository.claimDueBrainTasks(1);
    if (!task) {
      break;
    }
    if (task.kind !== "episode") {
      // The spine only executes episode work; other kinds belong to sibling
      // changes (rollups, graph, projection). Retire them loudly, never loop.
      await repository.failBrainTask(task.id, `Task kind "${task.kind}" is not supported by the brain spine executor.`);
      continue;
    }
    try {
      const result = await executeEpisodeTask(repository, task, options);
      episodes += result.episodes;
      claims += result.claims;
      modelCalls += result.modelCalls;
      await repository.completeBrainTask(task.id);
      tasksDone += 1;
    } catch (error) {
      const attempts = task.attempts + 1;
      const retryInMs = attempts < TASK_MAX_ATTEMPTS ? Math.min(TASK_MAX_BACKOFF_MS, TASK_BACKOFF_BASE_MS * 2 ** task.attempts) : null;
      await repository.failBrainTask(task.id, publicErrorMessage(error), { retryInMs });
    }
  }
  return { episodes, claims, modelCalls, tasksDone, dailyExceeded, rateLimited };
}

export interface BrainPassResult extends Partial<DrainResult> {
  ran: boolean;
  reason?: string;
}

// The recovery-tick brain pass: the last, lowest-priority pass so gap recovery,
// identity, secrets, and media never wait on it. No-ops unless scheduling is
// auto (or forced); holds the cross-process `brain` lock so a UI/CLI run never
// spends the budget concurrently; skips if a manual run is already active.
export async function runBrainMaintenancePass(
  repository: ArchiveRepository,
  options: { onEpisodesCommitted?: () => void; force?: boolean } = {}
): Promise<BrainPassResult> {
  if (!options.force && config.brain.scheduler !== "auto") {
    return { ran: false, reason: "paused" };
  }
  const { getBrainRunProgress } = await import("./runJob");
  if (getBrainRunProgress().state === "running") {
    return { ran: false, reason: "manual-run-active" };
  }
  const lockId = randomUUID();
  if (!(await repository.tryAcquireBrainLock(lockId, BRAIN_LOCK_TTL_MS))) {
    return { ran: false, reason: "locked" };
  }
  try {
    // The brain lock is held, so any task still 'running' is an orphan from a
    // pass killed mid-drain — return every one to pending immediately.
    await repository.resetInFlightBrainTasks(0);
    const due = await computeDueWork(repository);
    const summary = await repository.getBrainTaskSummary();
    if (!due.runDue && summary.pending === 0) {
      return { ran: false, reason: "nothing-due" };
    }
    await enqueueEpisodeTasksForChats(repository, due.dueChats);
    const provider = getBrainProviderStatus();
    const modelReady = provider.modelBacked && provider.enabled && !provider.degraded && !provider.sessionMissing;
    const mode: "model" | "extractive" = modelReady ? "model" : "extractive";
    // Pre-run budget guard: the pass fires every recovery tick, so when the
    // model budget is already spent this tick would otherwise open an empty run
    // row. Skip cleanly instead — the pending work waits for the budget to free.
    if (mode === "model") {
      const now = Date.now();
      const daily = await repository.getBrainLlmUsage({ sinceMs: utcMidnightMs(now) });
      if (daily.calls >= config.brain.maxCallsPerDay) {
        return { ran: false, reason: "daily-budget" };
      }
      const hourly = await repository.getBrainLlmUsage({ sinceMs: now - 3600_000 });
      if (hourly.calls >= config.brain.maxCallsPerHour) {
        return { ran: false, reason: "hourly-rate-limit" };
      }
    }
    const runId = await repository.startBrainRun("nightly");
    const result = await drainBrainTasks(repository, {
      maxTasks: MAX_TASKS_PER_PASS,
      mode,
      model: mode === "model" ? provider.model : null,
      provider: mode === "model" ? provider.provider : "extractive",
      runId
    });
    if (result.dailyExceeded) {
      await repository.failBrainRun(
        runId,
        "budget_exceeded",
        `Daily model-call budget (${config.brain.maxCallsPerDay}) reached; ${result.episodes} episode(s) committed, remaining work stays pending.`
      );
    } else {
      await repository.completeBrainRun(runId, {
        episodes: result.episodes,
        claims: result.claims,
        chats: result.tasksDone,
        modelCalls: result.modelCalls
      });
    }
    console.log(
      `[brain] auto pass (${mode}${mode === "model" ? `/${provider.model ?? "default"}` : ""}): ${result.episodes} episode(s), ${result.claims} claim(s), ${result.modelCalls} model call(s), ${result.tasksDone} task(s)` +
        (result.dailyExceeded ? " — DAILY BUDGET REACHED, remaining work pending" : result.rateLimited ? " — hourly rate limit, paused until budget frees" : "")
    );
    if (result.episodes > 0) {
      options.onEpisodesCommitted?.();
    }
    return { ran: true, ...result };
  } finally {
    await repository.releaseBrainLock(lockId);
  }
}
