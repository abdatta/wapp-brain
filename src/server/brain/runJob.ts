// Manual brain run as a background job: drain per-chat backlog into cited
// episodes with the user's chosen generator/model, chunked and yielding so
// live sync and HTTP stay responsive. One run at a time; progress is served
// from memory; lifecycle mirrors to the server console; budgets are hard
// named stops, never silent.

import type {
  BrainBackfillStatus,
  BrainChatBacklogItem,
  BrainLifecycleSweepProgress,
  BrainReasoningEffort,
  BrainRollupProgress,
  BrainRunProgress
} from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { PublicError, publicErrorMessage } from "../privacy";
import { buildEvidencePacks, EXTRACTION_VERSION, generateEpisodeForPack } from "./episodes";
import { buildLifecycleSweepPrompt, parseLifecycleSweepResponse, type LifecycleSweepResolution } from "./lifecycle";
import { brainProviderDegradationReason, generateStructured, getBrainProviderStatus } from "./provider";
import {
  buildRollupPrompt,
  parseRollupResponse,
  ROLLUP_CALL_TIMEOUT_MS,
  ROLLUP_PROMPT_VERSION,
  rollupInputTokenBudget,
  selectRollupClaims
} from "./rollups";
import { projectBrainDocs, projectBrainOverview } from "./projection";
import { auditCatchup, drainBrainTasks } from "./scheduler";

// Backfill fallback canary (historical-backfill H5): the warning fires only
// after this many attempted model episodes in the run, past this rate.
export const BACKFILL_FALLBACK_MIN_ATTEMPTS = 20;
export const BACKFILL_FALLBACK_WARNING_RATE = 0.1;
// ETA needs this many trailing-hour episodes before it stops lying.
const BACKFILL_ETA_MIN_EPISODES = 10;
// Fallback pack size when no episode has been committed yet to observe one —
// well under the 150-message cap because week-span splitting yields smaller
// packs on average (the real archive settles near ~60).
const DEFAULT_AVG_PACK_MESSAGES = 60;
// Backfill worker pool (H7): sliding, parallel across chats only.
const BACKFILL_DEFAULT_CONCURRENCY = 5;
const BACKFILL_MAX_CONCURRENCY = 6;
const BACKFILL_LOCK_TTL_MS = 30 * 60_000;

const progress: BrainRunProgress = {
  state: "idle",
  runId: null,
  kind: null,
  queuedTasks: null,
  estimatedEpisodes: null,
  mode: "extractive",
  provider: null,
  model: null,
  processedChats: 0,
  totalChats: 0,
  currentChat: null,
  tokensUsed: 0,
  episodesCommitted: 0,
  extractiveEpisodes: 0,
  claimsCommitted: 0,
  modelCalls: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  lifecycle: null,
  rollup: null
};

// Cooperative cancellation: the run loop checks this between chats. A cancel
// leaves committed episodes and advanced watermarks in place (coverage stays
// honest); only the remaining backlog is skipped.
let cancelRequested = false;

export function getBrainRunProgress(): BrainRunProgress {
  return { ...progress };
}

// Request cancellation of the in-progress run. Returns false when nothing is
// running to cancel.
export function requestBrainRunCancel(): boolean {
  if (progress.state !== "running") {
    return false;
  }
  cancelRequested = true;
  return true;
}

export interface BrainRunRequest {
  mode: "model" | "extractive";
  model?: string | null;
  // Limit the run to one chat (the "try one chat first" path) or cap the
  // number of chats drained this run.
  chatSourceId?: string | null;
  maxChats?: number;
  maxModelCalls?: number;
  // Regeneration run (contract v2): instead of draining the forward backlog,
  // select current episodes that are extractive-generated or carry a stale
  // extraction version, enqueue durable 'regenerate' tasks, and drain those.
  // Model mode only — regenerating a model episode extractively would downgrade it.
  regenerate?: boolean;
  // Regeneration scope: only extractive episodes — the backfill dashboard's
  // "sweep the fallbacks" action (skips stale-but-model episodes).
  regenerateOnlyExtractive?: boolean;
  // Historical backfill (historical-backfill H1): produce the full uncovered
  // work-list through the idempotent catch-up audit, then drain it as episode
  // tasks under this run's pacing. Resume = start another backfill run.
  backfill?: boolean;
  // Per-run token budget (assimilation runs): once accumulated input+output
  // tokens reach this, no further model call is made and the run ends as a
  // NAMED budget_exceeded — the token sibling of maxModelCalls.
  maxTokens?: number | null;
  // Backfill turbo pacing overrides (H2): replace the configured ledger caps
  // for THIS run only. Clamped 1–1000/hour and 1–10000/day.
  callsPerHour?: number | null;
  callsPerDay?: number | null;
  // Strict backfill (H5): twice-failed packs commit nothing and fail their
  // task; coverage stalls honestly instead of degrading silently.
  strict?: boolean;
  // Backfill worker pool width (H7): sliding, clamped 1–6, default 5.
  concurrency?: number | null;
}

