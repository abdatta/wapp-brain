// Manual brain run as a background job: drain per-chat backlog into cited
// episodes with the user's chosen generator/model, chunked and yielding so
// live sync and HTTP stay responsive. One run at a time; progress is served
// from memory; lifecycle mirrors to the server console; budgets are hard
// named stops, never silent.

import type { BrainRunProgress } from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { publicErrorMessage } from "../privacy";
import { buildEvidencePacks, EXTRACTION_VERSION, generateEpisodeForPack } from "./episodes";
import { getBrainProviderStatus } from "./provider";
import { drainBrainTasks } from "./scheduler";

const progress: BrainRunProgress = {
  state: "idle",
  runId: null,
  mode: "extractive",
  provider: null,
  model: null,
  processedChats: 0,
  totalChats: 0,
  currentChat: null,
  episodesCommitted: 0,
  extractiveEpisodes: 0,
  claimsCommitted: 0,
  modelCalls: 0,
  startedAt: null,
  finishedAt: null,
  error: null
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
  progress.mode = request.mode;
  progress.provider = request.mode === "model" ? provider.provider : "extractive";
  progress.model = request.mode === "model" ? request.model?.trim() || provider.model : null;
  progress.processedChats = 0;
  progress.totalChats = 0;
  progress.currentChat = null;
  progress.episodesCommitted = 0;
  progress.extractiveEpisodes = 0;
  progress.claimsCommitted = 0;
  progress.modelCalls = 0;
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  void executeRun(repository, request, beforeAssimilation)
    .then((outcome) => {
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
  const runId = await repository.startBrainRun("manual");
  progress.runId = runId;
  const maxModelCalls = Math.max(1, request.maxModelCalls ?? config.brain.maxCallsPerHour);
  console.log(
    `[brain] run started (${progress.mode}${progress.model ? `/${progress.model}` : ""}) — up to ${request.chatSourceId ? "1 chat" : `${request.maxChats ?? 10} chats`}, ${progress.mode === "model" ? `${maxModelCalls} model calls max` : "no model calls"}`
  );
  try {
    const backlog = request.chatSourceId
      ? (await repository.getBrainChatBacklog({ limit: 5000 })).filter((item) => item.chatSourceId === request.chatSourceId)
      : await repository.getBrainChatBacklog({ limit: request.maxChats ?? 10 });
    progress.totalChats = backlog.length;
    let budgetExhausted = false;
    let cancelled = false;
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
          const usedToday = await repository.getBrainLlmUsage({ day: utcDayString() });
          if (progress.modelCalls >= maxModelCalls || usedToday.calls >= config.brain.maxCallsPerDay) {
            budgetExhausted = true;
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
      if (budgetExhausted) {
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
    if (budgetExhausted) {
      await repository.failBrainRun(
        runId,
        "budget_exceeded",
        "Model-call budget for this run was reached; remaining backlog stays pending.",
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
    console.log(`[brain] regenerate run started (${progress.model ?? "default"}) — ${stale.length} stale/extractive episode(s)`);
    const result = await drainBrainTasks(repository, {
      maxTasks: Math.max(1, request.maxChats ?? stale.length),
      mode: "model",
      model: progress.model,
      provider: progress.provider ?? "model",
      runId,
      onlyKind: "regenerate",
      onTaskDone: () => {
        progress.processedChats += 1;
      },
      shouldStop: () => cancelRequested
    });
    progress.episodesCommitted = result.episodes;
    progress.extractiveEpisodes = result.extractive;
    progress.claimsCommitted = result.claims;
    progress.modelCalls = result.modelCalls;
    const totals = {
      episodes: result.episodes,
      extractive: result.extractive,
      claims: result.claims,
      chats: result.chatsProduced,
      chatsVisited: result.tasksDone,
      modelCalls: result.modelCalls,
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

// UTC date (YYYY-MM-DD) matching the ledger's `day` column, so the per-run
// daily budget check hits the (day, purpose) index.
function utcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}
