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
import type { BrainChatBacklogItem, BrainSchedulerStatus, BrainStatusSummary, BrainTaskKind } from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { publicErrorMessage } from "../privacy";
import { buildEvidencePacks, generateEpisodeForPack, regenerateEpisode } from "./episodes";
import { brainProviderDegradationReason, getBrainProviderStatus } from "./provider";

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

// UTC date (YYYY-MM-DD) matching the ledger's `day` column, so daily budget
// checks hit the (day, purpose) index instead of scanning by timestamp.
function utcDayString(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
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
      // Significance floor (backfill H3 / resolved D12): the trivia tail —
      // chats below the significance minimum — drains last at priority 0;
      // everything else keeps newest-chat-first recency order.
      priority:
        chat.pendingVisibleMessages < config.brain.significanceMin
          ? 0
          : Math.floor((chat.newestVisibleMs ?? 0) / 1000) + (isVolumeDue(chat, nowMs) ? VOLUME_PRIORITY_BOOST : 0)
    }));
  return repository.enqueueBrainTasks(tasks);
}

// Startup catch-up audit: assimilation correctness must not depend on schedules
// firing, so on boot every uncovered window becomes a queued task. Chat priority
// is newest-first; within-chat oldest-first is inherent to buildEvidencePacks
// (chronological packs). Under manual mode these sit pending and surface as due
// work; under auto mode the next pass drains them rate-limited.
export async function auditCatchup(
  repository: ArchiveRepository,
  nowMs: number = Date.now()
): Promise<{ enqueued: number; chats: number; backlog: BrainChatBacklogItem[] }> {
  const backlog = await repository.getBrainChatBacklog({ limit: 5000 });
  const newestFirst = [...backlog].sort((a, b) => (b.newestVisibleMs ?? 0) - (a.newestVisibleMs ?? 0));
  const enqueued = await enqueueEpisodeTasksForChats(repository, newestFirst, nowMs);
  // Returns the newest-first backlog it enqueued so a caller (the backfill run)
  // can size the work without a second full scan.
  return { enqueued, chats: newestFirst.length, backlog: newestFirst };
}

interface DrainOptions {
  maxTasks: number;
  mode: "model" | "extractive";
  model: string | null;
  provider: string;
  runId: string | null;
  // Restrict the drain to one task kind (a regenerate run must not claim
  // forward episode tasks). Undefined claims everything due.
  onlyKind?: BrainTaskKind;
  // Per-run ledger pacing overrides (backfill turbo, H2): replace the
  // configured hourly/daily caps for THIS drain only.
  callsPerHour?: number | null;
  callsPerDay?: number | null;
  // Per-run ceilings — named stops distinct from the ledger caps.
  maxModelCalls?: number | null;
  maxTokens?: number | null;
  // Strict backfill (H5): a pack whose model generation fails after the retry
  // throws instead of committing an extractive placeholder, failing the task
  // into backoff/retirement with the watermark unchanged.
  strict?: boolean;
  // Sliding worker pool width (H7): parallel ACROSS chats, always serial
  // within a chat. 1 (the default) is the plain serial drain.
  concurrency?: number;
  // Cooperative hooks for run-job integration: progress ticks and cancellation.
  onTaskDone?: () => void;
  // Live per-episode hook so long drains stream progress (tokens, fallbacks)
  // instead of reporting only at the end.
  onEpisode?: (event: { chatName: string | null; fellBack: boolean; claims: number; tokens: number; modelCall: boolean }) => void;
  shouldStop?: () => boolean;
}