export function startBrainRun(
  repository: ArchiveRepository,
  request: BrainRunRequest,
  onDone?: (result: { ok: boolean }) => void,
  beforeAssimilation?: () => Promise<void>
): { started: boolean; progress: BrainRunProgress; refusal?: string } {
  if (progress.state === "running") {
    return { started: false, progress: getBrainRunProgress(), refusal: "A brain run is already in progress." };
  }
  const provider = getBrainProviderStatus();
  if (request.regenerate && request.mode !== "model") {
    return {
      started: false,
      progress: getBrainRunProgress(),
      refusal: "Regeneration needs a model: replacing a model episode with an extractive placeholder would downgrade it."
    };
  }
  if (request.backfill && request.regenerate) {
    return {
      started: false,
      progress: getBrainRunProgress(),
      refusal: "Backfill and regeneration are separate runs — start one at a time."
    };
  }
  if (request.backfill && request.chatSourceId) {
    return {
      started: false,
      progress: getBrainRunProgress(),
      refusal: "Backfill covers the whole uncovered archive (newest chat first). Cap it with maxChats, or use a manual run for a single chat."
    };
  }
  if (request.strict && !request.backfill) {
    return { started: false, progress: getBrainRunProgress(), refusal: "Strict mode applies to backfill runs only." };
  }
  if (request.strict && request.mode !== "model") {
    return {
      started: false,
      progress: getBrainRunProgress(),
      refusal: "Strict mode needs a model — extractive generation has no model failures to refuse."
    };
  }
  if (request.mode === "model") {
    if (!provider.modelBacked || !provider.enabled || provider.sessionMissing) {
      return { started: false, progress: getBrainRunProgress(), refusal: provider.message };
    }
    if (provider.degraded) {
      return {
        started: false,
        progress: getBrainRunProgress(),
        refusal: `${provider.message} Probe the provider (or pick extractive) before running.`
      };
    }
  }
  progress.state = "running";
  cancelRequested = false;
  progress.runId = null;
  progress.kind = request.backfill ? "backfill" : request.regenerate ? "regenerate" : "manual";
  progress.queuedTasks = null;
  progress.estimatedEpisodes = null;
  progress.mode = request.mode;
  progress.provider = request.mode === "model" ? provider.provider : "extractive";
  progress.model = request.mode === "model" ? request.model?.trim() || provider.model : null;
  progress.processedChats = 0;
  progress.totalChats = 0;
  progress.currentChat = null;
  progress.tokensUsed = 0;
  progress.episodesCommitted = 0;
  progress.extractiveEpisodes = 0;
  progress.claimsCommitted = 0;
  progress.modelCalls = 0;
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  progress.lifecycle = null;
  progress.rollup = null;
  void executeRun(repository, request, beforeAssimilation)
    .then(async (outcome) => {
      // Graph maintenance after every terminal run that committed episodes:
      // idempotent signal sync (so a post-reset graph regains its membership/
      // vCard/number-change edges without waiting for a manual rebuild), then
      // the salience recompute. Pure SQL, no model calls, and a failure here
      // never masks the run's own outcome (it logs and moves on).
      if (progress.episodesCommitted > 0) {
        try {
          const sync = await repository.syncBrainGraphSignals();
          const recompute = await repository.recomputeBrainGraphSalience();
          console.log(
            `[brain] graph maintained after run: +${sync.participationEdges + sync.vcardMentionEdges} signal edge(s); salience over ${recompute.nodes} node(s), ${recompute.dormant} newly dormant, ${recompute.revived} revived`
          );
        } catch (error) {
          console.warn(`[brain] post-run graph maintenance failed: ${publicErrorMessage(error)}`);
        }
        // Overview refresh (semantic-rollups R11): deterministic, zero model
        // calls — the vault homepage stays fresh after every committing run.
        try {
          await projectBrainOverview(repository);
        } catch (error) {
          console.warn(`[brain] overview projection failed: ${publicErrorMessage(error)}`);
        }
      }
      progress.state = outcome;
      progress.finishedAt = new Date().toISOString();
      console.log(
        `[brain] run ${outcome}: ${progress.episodesCommitted} episodes (${progress.extractiveEpisodes} extractive, ${progress.claimsCommitted} claims) across ${progress.processedChats} chats, ${progress.modelCalls} model calls`
      );
      onDone?.({ ok: outcome === "completed" });
    })
    .catch((error) => {
      progress.state = "failed";
      progress.error = publicErrorMessage(error);
      progress.finishedAt = new Date().toISOString();
      console.error(`[brain] run FAILED: ${progress.error}`);
      onDone?.({ ok: false });
    });
  return { started: true, progress: getBrainRunProgress() };
}

async function executeRun(
  repository: ArchiveRepository,
  request: BrainRunRequest,
  beforeAssimilation?: () => Promise<void>
): Promise<"completed" | "budget_exceeded" | "interrupted"> {
  // Contact enrichment is a correctness boundary: connected Google contacts
  // must be current before a run exists or any evidence backlog is read.
  await beforeAssimilation?.();
  if (request.regenerate) {
    return executeRegenerateRun(repository, request);
  }
  if (request.backfill) {
    return executeBackfillRun(repository, request);
  }
  const runId = await repository.startBrainRun("manual");
  progress.runId = runId;
  const maxModelCalls = Math.max(1, request.maxModelCalls ?? config.brain.maxCallsPerHour);
  console.log(
    `[brain] run started (${progress.mode}${progress.model ? `/${progress.model}` : ""}) — up to ${request.chatSourceId ? "1 chat" : `${request.maxChats ?? 10} chats`}, ${progress.mode === "model" ? `${maxModelCalls} model calls max` : "no model calls"}`
  );
  try {
    const backlog = request.chatSourceId
      ? await repository.getBrainChatBacklog({ limit: 1, chatSourceId: request.chatSourceId })
      : await repository.getBrainChatBacklog({ limit: request.maxChats ?? 10 });
    progress.totalChats = backlog.length;
    progress.estimatedEpisodes = estimateEpisodeCount(backlog, await observedAvgPackMessages(repository));
    let budgetExhausted = false;
    // Which budget stopped the run — the stop is always NAMED, never generic.
    let budgetStopMessage = "Model-call budget for this run was reached; remaining backlog stays pending.";
    let cancelled = false;
    // Provider went unavailable mid-run: stop rather than commit placeholders.
    let providerDegraded = false;
    let providerDegradedReason = "";
    // Chats that actually produced an episode vs. windows merely visited — the
    // honest chat count, so "12 chats for 3 episodes" can't happen.
    let chatsProduced = 0;
    let chatsVisited = 0;
    for (const item of backlog) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      progress.currentChat = item.chatDisplayName ?? item.chatSourceId;
      chatsVisited += 1;
      const packs = await buildEvidencePacks(repository, {
        chatSourceId: item.chatSourceId,
        startAtMs: item.assimilatedThroughMs,
        afterId: item.assimilatedThroughId,
        endAtMs: Date.now()
      });
      let producedThisChat = false;
      for (const pack of packs) {
        if (progress.mode === "model") {
          // Provider health FIRST: a mid-run degradation stops the run instead
          // of committing extractive placeholders over the rest of the backlog.
          if (getBrainProviderStatus().degraded) {
            providerDegraded = true;
            providerDegradedReason = brainProviderDegradationReason();
            break;
          }
          const usedToday = await repository.getBrainLlmUsage({ day: utcDayString() });
          if (progress.modelCalls >= maxModelCalls || usedToday.calls >= config.brain.maxCallsPerDay) {
            budgetExhausted = true;
            break;
          }
          // Token budget: checked BEFORE the next call so the stop is
          // conservative — the budget is a ceiling, not a target.
          if (request.maxTokens != null && request.maxTokens > 0 && progress.tokensUsed >= request.maxTokens) {
            budgetExhausted = true;
            budgetStopMessage = `Token budget for this run (${request.maxTokens.toLocaleString()} tokens) was reached; remaining backlog stays pending.`;
            break;
          }
        }
        const result = await generateEpisodeForPack(repository, pack, {
          generator: progress.mode,
          model: progress.model,
          runId
        });
        progress.episodesCommitted += 1;
        producedThisChat = true;
        if (result.fellBackToExtractive) {
          progress.extractiveEpisodes += 1;
        }
        progress.claimsCommitted += result.episode.claims.length;
        if (result.usage) {
          progress.modelCalls += 1;
          progress.tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
          await repository.recordBrainLlmUsage({
            purpose: "episode",
            provider: `${progress.provider}/${progress.model ?? "default"}`,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            estimated: result.usage.estimated ?? false
          });
        }
        // Yield between packs so ingestion and HTTP stay responsive.
        await new Promise((resolve) => setImmediate(resolve));
      }
      progress.processedChats += 1;
      if (producedThisChat) {
        chatsProduced += 1;
      }
      if (budgetExhausted || providerDegraded) {
        break;
      }
    }
    const totals = {
      episodes: progress.episodesCommitted,
      extractive: progress.extractiveEpisodes,
      claims: progress.claimsCommitted,
      chats: chatsProduced,
      chatsVisited,
      modelCalls: progress.modelCalls,
      tokens: progress.tokensUsed,
      // Chats still holding pending backlog that this run never attempted.
      skippedForBudget: budgetExhausted ? Math.max(0, backlog.length - chatsVisited) : 0
    };
    if (cancelled) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        "Run cancelled; committed episodes and coverage are kept, remaining backlog stays pending.",
        totals
      );
      return "interrupted";
    }
    if (providerDegraded) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        `Provider ${progress.provider}${progress.model ? `/${progress.model}` : ""} became unavailable mid-run (${providerDegradedReason || "usage limit, outage, or auth"}); ${progress.episodesCommitted.toLocaleString()} episode(s) committed, remaining backlog stays pending. Probe/recover the provider (or switch), then run again.`,
        totals
      );
      return "interrupted";
    }
    if (budgetExhausted) {
      await repository.failBrainRun(runId, "budget_exceeded", budgetStopMessage, totals);
      return "budget_exceeded";
    }
    await repository.completeBrainRun(runId, totals);
    return "completed";
  } catch (error) {
    await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    throw error;
  }
}

