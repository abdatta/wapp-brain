import type { ArchiveRepository } from "../db/repository";
import type { LiveChatCheckpointRecord, LiveGapWindowRecord } from "../../shared/types";
import type { LiveMaintainerOptions } from "./types";

export interface ArchiveWatermark {
  chatSourceId: string;
  latestArchivedMessageKey: string | null;
  latestArchivedAtMs: number | null;
  earliestArchivedMessageKey: string | null;
  earliestArchivedAtMs: number | null;
}

export interface GapAuditInput {
  watermarks: ArchiveWatermark[];
  requiredLowerBoundAtMs: number | null;
  nowMs?: number;
  reason?: "late_start" | "disconnect" | "watermark_mismatch" | "history_sync_stalled";
}

export async function computeArchiveWatermarks(repository: ArchiveRepository): Promise<ArchiveWatermark[]> {
  const chats = await repository.listChats({ limit: 10000, offset: 0, includeEventOnly: true });
  const watermarks: ArchiveWatermark[] = [];
  for (const chat of chats) {
    const latest = (await repository.listMessages(chat.id, { limit: 1, offset: 0, order: "desc" }))[0] ?? null;
    const earliest = (await repository.listMessages(chat.id, { limit: 1, offset: 0, order: "asc" }))[0] ?? null;
    watermarks.push({
      chatSourceId: chat.sourceChatId,
      latestArchivedMessageKey: latest?.sourceMessageId ?? null,
      latestArchivedAtMs: latest?.timestampMs ?? null,
      earliestArchivedMessageKey: earliest?.sourceMessageId ?? null,
      earliestArchivedAtMs: earliest?.timestampMs ?? null
    });
  }
  return watermarks;
}

export async function auditChatGaps(
  repository: ArchiveRepository,
  input: GapAuditInput,
  options: Pick<LiveMaintainerOptions, "maxGapRetries">
): Promise<{ checkpoints: LiveChatCheckpointRecord[]; gapsOpened: number }> {
  const existingGaps = await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]);
  const checkpoints: LiveChatCheckpointRecord[] = [];
  let gapsOpened = 0;
  for (const watermark of input.watermarks) {
    const openForChat = existingGaps.some((gap) => gap.chatSourceId === watermark.chatSourceId && gap.status !== "closed");
    const hasMissingWindow =
      input.requiredLowerBoundAtMs != null &&
      watermark.latestArchivedAtMs != null &&
      watermark.latestArchivedAtMs < input.requiredLowerBoundAtMs;
    const checkpoint: LiveChatCheckpointRecord = {
      chatSourceId: watermark.chatSourceId,
      latestArchivedMessageKey: watermark.latestArchivedMessageKey,
      latestArchivedAtMs: watermark.latestArchivedAtMs,
      earliestArchivedMessageKey: watermark.earliestArchivedMessageKey,
      earliestArchivedAtMs: watermark.earliestArchivedAtMs,
      latestLiveMessageKey: null,
      latestLiveAtMs: null,
      oldestVerifiedMessageKey: watermark.earliestArchivedMessageKey,
      oldestVerifiedAtMs: watermark.earliestArchivedAtMs,
      health: hasMissingWindow || openForChat ? "catching_up" : "healthy",
      retryCount: 0,
      lastAuditAt: new Date(input.nowMs ?? Date.now()).toISOString()
    };
    await repository.upsertLiveCheckpoint(checkpoint);
    checkpoints.push(checkpoint);
    if (hasMissingWindow && !openForChat) {
      const gap: LiveGapWindowRecord = {
        chatSourceId: watermark.chatSourceId,
        reason: input.reason ?? "late_start",
        status: "open",
        startAtMs: watermark.latestArchivedAtMs,
        endAtMs: input.requiredLowerBoundAtMs,
        requiredLowerBoundAtMs: watermark.latestArchivedAtMs,
        anchorMessageKey: watermark.latestArchivedMessageKey,
        requestCount: 0,
        confidence: "medium",
        notes: `Archive is older than required lower bound; retry limit ${options.maxGapRetries}.`
      };
      await repository.upsertLiveGap(gap);
      gapsOpened += 1;
    }
  }
  return { checkpoints, gapsOpened };
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
