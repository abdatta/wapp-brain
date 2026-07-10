// Manual brain run as a background job: drain per-chat backlog into cited
// episodes with the user's chosen generator/model, chunked and yielding so
// live sync and HTTP stay responsive. One run at a time; progress is served
// from memory; lifecycle mirrors to the server console; budgets are hard
// named stops, never silent.

import type { BrainRunProgress } from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { publicErrorMessage } from "../privacy";
import { buildEvidencePacks, generateEpisodeForPack } from "./episodes";
import { getBrainProviderStatus } from "./provider";

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
  claimsCommitted: 0,
  modelCalls: 0,
  startedAt: null,
  finishedAt: null,
  error: null
};

export function getBrainRunProgress(): BrainRunProgress {
  return { ...progress };
}

export interface BrainRunRequest {
  mode: "model" | "extractive";
  model?: string | null;
  // Limit the run to one chat (the "try one chat first" path) or cap the
  // number of chats drained this run.
  chatSourceId?: string | null;
  maxChats?: number;
  maxModelCalls?: number;
}

export function startBrainRun(
  repository: ArchiveRepository,
  request: BrainRunRequest,
  onDone?: (result: { ok: boolean }) => void
): { started: boolean; progress: BrainRunProgress; refusal?: string } {
  if (progress.state === "running") {
    return { started: false, progress: getBrainRunProgress(), refusal: "A brain run is already in progress." };
  }
  const provider = getBrainProviderStatus();
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
  progress.runId = null;
  progress.mode = request.mode;
  progress.provider = request.mode === "model" ? provider.provider : "extractive";
  progress.model = request.mode === "model" ? request.model?.trim() || provider.model : null;
  progress.processedChats = 0;
  progress.totalChats = 0;
  progress.currentChat = null;
  progress.episodesCommitted = 0;
  progress.claimsCommitted = 0;
  progress.modelCalls = 0;
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  void executeRun(repository, request)
    .then((outcome) => {
      progress.state = outcome;
      progress.finishedAt = new Date().toISOString();
      console.log(
        `[brain] run ${outcome}: ${progress.episodesCommitted} episodes (${progress.claimsCommitted} claims) across ${progress.processedChats} chats, ${progress.modelCalls} model calls`
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

async function executeRun(repository: ArchiveRepository, request: BrainRunRequest): Promise<"completed" | "budget_exceeded"> {
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
    for (const item of backlog) {
      progress.currentChat = item.chatDisplayName ?? item.chatSourceId;
      const packs = await buildEvidencePacks(repository, {
        chatSourceId: item.chatSourceId,
        startAtMs: item.assimilatedThroughMs + 1,
        endAtMs: Date.now()
      });
      for (const pack of packs) {
        if (progress.mode === "model") {
          const usedToday = await repository.getBrainLlmUsage({ sinceMs: utcMidnightMs() });
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
        progress.claimsCommitted += result.episode.claims.length;
        if (result.usage) {
          progress.modelCalls += 1;
          await repository.recordBrainLlmUsage({
            purpose: "episode",
            provider: `${progress.provider}/${progress.model ?? "default"}`,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens
          });
        }
        // Yield between packs so ingestion and HTTP stay responsive.
        await new Promise((resolve) => setImmediate(resolve));
      }
      progress.processedChats += 1;
      if (budgetExhausted) {
        break;
      }
    }
    const totals = {
      episodes: progress.episodesCommitted,
      claims: progress.claimsCommitted,
      chats: progress.processedChats,
      modelCalls: progress.modelCalls
    };
    if (budgetExhausted) {
      await repository.failBrainRun(runId, "budget_exceeded", "Model-call budget for this run was reached; remaining backlog stays pending.");
      return "budget_exceeded";
    }
    await repository.completeBrainRun(runId, totals);
    return "completed";
  } catch (error) {
    await repository.failBrainRun(runId, "failed", publicErrorMessage(error)).catch(() => undefined);
    throw error;
  }
}

function utcMidnightMs(): number {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.getTime();
}