// Regeneration run (contract v2): select stale/extractive current episodes,
// enqueue durable dedupe-keyed 'regenerate' tasks (resumable — a re-run after
// an interruption is a no-op for already-superseded episodes), then drain only
// that kind under the usual budget machinery.
async function executeRegenerateRun(
  repository: ArchiveRepository,
  request: BrainRunRequest
): Promise<"completed" | "budget_exceeded" | "interrupted"> {
  const runId = await repository.startBrainRun("regenerate");
  progress.runId = runId;
  try {
    const stale = await repository.listRegenerableBrainEpisodes({
      currentVersion: EXTRACTION_VERSION,
      chatSourceId: request.chatSourceId ?? null,
      onlyExtractive: request.regenerateOnlyExtractive ?? false,
      limit: 10_000
    });
    await repository.enqueueBrainTasks(
      stale.map((episode) => ({
        kind: "regenerate" as const,
        chatSourceId: episode.chatSourceId,
        payload: { episodeId: episode.id, chatSourceId: episode.chatSourceId },
        dedupeKey: `regen:${episode.id}:v${EXTRACTION_VERSION}`,
        priority: 500
      }))
    );
    progress.totalChats = stale.length;
    progress.queuedTasks = (await repository.getBrainTaskSummary()).pending;
    // Regeneration replaces exactly one episode per selected episode — the
    // denominator is known, not estimated.
    progress.estimatedEpisodes = stale.length;
    // Turbo, like backfill: a bulk re-derivation (the fallback sweep can be
    // thousands of episodes) runs the sliding pool, and an unset hourly override
    // means NO hourly ceiling — the daily cap, the queue, and provider health
    // bound it. The provider-degradation guard turns a mid-run usage-limit hit
    // into a clean resumable stop.
    const concurrency = clampInt(request.concurrency ?? BACKFILL_DEFAULT_CONCURRENCY, 1, BACKFILL_MAX_CONCURRENCY);
    const callsPerHour = request.callsPerHour != null ? clampInt(request.callsPerHour, 1, 1000) : null;
    const callsPerDay = request.callsPerDay != null ? clampInt(request.callsPerDay, 1, 10_000) : null;
    console.log(
      `[brain] regenerate run started (${progress.model ?? "default"}) — ${stale.length} episode(s), ${concurrency} worker(s)` +
        (callsPerHour != null ? `, ${callsPerHour} calls/hour` : "") +
        (callsPerDay != null ? `, ${callsPerDay} calls/day` : "")
    );
    const result = await drainBrainTasks(repository, {
      maxTasks: Math.max(1, request.maxChats ?? stale.length),
      mode: "model",
      model: progress.model,
      provider: progress.provider ?? "model",
      runId,
      onlyKind: "regenerate",
      callsPerHour: callsPerHour ?? Number.POSITIVE_INFINITY,
      callsPerDay,
      concurrency,
      onTaskDone: () => {
        progress.processedChats += 1;
        void repository
          .getBrainTaskSummary()
          .then((summary) => {
            progress.queuedTasks = summary.pending;
          })
          .catch(() => undefined);
      },
      // Live progress so the bar/chips move during a long sweep, not just at end.
      onEpisode: (event) => {
        progress.episodesCommitted += 1;
        if (event.fellBack) {
          progress.extractiveEpisodes += 1;
        }
        progress.claimsCommitted += event.claims;
        if (event.modelCall) {
          progress.modelCalls += 1;
          progress.tokensUsed += event.tokens;
        }
        progress.currentChat = event.chatName;
      },
      shouldStop: () => cancelRequested
    });
    progress.episodesCommitted = result.episodes;
    progress.extractiveEpisodes = result.extractive;
    progress.claimsCommitted = result.claims;
    progress.modelCalls = result.modelCalls;
    progress.tokensUsed = result.tokensUsed;
    const totals = {
      episodes: result.episodes,
      extractive: result.extractive,
      claims: result.claims,
      chats: result.chatsProduced,
      chatsVisited: result.tasksDone,
      modelCalls: result.modelCalls,
      tokens: result.tokensUsed,
      skippedForBudget: result.dailyExceeded || result.rateLimited ? Math.max(0, stale.length - result.tasksDone) : 0
    };
    if (cancelRequested) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        "Regeneration cancelled; superseded episodes and committed replacements are kept, remaining tasks stay pending.",
        totals
      );
      return "interrupted";
    }
    if (result.providerDegraded) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        `Provider ${progress.provider}${progress.model ? `/${progress.model}` : ""} became unavailable mid-regeneration (${result.providerDegradationReason || "usage limit, outage, or auth"}); ${result.episodes.toLocaleString()} replacement(s) committed, remaining regenerate tasks stay pending. Probe/recover the provider (or switch), then re-run the sweep.`,
        totals
      );
      return "interrupted";
    }
    if (result.dailyExceeded || result.rateLimited) {
      await repository.failBrainRun(
        runId,
        "budget_exceeded",
        "Model-call budget was reached mid-regeneration; remaining regenerate tasks stay pending.",
        totals
      );
      return "budget_exceeded";
    }
    await repository.completeBrainRun(runId, totals);
    return "completed";
  } catch (error) {
    await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    throw error;
  }
}