export interface DrainResult {
  episodes: number;
  // Of episodes, how many fell back to extractive placeholders.
  extractive: number;
  // Of those, how many fell back because the provider deterministically refused
  // the pack's prompt (a 400-class rejection) rather than because generation or
  // validation failed. These are quarantined: the drain keeps going, and the
  // provider is NOT treated as unavailable.
  quarantined: number;
  // The first quarantine reason seen, for the run outcome. Null when none.
  quarantineReason: string | null;
  claims: number;
  modelCalls: number;
  // Accumulated input+output tokens across this drain's model calls.
  tokensUsed: number;
  tasksDone: number;
  // Tasks that actually produced at least one episode (the honest chat count);
  // already-covered/empty windows increment tasksDone only.
  chatsProduced: number;
  dailyExceeded: boolean;
  rateLimited: boolean;
  // Per-run ceilings (backfill): distinct named stops for the run record.
  callBudgetExceeded: boolean;
  tokenBudgetExceeded: boolean;
  // The provider health-tracker latched degraded mid-drain — the drain stopped
  // rather than mass-committing extractive placeholders. Remaining work stays
  // pending; resume after recovery.
  providerDegraded: boolean;
  // The MEASURED degradation reason captured at latch time (consecutive-failure
  // count + real last error), so the run message names the true cause even if a
  // late in-flight success clears provider health before the message is built.
  // Empty string unless providerDegraded is true.
  providerDegradationReason: string;
}

// Hooks a drain hands to task execution: `record` centralizes accounting
// (counters + ledger + live progress) in the drain closure so a pooled drain
// has ONE consistent view; `shouldStopPacks` is consulted before each pack so
// budgets and cancellation stop a long chat MID-task (the committed packs keep
// the watermark honest; the task stays claimed and is reclaimed to pending by
// the caller, resuming precisely from the watermark).
interface TaskExecutionHooks {
  record: (result: Awaited<ReturnType<typeof generateEpisodeForPack>>, purpose: string, chatName: string | null) => Promise<void>;
  shouldStopPacks: () => Promise<boolean>;
}

