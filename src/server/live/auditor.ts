import type { ArchiveRepository } from "../db/repository";
import type { ChatSyncStateRecord, LiveChatCheckpointRecord, LiveGapWindowRecord } from "../../shared/types";
import type { LiveMaintainerOptions } from "./types";

// Messages carry second-precision timestamps; treat near-equal watermarks as equal.
export const GAP_TOLERANCE_MS = 5_000;

export interface GapAuditInput {
  trigger: "late_start" | "disconnect" | "manual";
  nowMs?: number;
}

export interface GapAuditResult {
  checkpoints: LiveChatCheckpointRecord[];
  gapsOpened: number;
  legacyGapsClosed: number;
}

// Evidence-based audit: a gap opens only when the platform reports conversation
// activity newer than the chat's archived watermark. Quiet chats produce no
// mismatch and therefore no gap, regardless of how long the app was offline.
export async function auditChatGaps(
  repository: ArchiveRepository,
  input: GapAuditInput,
  options: Pick<LiveMaintainerOptions, "maxGapRetries" | "maxBackfillPerChatDays">
): Promise<GapAuditResult> {
  const legacyGapsClosed = await closeLegacyWallClockGaps(repository);
  const existingGaps = await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);
  const openByChat = new Set(existingGaps.map((gap) => gap.chatSourceId));
  const states = await repository.listChatSyncStates();
  const checkpoints: LiveChatCheckpointRecord[] = [];
  let gapsOpened = 0;
  for (const state of states) {
    const mismatch = hasWatermarkMismatch(state);
    const openForChat = openByChat.has(state.chatSourceId);
    const checkpoint: LiveChatCheckpointRecord = {
      chatSourceId: state.chatSourceId,
      latestArchivedMessageKey: state.latestArchivedMessageId,
      latestArchivedAtMs: state.latestArchivedAtMs,
      earliestArchivedMessageKey: state.earliestArchivedMessageId,
      earliestArchivedAtMs: state.earliestArchivedAtMs,
      latestLiveMessageKey: null,
      latestLiveAtMs: null,
      oldestVerifiedMessageKey: state.earliestArchivedMessageId,
      oldestVerifiedAtMs: state.earliestArchivedAtMs,
      health: mismatch || openForChat ? "catching_up" : "healthy",
      retryCount: 0,
      lastAuditAt: new Date(input.nowMs ?? Date.now()).toISOString()
    };
    await repository.upsertLiveCheckpoint(checkpoint);
    checkpoints.push(checkpoint);
    if (mismatch && !openForChat) {
      const fallbackFloorMs = (state.platformRecencyMs ?? 0) - options.maxBackfillPerChatDays * 86_400_000;
      const gap: LiveGapWindowRecord = {
        chatSourceId: state.chatSourceId,
        reason: "watermark_mismatch",
        status: "open",
        startAtMs: state.latestArchivedAtMs ?? fallbackFloorMs,
        endAtMs: state.platformRecencyMs,
        requiredLowerBoundAtMs: state.latestArchivedAtMs ?? fallbackFloorMs,
        anchorMessageKey: null,
        requestCount: 0,
        confidence: "high",
        notes: `Platform activity is newer than the archive watermark (trigger: ${input.trigger}; retry limit ${options.maxGapRetries}).`
      };
      await repository.upsertLiveGap(gap);
      gapsOpened += 1;
    }
  }
  return { checkpoints, gapsOpened, legacyGapsClosed };
}

function hasWatermarkMismatch(state: ChatSyncStateRecord): boolean {
  if (state.platformRecencyMs == null) {
    // No platform evidence is not proof of completeness, but it is also not
    // evidence of missing data; do not open a gap.
    return false;
  }
  if (state.latestArchivedAtMs == null) {
    return true;
  }
  return state.platformRecencyMs > state.latestArchivedAtMs + GAP_TOLERANCE_MS;
}

// Pre-rewrite audits opened a gap per chat using the wall clock as the required
// lower bound (required == start, reason disconnect/late_start). Close them once;
// real mismatches reopen through the evidence-based audit above. Exported so
// server boot can clean stale noise even when no live session can connect.
export async function closeLegacyWallClockGaps(repository: ArchiveRepository): Promise<number> {
  const gaps = await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);
  let closed = 0;
  for (const gap of gaps) {
    const isLegacy =
      (gap.reason === "disconnect" || gap.reason === "late_start") &&
      gap.requiredLowerBoundAtMs != null &&
      gap.requiredLowerBoundAtMs === gap.startAtMs;
    if (isLegacy && gap.id != null) {
      await repository.updateLiveGapStatus(gap.id, "closed", "Superseded by evidence-based audit.");
      closed += 1;
    }
  }
  return closed;
}

export function auditMessageEventCheckpoint(
  current: LiveChatCheckpointRecord | undefined,
  chatSourceId: string,
  latestMessageKey: string | null,
  latestAtMs: number | null,
  oldestMessageKey: string | null,
  oldestAtMs: number | null
): LiveChatCheckpointRecord {
  const latestLiveAtMs = maxNullable(current?.latestLiveAtMs, latestAtMs);
  const oldestVerifiedAtMs = minNullable(current?.oldestVerifiedAtMs, oldestAtMs);
  return {
    chatSourceId,
    latestArchivedMessageKey: latestMessageKey ?? current?.latestArchivedMessageKey ?? null,
    latestArchivedAtMs: maxNullable(current?.latestArchivedAtMs, latestAtMs),
    earliestArchivedMessageKey: oldestMessageKey ?? current?.earliestArchivedMessageKey ?? null,
    earliestArchivedAtMs: minNullable(current?.earliestArchivedAtMs, oldestAtMs),
    latestLiveMessageKey: latestMessageKey ?? current?.latestLiveMessageKey ?? null,
    latestLiveAtMs,
    oldestVerifiedMessageKey: oldestMessageKey ?? current?.oldestVerifiedMessageKey ?? null,
    oldestVerifiedAtMs,
    health: "healthy",
    retryCount: current?.retryCount ?? 0,
    nextRecoveryAt: current?.nextRecoveryAt ?? null,
    lastAuditAt: new Date().toISOString()
  };
}

function maxNullable(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return Math.max(left, right);
}

function minNullable(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return Math.min(left, right);
}