// Historical backfill run (historical-backfill H1/H2/H7): the catch-up audit
// IS the producer (idempotent, watermark-keyed — a re-run enqueues only
// genuinely new windows), and the queue drain does the work through the
// sliding worker pool. Runs under the cross-process brain lock so the auto
// pass can never spend the budget concurrently; a killed run's claimed tasks
// are reclaimed at the next start (kill-resume needs no new machinery).
async function executeBackfillRun(
  repository: ArchiveRepository,
  request: BrainRunRequest
): Promise<"completed" | "budget_exceeded" | "interrupted"> {
  // The lock is keyed by the RUN id: boot-time run reconciliation can then
  // prove the holder dead and release it, so a killed turbo never blocks its
  // own resume behind the TTL.
  let runId: string | null = null;
  let lockHeld = false;
  try {
    runId = await repository.startBrainRun("backfill");
    progress.runId = runId;
    if (!(await repository.tryAcquireBrainLock(runId, BACKFILL_LOCK_TTL_MS))) {
      throw new PublicError("BRAIN_LOCKED", "Another brain pass holds the maintenance lock; try again in a moment.");
    }
    lockHeld = true;
    // Under the lock every 'running' task is an orphan from a killed run —
    // return them to pending so this run continues them immediately.
    const reclaimed = await repository.resetInFlightBrainTasks(0);
    const audit = await auditCatchup(repository);
    const queuedAtStart = (await repository.getBrainTaskSummary()).pending;
    progress.queuedTasks = queuedAtStart;
    progress.totalChats = Math.min(queuedAtStart, request.maxChats ?? queuedAtStart);
    // Precompute the episode total from the SCOPE this run will actually drain
    // (the newest maxChats chats), so the progress bar's denominator matches
    // the work, not the whole archive.
    const scopeForEstimate = request.maxChats != null ? audit.backlog.slice(0, request.maxChats) : audit.backlog;
    progress.estimatedEpisodes = estimateEpisodeCount(scopeForEstimate, await observedAvgPackMessages(repository));
    // Hourly pace: absent means NO hourly ceiling for a backfill. The config
    // default (30/hour) is the auto scheduler's spread-across-the-day pace and
    // would pointlessly stop a turbo drain within minutes — so an unset field
    // lets the pool run at full speed, bounded by the daily ceiling, the queue,
    // and the worker count. An explicit override still sets a named hourly stop
    // (only ever used to throttle slower, so the 1000 clamp is ample).
    const callsPerHour = request.callsPerHour != null ? clampInt(request.callsPerHour, 1, 1000) : null;
    const callsPerDay = request.callsPerDay != null ? clampInt(request.callsPerDay, 1, 10_000) : null;
    const concurrency =
      progress.mode === "model" ? clampInt(request.concurrency ?? BACKFILL_DEFAULT_CONCURRENCY, 1, BACKFILL_MAX_CONCURRENCY) : 1;
    const strict = Boolean(request.strict) && progress.mode === "model";
    const maxTokens = progress.mode === "model" && request.maxTokens != null && request.maxTokens > 0 ? request.maxTokens : null;
    const maxModelCalls = progress.mode === "model" && request.maxModelCalls != null ? Math.max(1, request.maxModelCalls) : null;
    // The start notice echoes every override — a run's spend posture must be
    // readable off its console line and its stored record alike.
    console.log(
      `[brain] backfill run started (${progress.mode}${progress.model ? `/${progress.model}` : ""}) — ` +
        `${queuedAtStart.toLocaleString()} queued task(s) (${audit.enqueued.toLocaleString()} newly enqueued, ${reclaimed} reclaimed)` +
        (request.maxChats ? `, capped at ${request.maxChats} task(s)` : "") +
        (progress.mode === "model"
          ? `, ${concurrency} worker(s)` +
            (callsPerHour != null ? `, ${callsPerHour} calls/hour override` : "") +
            (callsPerDay != null ? `, ${callsPerDay} calls/day override` : "") +
            (maxModelCalls != null ? `, ≤${maxModelCalls} call(s)` : "") +
            (maxTokens != null ? `, ≤${maxTokens.toLocaleString()} tokens` : "") +
            (strict ? ", STRICT (no extractive placeholders)" : "")
          : ", extractive (zero model calls)")
    );
    let fallbackWarned = false;
    const result = await drainBrainTasks(repository, {
      maxTasks: request.maxChats ?? Number.MAX_SAFE_INTEGER,
      mode: progress.mode,
      model: progress.model,
      provider: progress.provider ?? "extractive",
      runId,
      onlyKind: "episode",
      // Unset hourly override → no hourly ceiling (Infinity), not the config
      // pace; the daily cap, the queue, and the pool bound the run instead.
      callsPerHour: callsPerHour ?? Number.POSITIVE_INFINITY,
      callsPerDay,
      maxModelCalls,
      maxTokens,
      strict,
      concurrency,
      onTaskDone: () => {
        progress.processedChats += 1;
        // Queue-depth refresh (H8), cheap and never allowed to stall the drain.
        void repository
          .getBrainTaskSummary()
          .then((summary) => {
            progress.queuedTasks = summary.pending;
          })
          .catch(() => undefined);
      },
      onEpisode: (event) => {
        // Lock heartbeat per committed pack (~one model call apart): a single
        // long chat task must never let the TTL lapse mid-run.
        void repository.tryAcquireBrainLock(runId!, BACKFILL_LOCK_TTL_MS).catch(() => undefined);
        progress.episodesCommitted += 1;
        if (event.fellBack) {
          progress.extractiveEpisodes += 1;
        }
        progress.claimsCommitted += event.claims;
        if (event.modelCall) {
          progress.modelCalls += 1;
          progress.tokensUsed += event.tokens;
        }
        progress.currentChat = event.chatName;
        // Mid-run canary (H5): fallback-rate spikes are alert-worthy states,
        // not footnotes — warn LOUDLY the moment the threshold is crossed.
        if (!fallbackWarned && progress.mode === "model" && progress.episodesCommitted >= BACKFILL_FALLBACK_MIN_ATTEMPTS) {
          const rate = progress.extractiveEpisodes / progress.episodesCommitted;
          if (rate > BACKFILL_FALLBACK_WARNING_RATE) {
            fallbackWarned = true;
            console.warn(
              `[brain] BACKFILL FALLBACK WARNING: ${progress.extractiveEpisodes}/${progress.episodesCommitted} episode(s) ` +
                `(${Math.round(rate * 100)}%) fell back to extractive placeholders — check provider health and the model before ` +
                `continuing; the dashboard sweep can regenerate them later.`
            );
          }
        }
      },
      shouldStop: () => cancelRequested
    });
    // Reclaim budget/cancel-stopped mid-chat claims BEFORE snapshotting the
    // queue for the run record, so queuedRemaining is the queue the next run
    // actually sees (the finally-reclaim stays as the crash-path safety net).
    await repository.resetInFlightBrainTasks(0).catch(() => undefined);
    progress.queuedTasks = (await repository.getBrainTaskSummary()).pending;
    const totals: Record<string, number> = {
      episodes: result.episodes,
      extractive: result.extractive,
      claims: result.claims,
      chats: result.chatsProduced,
      chatsVisited: result.tasksDone,
      modelCalls: result.modelCalls,
      tokens: result.tokensUsed,
      queuedAtStart,
      queuedRemaining: progress.queuedTasks,
      concurrency,
      ...(callsPerHour != null ? { callsPerHourOverride: callsPerHour } : {}),
      ...(callsPerDay != null ? { callsPerDayOverride: callsPerDay } : {}),
      ...(strict ? { strict: 1 } : {})
    };
    if (cancelRequested) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        "Backfill cancelled; committed episodes and coverage are kept, the remaining queue stays pending.",
        totals
      );
      return "interrupted";
    }
    // Provider went unavailable mid-run (usage limit, outage, auth): STOP
    // rather than fill coverage with extractive placeholders. Named, resumable.
    if (result.providerDegraded) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        `Provider ${progress.provider}${progress.model ? `/${progress.model}` : ""} became unavailable mid-run (${result.providerDegradationReason || "usage limit, outage, or auth"}). The run stopped to avoid filling coverage with extractive placeholders — ${result.episodes.toLocaleString()} episode(s) committed, ${progress.queuedTasks?.toLocaleString() ?? "the remaining"} task(s) still pending. Probe/recover the provider (or switch providers in the Run console), then resume the backfill.`,
        totals
      );
      return "interrupted";
    }
    // Every budget stop is NAMED after the budget that fired (H2).
    const budgetStop = result.tokenBudgetExceeded
      ? `Token budget for this run (${(maxTokens ?? 0).toLocaleString()} tokens) was reached; the remaining backfill queue stays pending.`
      : result.callBudgetExceeded
        ? `Model-call ceiling for this run (${maxModelCalls ?? 0} call(s)) was reached; the remaining backfill queue stays pending.`
        : result.dailyExceeded
          ? `Daily model-call budget (${callsPerDay ?? config.brain.maxCallsPerDay}) was reached; the remaining backfill queue stays pending.`
          : result.rateLimited
            ? `Hourly pace (${callsPerHour ?? config.brain.maxCallsPerHour} calls/hour) was reached; the remaining backfill queue stays pending.`
            : null;
    if (budgetStop) {
      await repository.failBrainRun(runId, "budget_exceeded", budgetStop, totals);
      return "budget_exceeded";
    }
    await repository.completeBrainRun(runId, totals);
    return "completed";
  } catch (error) {
    if (runId) {
      await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    }
    throw error;
  } finally {
    // Return any budget/cancel-stopped mid-chat claims to pending — but only
    // when this run actually held the lock (a lock refusal must never yank
    // another pass's claimed tasks).
    if (lockHeld) {
      await repository.resetInFlightBrainTasks(0).catch(() => undefined);
      await repository.releaseBrainLock(runId!);
    }
  }
}