// Execute one `episode` or `regenerate` task. Forward episode tasks clamp
// their start to the current watermark so a manual run that already advanced
// coverage is never re-covered (no duplicate episodes). Regeneration tasks —
// kind 'regenerate' (stale extraction version / extractive upgrade) and legacy
// 'episode' tasks with a regen payload (staleness propagation) — rebuild their
// episode's exact stored window without touching the watermark and supersede
// the old episode.
async function executeEpisodeTask(
  repository: ArchiveRepository,
  task: { kind: string; chatSourceId: string | null; payload: Record<string, unknown> | null },
  options: DrainOptions,
  hooks: TaskExecutionHooks
): Promise<{ episodes: number; stopped: boolean }> {
  const payload = task.payload ?? {};
  const chatSourceId = String(payload.chatSourceId ?? task.chatSourceId ?? "");
  if (!chatSourceId) {
    return { episodes: 0, stopped: false };
  }
  const regenEpisodeId = task.kind === "regenerate" || payload.regen === true ? String(payload.episodeId ?? "") : "";
  let episodes = 0;
  if (regenEpisodeId) {
    const [oldEpisode] = await repository.listBrainEpisodes({ episodeId: regenEpisodeId, limit: 1 });
    if (!oldEpisode || oldEpisode.status === "superseded") {
      // Already regenerated (or reset); the task is complete by construction.
      return { episodes, stopped: false };
    }
    const outcome = await regenerateEpisode(repository, oldEpisode, {
      generator: options.mode,
      model: options.model,
      runId: options.runId
    });
    for (const result of outcome.results) {
      episodes += 1;
      await hooks.record(result, "episode-regen", oldEpisode.chatDisplayName ?? chatSourceId);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { episodes, stopped: false };
  }
  // Chat-scoped backlog read: the full-archive aggregation costs ~400ms of
  // synchronous scan per claim at real-archive size — a pooled drain would
  // stall the event loop paying it five times in a burst.
  const [item] = await repository.getBrainChatBacklog({ limit: 1, chatSourceId });
  if (!item) {
    // Watermark already covers this window (e.g. a manual run got here first).
    return { episodes, stopped: false };
  }
  const endAtMs = Math.max(Number(payload.throughMs ?? Date.now()), item.newestVisibleMs ?? 0);
  const packs = await buildEvidencePacks(repository, {
    chatSourceId,
    startAtMs: item.assimilatedThroughMs,
    afterId: item.assimilatedThroughId,
    endAtMs
  });
  for (const pack of packs) {
    if (await hooks.shouldStopPacks()) {
      return { episodes, stopped: true };
    }
    const result = await generateEpisodeForPack(repository, pack, {
      generator: options.mode,
      model: options.model,
      runId: options.runId,
      strict: options.strict
    });
    episodes += 1;
    await hooks.record(result, "episode", item.chatDisplayName ?? chatSourceId);
    // Yield between packs so live ingestion and HTTP stay responsive.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { episodes, stopped: false };
}

// Drain due tasks under the budget through a SLIDING worker pool (H7).
//
// Concurrency 1 (auto passes, regeneration) is the plain serial drain.
// Backfill turbo widens the pool: parallelism exists only ACROSS chats (one
// whole chat task per worker; a per-chat lane chains any second task for the
// same chat behind the first), and the pool is sliding, never batched — the
// moment any in-flight task settles, its slot claims the next due task.
//
// Budgets are read before EACH claim (per-claim, not per-batch): the ledger
// caps (hourly pace / daily ceiling — per-run overrides replace the config
// defaults when given) and the per-run ceilings (call count / token budget)
// each set a distinct named stop. Calls already in flight can land after a
// check, so a stop may overshoot by at most workers−1 calls, every one still
// recorded in the ledger. Between packs inside a long chat the same checks run
// again, so a single 500-pack chat cannot sail past a budget inside one task.
// A failing task backs off exponentially and retires after the attempt cap so
// one poison task (or a provider rate-limit) can never starve the queue or
// fail the run.
export async function drainBrainTasks(repository: ArchiveRepository, options: DrainOptions): Promise<DrainResult> {
  const workers = Math.max(1, Math.min(6, Math.floor(options.concurrency ?? 1)));
  const hourlyCap = options.callsPerHour ?? config.brain.maxCallsPerHour;
  const dailyCap = options.callsPerDay ?? config.brain.maxCallsPerDay;
  const counters = { episodes: 0, extractive: 0, claims: 0, modelCalls: 0, tokensUsed: 0, tasksDone: 0, chatsProduced: 0, quarantined: 0 };
  let quarantineReason: string | null = null;
  let dailyExceeded = false;
  let rateLimited = false;
  let callBudgetExceeded = false;
  let tokenBudgetExceeded = false;
  let providerDegraded = false;
  let providerDegradationReason = "";
  let claimed = 0;
  const inFlight = new Set<Promise<void>>();
  const chatLanes = new Map<string, Promise<void>>();
  // A repository-level failure inside a worker must not reject the pool while
  // sibling workers are mid-commit: capture the first fatal, let the pool
  // reach quiescence, then throw it (the run still fails, but never with
  // detached writers left running).
  let fatalError: unknown = null;

  const record: TaskExecutionHooks["record"] = async (result, purpose, chatName) => {
    counters.episodes += 1;
    if (result.fellBackToExtractive) {
      counters.extractive += 1;
    }
    if (result.providerRejection) {
      // Quarantined, not a provider failure: the provider answered and refused
      // this pack. Counted separately so a systematic rejection is visible in
      // the run outcome instead of hiding behind an apparently successful run.
      counters.quarantined += 1;
      quarantineReason = quarantineReason ?? result.providerRejection;
    }
    counters.claims += result.episode.claims.length;
    let tokens = 0;
    let modelCall = false;
    if (result.usage) {
      modelCall = true;
      tokens = result.usage.inputTokens + result.usage.outputTokens;
      counters.modelCalls += 1;
      counters.tokensUsed += tokens;
      await repository.recordBrainLlmUsage({
        purpose,
        provider: `${options.provider}/${options.model ?? "default"}`,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimated: result.usage.estimated ?? false
      });
    }
    options.onEpisode?.({ chatName, fellBack: result.fellBackToExtractive, claims: result.episode.claims.length, tokens, modelCall });
  };

  const budgetStopped = () => dailyExceeded || rateLimited || callBudgetExceeded || tokenBudgetExceeded || providerDegraded;
  // One stop gate for both granularities (pre-claim and between packs). Sets
  // the named flag as a side effect so the reason survives to the result.
  const checkBudgets = async (): Promise<boolean> => {
    if (options.mode !== "model") {
      return false;
    }
    // Provider health FIRST: a mid-drain degradation (usage limit, outage,
    // auth) must STOP the drain, never fill coverage with extractive
    // placeholders. The flag latches after the configured consecutive-failure
    // threshold, so at most a pool's worth of packs fall back before this
    // halts new claims — the remaining queue stays pending for a clean resume.
    if (getBrainProviderStatus().degraded) {
      providerDegraded = true;
      // Capture the real reason NOW, at latch time: an in-flight call settling
      // after this can clear provider health before the caller builds its
      // interrupt message.
      providerDegradationReason = brainProviderDegradationReason();
      return true;
    }
    if (options.maxModelCalls != null && counters.modelCalls >= options.maxModelCalls) {
      callBudgetExceeded = true;
      return true;
    }
    if (options.maxTokens != null && options.maxTokens > 0 && counters.tokensUsed >= options.maxTokens) {
      tokenBudgetExceeded = true;
      return true;
    }
    const now = Date.now();
    const daily = await repository.getBrainLlmUsage({ day: utcDayString(now) });
    if (daily.calls >= dailyCap) {
      dailyExceeded = true;
      return true;
    }
    const hourly = await repository.getBrainLlmUsage({ sinceMs: now - 3600_000 });
    if (hourly.calls >= hourlyCap) {
      rateLimited = true;
      return true;
    }
    return false;
  };
  const shouldStopPacks: TaskExecutionHooks["shouldStopPacks"] = async () =>
    Boolean(options.shouldStop?.()) || budgetStopped() || checkBudgets();

  while (true) {
    if (fatalError || options.shouldStop?.() || (await checkBudgets())) {
      break;
    }
    if (claimed >= options.maxTasks) {
      break;
    }
    const [task] = await repository.claimDueBrainTasks(1, Date.now(), options.onlyKind);
    if (!task) {
      if (inFlight.size === 0) {
        break;
      }
      // Nothing claimable right now (queue empty or all remaining tasks are in
      // retry backoff) — wait for ANY in-flight task, then look again.
      await Promise.race(inFlight);
      continue;
    }
    if (task.kind !== "episode" && task.kind !== "regenerate") {
      // The spine only executes episode work; other kinds belong to sibling
      // changes (rollups, graph, projection). Retire them loudly, never loop.
      await repository.failBrainTask(task.id, `Task kind "${task.kind}" is not supported by the brain spine executor.`);
      continue;
    }
    claimed += 1;
    const laneKey = task.chatSourceId ?? `task:${task.id}`;
    const lane = chatLanes.get(laneKey) ?? Promise.resolve();
    const execution = lane.then(async () => {
      try {
        try {
          const result = await executeEpisodeTask(repository, task, options, { record, shouldStopPacks });
          if (result.episodes > 0) {
            counters.chatsProduced += 1;
          }
          if (result.stopped) {
            // A budget or cancel stopped this chat mid-window: committed packs
            // already advanced the watermark; the task stays claimed and is
            // returned to pending by the caller's post-drain reclaim, resuming
            // exactly from the watermark.
            return;
          }
          await repository.completeBrainTask(task.id);
          counters.tasksDone += 1;
          options.onTaskDone?.();
        } catch (error) {
          const attempts = task.attempts + 1;
          const retryInMs = attempts < TASK_MAX_ATTEMPTS ? Math.min(TASK_MAX_BACKOFF_MS, TASK_BACKOFF_BASE_MS * 2 ** task.attempts) : null;
          await repository.failBrainTask(task.id, publicErrorMessage(error), { retryInMs });
        }
      } catch (error) {
        fatalError = fatalError ?? error;
      }
    });
    const tracked: Promise<void> = execution.finally(() => {
      inFlight.delete(tracked);
      if (chatLanes.get(laneKey) === tracked) {
        chatLanes.delete(laneKey);
      }
    });
    chatLanes.set(laneKey, tracked);
    inFlight.add(tracked);
    if (inFlight.size >= workers) {
      // The sliding refill: block only until ANY task settles, then claim the
      // next immediately — never a barrier over the whole pool.
      await Promise.race(inFlight);
    }
  }
  // A stop lets in-flight work finish its current pack-bounded stride; the
  // overshoot is bounded by the pool width.
  await Promise.all(inFlight);
  if (fatalError) {
    throw fatalError;
  }
  return {
    ...counters,
    quarantineReason,
    dailyExceeded,
    rateLimited,
    callBudgetExceeded,
    tokenBudgetExceeded,
    providerDegraded,
    providerDegradationReason
  };
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
  // Held outside the try so a throw after the run starts can finalize the run
  // row (rather than leaving it 'running' until a restart heals it).
  let runId: string | null = null;
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
      const daily = await repository.getBrainLlmUsage({ day: utcDayString(now) });
      if (daily.calls >= config.brain.maxCallsPerDay) {
        return { ran: false, reason: "daily-budget" };
      }
      const hourly = await repository.getBrainLlmUsage({ sinceMs: now - 3600_000 });
      if (hourly.calls >= config.brain.maxCallsPerHour) {
        return { ran: false, reason: "hourly-rate-limit" };
      }
    }
    runId = await repository.startBrainRun("nightly");
    const result = await drainBrainTasks(repository, {
      maxTasks: MAX_TASKS_PER_PASS,
      mode,
      model: mode === "model" ? provider.model : null,
      provider: mode === "model" ? provider.provider : "extractive",
      runId
    });
    const totals: Record<string, number> = {
      episodes: result.episodes,
      extractive: result.extractive,
      claims: result.claims,
      chats: result.chatsProduced,
      chatsVisited: result.tasksDone,
      modelCalls: result.modelCalls,
      quarantined: result.quarantined,
      skippedForBudget: result.dailyExceeded ? (await repository.getBrainTaskSummary()).pending : 0
    };
    if (result.quarantined > 0) {
      console.warn(
        `[brain] maintenance pass: ${result.quarantined.toLocaleString()} pack(s) quarantined — provider refused them deterministically. First reason: ${result.quarantineReason ?? "unknown"}`
      );
    }
    if (result.providerDegraded) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        `Provider ${provider.provider} went unavailable mid-pass (${result.providerDegradationReason || "usage limit, outage, or auth"}); ${result.episodes} episode(s) committed, remaining work stays pending until the provider recovers.`,
        totals
      );
    } else if (result.dailyExceeded) {
      await repository.failBrainRun(
        runId,
        "budget_exceeded",
        `Daily model-call budget (${config.brain.maxCallsPerDay}) reached; ${result.episodes} episode(s) committed, remaining work stays pending.`,
        totals
      );
    } else {
      await repository.completeBrainRun(runId, totals);
    }
    console.log(
      `[brain] auto pass (${mode}${mode === "model" ? `/${provider.model ?? "default"}` : ""}): ${result.episodes} episode(s, ${result.extractive} extractive), ${result.claims} claim(s), ${result.modelCalls} model call(s), ${result.chatsProduced}/${result.tasksDone} chat(s) produced` +
        (result.providerDegraded
          ? " — PROVIDER DEGRADED, stopped to avoid placeholders, remaining work pending"
          : result.dailyExceeded
            ? " — DAILY BUDGET REACHED, remaining work pending"
            : result.rateLimited
              ? " — hourly rate limit, paused until budget frees"
              : "")
    );
    if (result.episodes > 0) {
      options.onEpisodesCommitted?.();
    }
    return { ran: true, ...result };
  } catch (error) {
    // A throw after the run started (e.g. a DB error inside the drain) must not
    // strand the run 'running' until a restart — mark it failed now.
    if (runId) {
      await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    }
    throw error;
  } finally {
    await repository.releaseBrainLock(lockId);
  }
}
