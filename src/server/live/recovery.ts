import type { ArchiveRepository } from "../db/repository";
import { liveMessageKey } from "./normalize";
import { inferChatType } from "../import/jid";
import type { LiveHistoryRequest, LiveMaintainerOptions, LiveWhatsAppClient } from "./types";

export interface RecoverySummary {
  attempted: number;
  closed: number;
  uncertain: number;
  needsUserAction: number;
  pendingUpdatesRetried: number;
}

// Recovery requests bounded backward history from the earliest archived message
// newer than each gap's floor. It never closes a gap from the request result:
// closure happens when covering evidence is actually ingested (see LiveMaintainer).
export async function recoverDueGaps(
  repository: ArchiveRepository,
  client: LiveWhatsAppClient,
  options: LiveMaintainerOptions
): Promise<RecoverySummary> {
  const summary: RecoverySummary = { attempted: 0, closed: 0, uncertain: 0, needsUserAction: 0, pendingUpdatesRetried: 0 };
  summary.pendingUpdatesRetried = await retryPendingUpdates(repository);

  if (!client.fetchHistory) {
    const gaps = await repository.listLiveGaps(["open", "retrying"]);
    for (const gap of gaps) {
      if (gap.id != null) {
        await repository.updateLiveGapStatus(gap.id, "uncertain", "Selected client does not expose on-demand history recovery.");
        summary.uncertain += 1;
      }
    }
    return summary;
  }

  const now = Date.now();
  const gaps = (await repository.listLiveGaps(["open", "retrying"]))
    .filter((gap) => !gap.lastAttemptAt || Date.parse(gap.lastAttemptAt) + options.minBackfillDelayMs <= now)
    .slice(0, Math.max(1, options.maxConcurrentChatBackfills));

  for (const gap of gaps) {
    if (gap.id == null) {
      continue;
    }
    summary.attempted += 1;

    const windowDays = gap.startAtMs != null && gap.endAtMs != null ? Math.abs(gap.endAtMs - gap.startAtMs) / 86_400_000 : 0;
    if (windowDays > options.maxBackfillPerChatDays) {
      await repository.updateLiveGapStatus(
        gap.id,
        "uncertain",
        `Window exceeds the ${options.maxBackfillPerChatDays}-day platform recovery horizon; completeness cannot be proven automatically.`
      );
      summary.uncertain += 1;
      continue;
    }

    const anchor = await repository.getRecoveryAnchor(gap.chatSourceId, gap.startAtMs);
    if (!anchor) {
      await repository.updateLiveGapStatus(gap.id, "uncertain", "No archived message newer than the gap floor exists to anchor history recovery.");
      summary.uncertain += 1;
      continue;
    }
    const anchorKey = liveMessageKey({
      chatSourceId: gap.chatSourceId,
      sourceMessageId: anchor.sourceMessageId,
      participant:
        inferChatType(gap.chatSourceId) === "group" && !anchor.fromMe && anchor.senderSourceJid !== gap.chatSourceId
          ? anchor.senderSourceJid
          : null,
      fromMe: anchor.fromMe
    });

    if (gap.requestCount >= options.maxGapRetries) {
      const stalled = gap.anchorMessageKey === anchorKey;
      await repository.updateLiveGapStatus(
        gap.id,
        stalled ? "uncertain" : "needs_user_action",
        stalled
          ? "Retries exhausted without any new history evidence; the platform may not hold this window."
          : "Retries exhausted before continuity was proven; retry recovery or import a fresher backup."
      );
      if (stalled) {
        summary.uncertain += 1;
      } else {
        summary.needsUserAction += 1;
      }
      continue;
    }

    const request: LiveHistoryRequest = {
      chatSourceId: gap.chatSourceId,
      anchorMessageKey: anchorKey,
      oldestMsgTimestampMs: anchor.timestampMs,
      count: options.maxBackfillPerChatMessages
    };
    const result = await client.fetchHistory(request);
    await repository.upsertLiveGap({
      ...gap,
      status: "retrying",
      requestCount: gap.requestCount + 1,
      anchorMessageKey: anchorKey,
      lastAttemptAt: new Date().toISOString()
    });

    // Some clients return history synchronously; ingest it so the evidence counts.
    if (result.events.length) {
      const chatSourceIds = new Set<string>();
      for (const event of result.events) {
        if (event.contacts?.length) await repository.upsertContacts("live-recovery", event.contacts);
        if (event.chats?.length) await repository.upsertChats("live-recovery", event.chats);
        if (event.participants?.length) await repository.upsertParticipants(event.participants);
        if (event.messages?.length) {
          await repository.upsertMessages(event.messages);
          for (const message of event.messages) {
            chatSourceIds.add(message.chatSourceId);
          }
        }
      }
      await repository.refreshChatStats([...chatSourceIds]);
      const minIngestedAtMs = result.events
        .flatMap((event) => event.messages ?? [])
        .filter((message) => message.chatSourceId === gap.chatSourceId)
        .reduce<number | null>((min, message) => (message.timestampMs == null ? min : Math.min(min ?? Infinity, message.timestampMs)), null);
      const bound = gap.requiredLowerBoundAtMs ?? gap.startAtMs;
      if (bound == null || (minIngestedAtMs != null && minIngestedAtMs <= bound + 5_000)) {
        await repository.updateLiveGapStatus(gap.id, "closed", "Recovered history covered the required lower bound.");
        summary.closed += 1;
        continue;
      }
    }

    if (result.status === "unsupported") {
      await repository.updateLiveGapStatus(gap.id, "uncertain", result.errorMessage ?? "History request did not prove continuity.");
      summary.uncertain += 1;
    }
  }
  return summary;
}

async function retryPendingUpdates(repository: ArchiveRepository): Promise<number> {
  const pending = await repository.listPendingLiveMessageUpdates();
  if (!pending.length) {
    return 0;
  }
  const result = await repository.applyLiveMessageUpdates(pending.map(({ applied: _applied, ...update }) => update));
  return result.applied;
}