// --- Lifecycle closure sweep (commitment-lifecycle) -------------------------
// The standalone executor of the single resolutions contract: per-chat batches
// of sweep-due nodes + deterministic candidate evidence go to the model, the
// validated resolutions apply through the one transactional writer, and there
// is NO fallback — a twice-failed call leaves its nodes open with visible
// validation issues (there is no honest extractive closure). semantic-rollups
// embeds the same contract inside its rollup calls later.

export interface BrainLifecycleSweepRequest {
  chatSourceId?: string | null;
  // Explicit item selection: sweep exactly these lifecycle claims (a specific
  // item or a chosen subset), overriding the whole-scope sweep-due set.
  claimIds?: string[] | null;
  model?: string | null;
  // Rollup-class judgment always runs at HIGH reasoning effort (fixed for
  // every provider — the claude CLI has no effort knob, and high is the right
  // pick for closure judgment on GPT too). Kept overridable for the CLI/API.
  effort?: BrainReasoningEffort | null;
  maxModelCalls?: number | null;
  maxTokens?: number | null;
}

export function startBrainLifecycleSweep(
  repository: ArchiveRepository,
  request: BrainLifecycleSweepRequest,
  onDone?: (result: { ok: boolean }) => void
): { started: boolean; progress: BrainRunProgress; refusal?: string } {
  if (progress.state === "running") {
    return { started: false, progress: getBrainRunProgress(), refusal: "A brain run is already in progress." };
  }
  const provider = getBrainProviderStatus();
  if (!provider.modelBacked || !provider.enabled || provider.sessionMissing) {
    return { started: false, progress: getBrainRunProgress(), refusal: provider.message };
  }
  if (provider.degraded) {
    return {
      started: false,
      progress: getBrainRunProgress(),
      refusal: `${provider.message} Probe the provider before sweeping.`
    };
  }
  progress.state = "running";
  cancelRequested = false;
  progress.runId = null;
  progress.kind = "lifecycle";
  progress.queuedTasks = null;
  progress.estimatedEpisodes = null;
  progress.mode = "model";
  progress.provider = provider.provider;
  progress.model = request.model?.trim() || provider.model;
  progress.processedChats = 0;
  progress.totalChats = 0;
  progress.currentChat = null;
  progress.tokensUsed = 0;
  progress.episodesCommitted = 0;
  progress.extractiveEpisodes = 0;
  progress.claimsCommitted = 0;
  progress.modelCalls = 0;
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  progress.lifecycle = { nodesOffered: 0, fulfilled: 0, dismissed: 0, stillOpen: 0, failedCalls: 0 };
  progress.rollup = null;
  void executeLifecycleSweep(repository, request)
    .then((outcome) => {
      progress.state = outcome;
      progress.finishedAt = new Date().toISOString();
      const counters = progress.lifecycle!;
      console.log(
        `[brain] lifecycle sweep ${outcome}: ${counters.nodesOffered} node(s) offered — ${counters.fulfilled} fulfilled, ` +
          `${counters.dismissed} dismissed, ${counters.stillOpen} still open, ${counters.failedCalls} failed call(s), ` +
          `${progress.modelCalls} model call(s)`
      );
      onDone?.({ ok: outcome === "completed" });
    })
    .catch((error) => {
      progress.state = "failed";
      progress.error = publicErrorMessage(error);
      progress.finishedAt = new Date().toISOString();
      console.error(`[brain] lifecycle sweep FAILED: ${progress.error}`);
      onDone?.({ ok: false });
    });
  return { started: true, progress: getBrainRunProgress() };
}

