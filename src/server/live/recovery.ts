import type { ArchiveRepository } from "../db/repository";
import type { LiveGapWindowRecord } from "../../shared/types";
import { gapWithinLimits, type LiveHistoryRequest, type LiveMaintainerOptions, type LiveWhatsAppClient } from "./types";

export interface RecoverySummary {
  attempted: number;
  closed: number;
  uncertain: number;
  needsUserAction: number;
}

export async function recoverDueGaps(
  repository: ArchiveRepository,
  client: LiveWhatsAppClient,
  options: LiveMaintainerOptions
): Promise<RecoverySummary> {
  const summary: RecoverySummary = { attempted: 0, closed: 0, uncertain: 0, needsUserAction: 0 };
  if (!client.fetchHistory) {
    const gaps = await repository.listLiveGaps(["open", "retrying"]);
    for (const gap of gaps) {
      await markUncertain(repository, gap, "Selected client does not expose on-demand history recovery.");
      summary.uncertain += 1;
    }
    return summary;
  }

  const now = Date.now();
  const gaps = (await repository.listLiveGaps(["open", "retrying"]))
    .filter((gap) => !gap.lastAttemptAt || Date.parse(gap.lastAttemptAt) + options.minBackfillDelayMs <= now)
    .slice(0, Math.max(1, options.maxConcurrentChatBackfills));

  for (const gap of gaps) {
    summary.attempted += 1;
    if (!gapWithinLimits(gap, options)) {
      await repository.updateLiveGapStatus(gap.id!, "needs_user_action", "Configured recovery limit reached before continuity could be proven.");
      summary.needsUserAction += 1;
      continue;
    }

    const request: LiveHistoryRequest = {
      chatSourceId: gap.chatSourceId,
      anchorMessageKey: gap.anchorMessageKey,
      oldestMsgTimestampMs: gap.startAtMs,
      count: options.maxBackfillPerChatMessages
    };
    const result = await client.fetchHistory(request);
    const updatedGap: LiveGapWindowRecord = {
      ...gap,
      status: "retrying",
      requestCount: gap.requestCount + 1,
      lastAttemptAt: new Date().toISOString()
    };
    await repository.upsertLiveGap(updatedGap);

    if (result.events.length) {
      for (const event of result.events) {
        if (event.contacts?.length) await repository.upsertContacts("live-recovery", event.contacts);
        if (event.chats?.length) await repository.upsertChats("live-recovery", event.chats);
        if (event.participants?.length) await repository.upsertParticipants(event.participants);
        if (event.messages?.length) await repository.upsertMessages(event.messages);
      }
      await repository.refreshChatStats();
    }

    const lowerBound = gap.requiredLowerBoundAtMs ?? gap.startAtMs;
    const closed = result.status === "closed" || (lowerBound != null && result.oldestReturnedAtMs != null && result.oldestReturnedAtMs <= lowerBound);
    if (closed) {
      await repository.updateLiveGapStatus(gap.id!, "closed", "Recovered history covered the required lower bound.");
      summary.closed += 1;
    } else if (result.status === "unsupported" || result.status === "empty") {
      await markUncertain(repository, updatedGap, result.errorMessage ?? "History request did not prove continuity.");
      summary.uncertain += 1;
    }
  }
  return summary;
}

async function markUncertain(repository: ArchiveRepository, gap: LiveGapWindowRecord, notes: string): Promise<void> {
  if (gap.id) {
    await repository.updateLiveGapStatus(gap.id, "uncertain", notes);
  }
}
