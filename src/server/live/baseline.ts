import type { ArchiveRepository } from "../db/repository";
import type { LiveBaselineSummary, StatusSummary } from "../../shared/types";

export async function getLiveBaselineSummary(repository: ArchiveRepository, maxBackfillDays: number): Promise<LiveBaselineSummary> {
  const status = await repository.getStatus();
  const latestChat = (await repository.listChats({ limit: 1, offset: 0, includeEventOnly: true }))[0] ?? null;
  return baselineFromStatus(status, latestChat?.lastMessageAt ?? null, maxBackfillDays);
}

export function baselineFromStatus(status: StatusSummary, latestMessageAt: string | null, maxBackfillDays: number): LiveBaselineSummary {
  const latestImportAt = status.latestImport?.finishedAt ?? status.latestImport?.startedAt ?? null;
  if (!status.database.initialized || !status.latestImport) {
    return {
      ready: false,
      messageCount: status.counts.messages,
      latestImportAt,
      latestMessageAt,
      maxBackfillDays,
      status: "missing_archive",
      warning: "Import a WhatsApp backup before linking live sync."
    };
  }
  if (status.counts.messages <= 0 || !latestMessageAt) {
    return {
      ready: false,
      messageCount: status.counts.messages,
      latestImportAt,
      latestMessageAt,
      maxBackfillDays,
      status: "missing_messages",
      warning: "The archive has no imported messages. Live sync needs an existing backup baseline."
    };
  }
  const latestMs = Date.parse(latestMessageAt);
  const maxAgeMs = maxBackfillDays * 86_400_000;
  if (Number.isFinite(latestMs) && Date.now() - latestMs > maxAgeMs) {
    return {
      ready: false,
      messageCount: status.counts.messages,
      latestImportAt,
      latestMessageAt,
      maxBackfillDays,
      status: "too_old",
      warning: `The latest archived message is older than ${maxBackfillDays} days. Import a fresher backup before live sync so recovery stays reliable.`
    };
  }
  return {
    ready: true,
    messageCount: status.counts.messages,
    latestImportAt,
    latestMessageAt,
    maxBackfillDays,
    status: "ready",
    warning: null
  };
}

// Linking requires an archive to exist so recovery has something to anchor to,
// but a stale archive never blocks it: long downtime becomes honest gaps and
// grouped uncertainty instead of a forced re-import.
export async function assertLiveBaselineExists(repository: ArchiveRepository, maxBackfillDays: number): Promise<void> {
  const baseline = await getLiveBaselineSummary(repository, maxBackfillDays);
  if (baseline.status === "missing_archive" || baseline.status === "missing_messages") {
    throw new Error(baseline.warning ?? "Live sync requires an imported WhatsApp archive baseline.");
  }
}