async function executeLifecycleSweep(
  repository: ArchiveRepository,
  request: BrainLifecycleSweepRequest
): Promise<"completed" | "budget_exceeded" | "interrupted"> {
  const runId = await repository.startBrainRun("lifecycle");
  progress.runId = runId;
  const counters: BrainLifecycleSweepProgress = progress.lifecycle!;
  try {
    const batches = await repository.listBrainLifecycleSweepBatches({
      chatSourceId: request.chatSourceId ?? null,
      claimIds: request.claimIds ?? undefined
    });
    const chats = new Set(batches.map((batch) => batch.chatSourceId));
    progress.totalChats = chats.size;
    const effort = request.effort ?? "high";
    const scope = request.claimIds && request.claimIds.length > 0 ? `${request.claimIds.length} selected item(s)` : "sweep-due node(s)";
    console.log(
      `[brain] lifecycle sweep started (${progress.provider}/${progress.model ?? "default"}, effort ${effort}) — ` +
        `${batches.reduce((sum, batch) => sum + batch.nodes.length, 0)} ${scope} across ${chats.size} chat(s), ${batches.length} call(s) planned` +
        (request.maxModelCalls != null ? `, ≤${request.maxModelCalls} call(s)` : "") +
        (request.maxTokens != null ? `, ≤${request.maxTokens.toLocaleString()} tokens` : "")
    );
    let budgetStop: string | null = null;
    let cancelled = false;
    let providerDegraded = false;
    let providerDegradedReason = "";
    const processedChats = new Set<string>();
    for (const batch of batches) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      if (getBrainProviderStatus().degraded) {
        providerDegraded = true;
        providerDegradedReason = brainProviderDegradationReason();
        break;
      }
      const usedToday = await repository.getBrainLlmUsage({ day: utcDayString() });
      if (usedToday.calls >= config.brain.maxCallsPerDay) {
        budgetStop = `Daily model-call budget (${config.brain.maxCallsPerDay}) was reached; remaining sweep-due nodes stay open and sweepable.`;
        break;
      }
      if (request.maxModelCalls != null && progress.modelCalls >= request.maxModelCalls) {
        budgetStop = `Model-call ceiling for this sweep (${request.maxModelCalls} call(s)) was reached; remaining sweep-due nodes stay open and sweepable.`;
        break;
      }
      if (request.maxTokens != null && request.maxTokens > 0 && progress.tokensUsed >= request.maxTokens) {
        budgetStop = `Token budget for this sweep (${request.maxTokens.toLocaleString()} tokens) was reached; remaining sweep-due nodes stay open and sweepable.`;
        break;
      }
      progress.currentChat = batch.chatDisplayName ?? batch.chatSourceId;
      const prompt = buildLifecycleSweepPrompt(batch, Date.now());
      let resolutions: LifecycleSweepResolution[] | null = null;
      let stillOpenClaimIds: string[] = [];
      let lastErrors: string[] = [];
      for (let attempt = 0; attempt < 2 && resolutions == null; attempt += 1) {
        const user =
          attempt === 0
            ? prompt.user
            : `${prompt.user}\n\nYour previous response had these problems — fix ALL of them and respond again with the complete JSON:\n${lastErrors.map((error) => `- ${error}`).join("\n")}`;
        const result = await generateStructured({
          system: prompt.system,
          user,
          maxOutputTokens: prompt.maxOutputTokens,
          model: progress.model,
          effort
        });
        progress.modelCalls += 1;
        progress.tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
        await repository.recordBrainLlmUsage({
          purpose: "lifecycle",
          provider: `${progress.provider}/${progress.model ?? "default"}`,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          estimated: result.usage.estimated ?? false
        });
        const parsed = parseLifecycleSweepResponse(result.json, prompt);
        if (parsed.errors.length === 0) {
          resolutions = parsed.resolutions;
          stillOpenClaimIds = parsed.missingAliases.map((alias) => prompt.nodeByAlias.get(alias)!.claimId);
        } else {
          lastErrors = parsed.errors;
        }
      }
      counters.nodesOffered += batch.nodes.length;
      if (resolutions == null) {
        // No fallback by design: an invented closure would be worse than an
        // open item. The nodes stay open AND sweep-due; the failure is loud.
        counters.failedCalls += 1;
        await repository.recordBrainValidationIssues([
          {
            runId,
            chatSourceId: batch.chatSourceId,
            code: "lifecycle_sweep_invalid",
            severity: "error",
            detail: `Closure sweep response failed validation twice; ${batch.nodes.length} node(s) left open. Errors: ${lastErrors.join("; ")}`
          }
        ]);
        console.warn(`[brain] lifecycle sweep: response failed validation twice for one chat batch (${batch.nodes.length} node(s) left open)`);
      } else {
        const transitions = [
          ...resolutions.map((resolution) => ({
            claimId: resolution.claimId,
            toStatus: resolution.toStatus,
            cites: resolution.cites.map((cite) => cite.sourceMessageKey),
            note: resolution.note
          })),
          // Offered-but-unresolved nodes get a still_open review stamp, so
          // `stale` can honestly mean "reviewed and still open".
          ...stillOpenClaimIds.map((claimId) => ({ claimId, toStatus: "still_open" as const, cites: [], note: null }))
        ];
        const allowedCitesByClaim = new Map(batch.nodes.map((node) => [node.claimId, node.candidates]));
        try {
          await repository.applyBrainLifecycleTransitions(transitions, {
            source: "model",
            runId,
            model: progress.model,
            allowedCitesByClaim
          });
          for (const resolution of resolutions) {
            if (resolution.toStatus === "fulfilled") counters.fulfilled += 1;
            else if (resolution.toStatus === "dismissed") counters.dismissed += 1;
            else counters.stillOpen += 1;
          }
          counters.stillOpen += stillOpenClaimIds.length;
        } catch (error) {
          // The writer's independent re-check refused (defense in depth):
          // record and move on — nodes stay open.
          counters.failedCalls += 1;
          await repository.recordBrainValidationIssues([
            {
              runId,
              chatSourceId: batch.chatSourceId,
              code: "lifecycle_apply_refused",
              severity: "error",
              detail: publicErrorMessage(error)
            }
          ]);
          console.warn(`[brain] lifecycle sweep: transition writer refused a batch: ${publicErrorMessage(error)}`);
        }
      }
      if (!processedChats.has(batch.chatSourceId)) {
        processedChats.add(batch.chatSourceId);
        progress.processedChats = processedChats.size;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const totals = {
      chats: processedChats.size,
      chatsVisited: processedChats.size,
      modelCalls: progress.modelCalls,
      tokens: progress.tokensUsed,
      nodesOffered: counters.nodesOffered,
      fulfilled: counters.fulfilled,
      dismissed: counters.dismissed,
      stillOpen: counters.stillOpen,
      failedCalls: counters.failedCalls
    };
    if (cancelled) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        "Sweep cancelled; applied transitions are kept, remaining sweep-due nodes stay open.",
        totals
      );
      return "interrupted";
    }
    if (providerDegraded) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        `Provider ${progress.provider}${progress.model ? `/${progress.model}` : ""} became unavailable mid-sweep${providerDegradedReason ? ` (${providerDegradedReason})` : ""}; applied transitions are kept, remaining sweep-due nodes stay open. Probe/recover the provider, then sweep again.`,
        totals
      );
      return "interrupted";
    }
    if (budgetStop) {
      await repository.failBrainRun(runId, "budget_exceeded", budgetStop, totals);
      return "budget_exceeded";
    }
    await repository.completeBrainRun(runId, totals);
    return "completed";
  } catch (error) {
    await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    throw error;
  }
}

// --- Semantic rollup run (semantic-rollups) ---------------------------------
// One strong-tier HIGH-effort call per due doc: assemble input (feed-more,
// overflow quotas), consolidate to structured statements, validate with
// mechanical salvage + collect-all + one retry, commit through the exact-guard
// transactional writer (lifecycle resolutions embedded), project the file.
// NO fallback: a twice-failed call leaves the prior revision current with a
// rejected revision + visible issue — an extractive page would be laundered
// authority at the semantic tier.

export interface BrainRollupRunRequest {
  // Scope: one doc/node, an explicit doc list, or the top-K due docs.
  docId?: string | null;
  nodeId?: string | null;
  docIds?: string[] | null;
  maxDocs?: number | null;
  model?: string | null;
  // Rollup-class judgment runs at HIGH reasoning effort by default (the same
  // stance as the closure sweep). Overridable per call for the CLI/API.
  effort?: BrainReasoningEffort | null;
  maxModelCalls?: number | null;
  maxTokens?: number | null;
}

export function startBrainRollupRun(
  repository: ArchiveRepository,
  request: BrainRollupRunRequest,
  onDone?: (result: { ok: boolean }) => void
): { started: boolean; progress: BrainRunProgress; refusal?: string } {
  if (progress.state === "running") {
    return { started: false, progress: getBrainRunProgress(), refusal: "A brain run is already in progress." };
  }
  const provider = getBrainProviderStatus();
  if (!provider.modelBacked || !provider.enabled || provider.sessionMissing) {
    return { started: false, progress: getBrainRunProgress(), refusal: provider.message };
  }
  if (provider.degraded) {
    return {
      started: false,
      progress: getBrainRunProgress(),
      refusal: `${provider.message} Probe the provider before rolling up.`
    };
  }
  progress.state = "running";
  cancelRequested = false;
  progress.runId = null;
  progress.kind = "rollup";
  progress.queuedTasks = null;
  progress.estimatedEpisodes = null;
  progress.mode = "model";
  progress.provider = provider.provider;
  progress.model = request.model?.trim() || provider.model;
  progress.processedChats = 0;
  progress.totalChats = 0;
  progress.currentChat = null;
  progress.tokensUsed = 0;
  progress.episodesCommitted = 0;
  progress.extractiveEpisodes = 0;
  progress.claimsCommitted = 0;
  progress.modelCalls = 0;
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  progress.lifecycle = null;
  progress.rollup = { docsPlanned: 0, docsCommitted: 0, docsRejected: 0, resolutionsApplied: 0, contradictionsFlagged: 0, currentDoc: null };
  void executeRollupRun(repository, request)
    .then((outcome) => {
      progress.state = outcome;
      progress.finishedAt = new Date().toISOString();
      const counters = progress.rollup!;
      console.log(
        `[brain] rollup run ${outcome}: ${counters.docsCommitted}/${counters.docsPlanned} doc(s) committed, ` +
          `${counters.docsRejected} rejected, ${counters.resolutionsApplied} resolution(s) applied, ` +
          `${counters.contradictionsFlagged} contradiction flag(s), ${progress.modelCalls} model call(s)`
      );
      onDone?.({ ok: outcome === "completed" });
    })
    .catch((error) => {
      progress.state = "failed";
      progress.error = publicErrorMessage(error);
      progress.finishedAt = new Date().toISOString();
      console.error(`[brain] rollup run FAILED: ${progress.error}`);
      onDone?.({ ok: false });
    });
  return { started: true, progress: getBrainRunProgress() };
}

async function executeRollupRun(
  repository: ArchiveRepository,
  request: BrainRollupRunRequest
): Promise<"completed" | "budget_exceeded" | "interrupted"> {
  const runId = await repository.startBrainRun("rollup");
  progress.runId = runId;
  const counters: BrainRollupProgress = progress.rollup!;
  try {
    // Resolve the target doc list: explicit target(s), or the due set ranked
    // by salience — an unscoped rollup run is STRUCTURALLY bounded by top-K.
    let targets: Array<{ docId?: string | null; nodeId?: string | null }> = [];
    if (request.docId || request.nodeId) {
      targets = [{ docId: request.docId ?? null, nodeId: request.nodeId ?? null }];
    } else if (request.docIds && request.docIds.length > 0) {
      targets = request.docIds.map((docId) => ({ docId }));
    } else {
      const maxDocs = Math.max(1, Math.min(request.maxDocs ?? 10, request.maxModelCalls ?? Number.MAX_SAFE_INTEGER));
      const due = await repository.listBrainDocs({ view: "due", limit: maxDocs });
      targets = due.items.filter((item) => item.status !== "merged").map((item) => ({ nodeId: item.nodeId }));
    }
    counters.docsPlanned = targets.length;
    const effort = request.effort ?? "high";
    console.log(
      `[brain] rollup run started (${progress.provider}/${progress.model ?? "default"}, effort ${effort}) — ${targets.length} doc(s) planned` +
        (request.maxModelCalls != null ? `, ≤${request.maxModelCalls} call(s)` : "") +
        (request.maxTokens != null ? `, ≤${request.maxTokens.toLocaleString()} tokens` : "")
    );
    let budgetStop: string | null = null;
    let cancelled = false;
    let providerDegraded = false;
    let providerDegradedReason = "";
    for (const target of targets) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      // Provider health FIRST (the degradation guard): stop cleanly rather
      // than burn retries against a dead provider.
      if (getBrainProviderStatus().degraded) {
        providerDegraded = true;
        providerDegradedReason = brainProviderDegradationReason();
        break;
      }
      const usedToday = await repository.getBrainLlmUsage({ day: utcDayString() });
      if (usedToday.calls >= config.brain.maxCallsPerDay) {
        budgetStop = `Daily model-call budget (${config.brain.maxCallsPerDay}) was reached; remaining due docs stay due.`;
        break;
      }
      if (request.maxModelCalls != null && progress.modelCalls >= request.maxModelCalls) {
        budgetStop = `Model-call ceiling for this run (${request.maxModelCalls} call(s)) was reached; remaining due docs stay due.`;
        break;
      }
      if (request.maxTokens != null && request.maxTokens > 0 && progress.tokensUsed >= request.maxTokens) {
        budgetStop = `Token budget for this run (${request.maxTokens.toLocaleString()} tokens) was reached; remaining due docs stay due.`;
        break;
      }
      const input = await repository.getBrainRollupInput(target);
      if (!input) {
        console.warn(`[brain] rollup: target ${target.docId ?? target.nodeId} resolved to no page-eligible node; skipped`);
        continue;
      }
      counters.currentDoc = input.title;
      progress.currentChat = input.title;
      if (input.claims.length === 0) {
        console.warn(`[brain] rollup: ${input.docId} has no eligible claims; skipped`);
        continue;
      }
      const selection = selectRollupClaims(input.claims, input.conflictPairs, input.prior?.referencedClaimIds ?? [], rollupInputTokenBudget());
      const inputStats = {
        claimCount: selection.stats.claimCount,
        tokenEstimate: selection.stats.tokenEstimate,
        overflow: selection.stats.overflow,
        tiersEngaged: selection.stats.tiersEngaged
      };
      const prompt = buildRollupPrompt(input, selection.fed, Date.now());
      const fedClaimIds = selection.fed.map((claim) => claim.claimId);
      let committedThisDoc = false;
      let lastErrors: string[] = [];
      for (let attempt = 0; attempt < 2 && !committedThisDoc; attempt += 1) {
        const user =
          attempt === 0
            ? prompt.user
            : `${prompt.user}\n\nYour previous response had these problems — fix ALL of them and respond again with the complete JSON:\n${lastErrors.map((error) => `- ${error}`).join("\n")}`;
        const result = await generateStructured({
          system: prompt.system,
          user,
          maxOutputTokens: prompt.maxOutputTokens,
          model: progress.model,
          effort,
          // Dossier-sized synthesis outlives the episode-tuned default.
          timeoutMs: ROLLUP_CALL_TIMEOUT_MS
        });
        progress.modelCalls += 1;
        progress.tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
        await repository.recordBrainLlmUsage({
          purpose: "rollup",
          provider: `${progress.provider}/${progress.model ?? "default"}`,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          estimated: result.usage.estimated ?? false
        });
        const parsed = parseRollupResponse(result.json, prompt);
        if (parsed.errors.length > 0) {
          lastErrors = parsed.errors;
          continue;
        }
        try {
          const commit = await repository.commitBrainDocRevision({
            docId: input.docId,
            kind: input.kind,
            nodeId: input.nodeId,
            slug: input.slug,
            sections: parsed.sections,
            drops: parsed.drops,
            resolutions: parsed.resolutions,
            allowedCitesByClaim: parsed.allowedCitesByClaim,
            fedClaimIds,
            inputStats,
            model: progress.model,
            effort,
            runId,
            promptVersion: ROLLUP_PROMPT_VERSION
          });
          committedThisDoc = true;
          counters.docsCommitted += 1;
          counters.resolutionsApplied += commit.record.resolutionEventIds.length;
          counters.contradictionsFlagged += commit.contradictions.length;
          // Project the committed page immediately (deterministic, cheap);
          // a failure here never masks the commit.
          try {
            await projectBrainDocs(repository, { docIds: [input.docId] });
          } catch (error) {
            console.warn(`[brain] rollup projection failed for ${input.docId}: ${publicErrorMessage(error)}`);
          }
        } catch (error) {
          // Guard/validation refusal from the committer counts against the
          // same single retry as parse errors (one contract, one retry).
          lastErrors = [publicErrorMessage(error)];
        }
      }
      if (!committedThisDoc) {
        counters.docsRejected += 1;
        await repository.rejectBrainDocRevision({
          docId: input.docId,
          kind: input.kind,
          nodeId: input.nodeId,
          slug: input.slug,
          errors: lastErrors,
          fedClaimIds,
          inputStats,
          model: progress.model,
          effort,
          runId,
          promptVersion: ROLLUP_PROMPT_VERSION
        });
        console.warn(`[brain] rollup: ${input.docId} refused after retry — prior revision stays current. Errors: ${lastErrors.join("; ")}`);
      }
      progress.processedChats += 1;
      // Yield between docs so ingestion and HTTP stay responsive.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Overview refresh at run end: deterministic, zero model calls.
    try {
      await projectBrainOverview(repository);
    } catch (error) {
      console.warn(`[brain] overview projection failed: ${publicErrorMessage(error)}`);
    }
    const totals = {
      docsPlanned: counters.docsPlanned,
      docsCommitted: counters.docsCommitted,
      docsRejected: counters.docsRejected,
      resolutionsApplied: counters.resolutionsApplied,
      contradictionsFlagged: counters.contradictionsFlagged,
      modelCalls: progress.modelCalls,
      tokens: progress.tokensUsed
    };
    if (cancelled) {
      await repository.failBrainRun(runId, "interrupted", "Rollup run cancelled; committed revisions are kept, remaining due docs stay due.", totals);
      return "interrupted";
    }
    if (providerDegraded) {
      await repository.failBrainRun(
        runId,
        "interrupted",
        `Provider ${progress.provider}${progress.model ? `/${progress.model}` : ""} became unavailable mid-run${providerDegradedReason ? ` (${providerDegradedReason})` : ""}; committed revisions are kept, remaining due docs stay due. Probe/recover the provider, then run again.`,
        totals
      );
      return "interrupted";
    }
    if (budgetStop) {
      await repository.failBrainRun(runId, "budget_exceeded", budgetStop, totals);
      return "budget_exceeded";
    }
    await repository.completeBrainRun(runId, totals);
    return "completed";
  } catch (error) {
    await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    throw error;
  }
}

// Server-computed backfill dashboard (H4): repository rollups + the live run
// progress folded into one DTO. Meaning lives here — UI/CLI/MCP render it.
export async function getBrainBackfillStatus(repository: ArchiveRepository): Promise<BrainBackfillStatus> {
  const stats = await repository.getBrainBackfillStats();
  const current = getBrainRunProgress();
  const running = current.state === "running" ? current : null;
  const pendingMessages = Math.max(0, stats.totalVisibleMessages - stats.assimilatedVisibleMessages);
  const coveragePercent =
    stats.totalVisibleMessages > 0
      ? Math.round(((stats.totalVisibleMessages - pendingMessages) / stats.totalVisibleMessages) * 1000) / 10
      : 100;
  const drainRatePerHour = stats.episodesLastHour > 0 ? stats.episodesLastHour : null;
  const remainingPacks =
    stats.avgEpisodeMessages != null && stats.avgEpisodeMessages > 0 ? Math.ceil(pendingMessages / stats.avgEpisodeMessages) : null;
  const etaHours =
    drainRatePerHour != null && stats.episodesLastHour >= BACKFILL_ETA_MIN_EPISODES && remainingPacks != null
      ? Math.round((remainingPacks / drainRatePerHour) * 10) / 10
      : null;
  const currentRunAttempted = running && running.mode === "model" ? running.episodesCommitted : 0;
  const currentRunExtractive = running && running.mode === "model" ? running.extractiveEpisodes : 0;
  const currentRunWarning =
    currentRunAttempted >= BACKFILL_FALLBACK_MIN_ATTEMPTS &&
    currentRunExtractive / currentRunAttempted > BACKFILL_FALLBACK_WARNING_RATE;
  const overallWarning =
    stats.modelAttemptedEpisodes >= BACKFILL_FALLBACK_MIN_ATTEMPTS &&
    stats.fallbackEpisodes / stats.modelAttemptedEpisodes > BACKFILL_FALLBACK_WARNING_RATE;
  return {
    coveragePercent,
    totalVisibleMessages: stats.totalVisibleMessages,
    assimilatedVisibleMessages: stats.assimilatedVisibleMessages,
    pendingMessages,
    pendingChats: stats.pendingChats,
    queuedTasks: stats.queuedEpisodeTasks,
    failedTasks: stats.failedEpisodeTasks,
    running,
    drainRatePerHour,
    etaHours,
    avgEpisodeMessages: stats.avgEpisodeMessages,
    spendByModel: stats.spendByModel,
    fallback: {
      totalEpisodes: stats.modelAttemptedEpisodes,
      extractiveEpisodes: stats.fallbackEpisodes,
      ratePercent:
        stats.modelAttemptedEpisodes > 0 ? Math.round((stats.fallbackEpisodes / stats.modelAttemptedEpisodes) * 1000) / 10 : 0,
      currentRunAttempted,
      currentRunExtractive,
      currentRunWarning,
      warning: currentRunWarning || overallWarning
    },
    sweepableExtractive: stats.sweepableExtractive
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// Precompute the run's episode total for the progress bar: each in-scope chat
// yields at least one episode, more when its pending message count exceeds the
// observed pack size. Aggregate over many chats, the observed average absorbs
// week-span splitting, so this is a good ≈ denominator even though any single
// chat's split is uneven.
function estimateEpisodeCount(items: BrainChatBacklogItem[], avgPackMessages: number): number {
  const avg = avgPackMessages > 0 ? avgPackMessages : DEFAULT_AVG_PACK_MESSAGES;
  return items.reduce((sum, item) => sum + Math.max(1, Math.ceil(item.pendingVisibleMessages / avg)), 0);
}

async function observedAvgPackMessages(repository: ArchiveRepository): Promise<number> {
  const stats = await repository.getBrainBackfillStats();
  return stats.avgEpisodeMessages && stats.avgEpisodeMessages > 0 ? stats.avgEpisodeMessages : DEFAULT_AVG_PACK_MESSAGES;
}

// UTC date (YYYY-MM-DD) matching the ledger's `day` column, so the per-run
// daily budget check hits the (day, purpose) index.
function utcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}
