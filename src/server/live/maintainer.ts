import type { ArchiveRepository } from "../db/repository";
import { config } from "../config";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { assertLiveDependencySafe } from "./dependency";
import { auditChatGaps, auditMessageEventCheckpoint, GAP_TOLERANCE_MS } from "./auditor";
import { recoverDueGaps } from "./recovery";
import { addEventToTotals, emptyLiveTotals, type LiveMaintainerOptions, type LiveMessageEvent, type LiveWhatsAppClient } from "./types";

export interface LiveMaintainerCallbacks {
  onArchiveChanged?: (event: LiveMessageEvent) => void | Promise<void>;
}

export class LiveMaintainer {
  private runId: string | null = null;
  private totals = emptyLiveTotals();
  private stopping = false;
  private connected = false;
  private hasConnectedThisProcess = false;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryRunning = false;
  private auditDueAtMs: number | null = null;
  private pendingAuditTrigger: "late_start" | "disconnect" | null = null;

  constructor(
    private readonly repository: ArchiveRepository,
    private readonly client: LiveWhatsAppClient,
    private readonly options: LiveMaintainerOptions,
    private readonly callbacks: LiveMaintainerCallbacks = {}
  ) {}

  async start(): Promise<string> {
    assertLiveDependencySafe();
    this.stopping = false;
    await this.repository.upsertLiveSession({
      id: "default",
      status: "pairing",
      clientName: this.client.name
    });
    this.runId = await this.repository.startLiveSyncRun({ client: this.client.name });
    this.client.onConnectionUpdate(async (update) => {
      await configuredTraceRecorder?.record("live.connection_update", { runId: this.runId, update });
      await this.repository.upsertLiveSession({
        id: "default",
        status: update.state,
        clientName: this.client.name,
        linkedDeviceJid: update.linkedDeviceJid ?? null,
        lastConnectedAt: update.state === "connected" ? new Date().toISOString() : undefined,
        lastDisconnectedAt: update.state === "disconnected" || update.state === "logged_out" ? new Date().toISOString() : undefined,
        lastError: update.lastError ?? null
      });
      if (update.state === "connected") {
        // Audit both cold starts (late_start) and in-process reconnects
        // (disconnect); a settle period lets offline/history events land first
        // so the mismatch audit sees fresh platform recency.
        this.pendingAuditTrigger = this.hasConnectedThisProcess ? "disconnect" : "late_start";
        this.auditDueAtMs = Date.now() + (this.options.auditSettleMs ?? 60_000);
        this.hasConnectedThisProcess = true;
        this.connected = true;
      } else {
        this.connected = false;
      }
    });
    this.client.onEvent((event) => this.ingestEventContained(event));
    await this.client.connect();
    this.startRecoveryLoop();
    return this.runId;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopRecoveryLoop();
    await this.client.disconnect();
    await this.repository.upsertLiveSession({ id: "default", status: "stopped", clientName: this.client.name });
    if (this.runId) {
      await this.repository.completeLiveSyncRun(this.runId, this.totals, this.totals.warnings);
    }
  }

  async runRecoveryOnce(): Promise<void> {
    await this.recoveryTick(true);
  }

  private startRecoveryLoop(): void {
    if (this.recoveryTimer) {
      return;
    }
    const intervalMs = Math.max(1_000, this.options.recoveryIntervalMs ?? 30_000);
    this.recoveryTimer = setInterval(() => {
      void this.recoveryTick(false);
    }, intervalMs);
    this.recoveryTimer.unref?.();
  }

  private stopRecoveryLoop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private async recoveryTick(force: boolean): Promise<void> {
    if (this.recoveryRunning || this.stopping || (!force && !this.connected)) {
      return;
    }
    this.recoveryRunning = true;
    try {
      if (this.pendingAuditTrigger && (force || (this.auditDueAtMs != null && Date.now() >= this.auditDueAtMs))) {
        const trigger = this.pendingAuditTrigger;
        this.pendingAuditTrigger = null;
        this.auditDueAtMs = null;
        const audit = await auditChatGaps(this.repository, { trigger }, this.options);
        this.totals = {
          ...this.totals,
          gapsOpened: this.totals.gapsOpened + audit.gapsOpened,
          gapsClosed: this.totals.gapsClosed + audit.legacyGapsClosed
        };
        await configuredTraceRecorder?.record("live.audit_complete", { runId: this.runId, trigger, ...audit, checkpoints: audit.checkpoints.length });
      }
      const summary = await recoverDueGaps(this.repository, this.client, this.options);
      this.totals = {
        ...this.totals,
        gapsClosed: this.totals.gapsClosed + summary.closed,
        warnings: this.totals.warnings + summary.uncertain + summary.needsUserAction
      };
      if (summary.attempted || summary.closed || summary.pendingUpdatesRetried) {
        await configuredTraceRecorder?.record("live.recovery_tick", { runId: this.runId, ...summary });
      }
    } catch (error) {
      this.totals = { ...this.totals, warnings: this.totals.warnings + 1 };
      await configuredTraceRecorder?.record("live.recovery_tick_failed", {
        runId: this.runId,
        message: error instanceof Error ? error.message.slice(0, 500) : "Recovery tick failed."
      });
    } finally {
      this.recoveryRunning = false;
    }
  }

  private async ingestEventContained(event: LiveMessageEvent): Promise<void> {
    try {
      await this.ingestEvent(event);
    } catch (error) {
      // One bad event must not kill live ingestion; record and continue.
      this.totals = { ...this.totals, warnings: this.totals.warnings + 1 };
      await configuredTraceRecorder?.record("live.ingest_event.failed", {
        runId: this.runId,
        eventKey: event.eventKey.slice(0, 120),
        eventType: event.eventType,
        message: error instanceof Error ? error.message.slice(0, 500) : "Live event ingestion failed."
      });
    }
  }

  private async ingestEvent(event: LiveMessageEvent): Promise<void> {
    await configuredTraceRecorder?.record("live.ingest_event.start", { runId: this.runId, event });
    if (await this.repository.hasLiveEventReceipt(event.eventKey)) {
      await configuredTraceRecorder?.record("live.ingest_event.skipped_duplicate", { runId: this.runId, eventKey: event.eventKey });
      return;
    }
    if (event.chats?.length) await this.repository.upsertChats(this.runId ?? "live", event.chats);
    if (event.contacts?.length) await this.repository.upsertContacts(this.runId ?? "live", event.contacts);
    if (event.participants?.length) await this.repository.upsertParticipants(event.participants);
    if (event.messages?.length) await this.repository.upsertMessages(event.messages);
    if (event.updates?.length) await this.repository.applyLiveMessageUpdates(event.updates);
    await this.repository.recordLiveEventReceipt({
      eventKey: event.eventKey,
      eventType: event.eventType,
      chatSourceId: event.messages?.[0]?.chatSourceId ?? null,
      messageKey: event.messages?.[0]?.sourceMessageKey ?? null,
      occurredAtMs: event.occurredAtMs ?? null,
      metadata: { mode: event.mode }
    });
    const affectedChats = affectedChatSourceIds(event);
    await this.repository.refreshChatStats(affectedChats);
    const closed = await this.closeCoveredGaps(event);
    if (closed > 0) {
      this.totals = { ...this.totals, gapsClosed: this.totals.gapsClosed + closed };
    }
    await this.updateCheckpoints(event);
    this.totals = addEventToTotals(this.totals, event);
    await configuredTraceRecorder?.record("live.ingest_event.complete", { runId: this.runId, eventKey: event.eventKey, totals: this.totals });
    await configuredTraceRecorder?.snapshotArchive(`after-live-event-${event.eventKey.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80)}`, config.archive.sqlitePath);
    await this.callbacks.onArchiveChanged?.(event);
  }

  // A gap closes only when ingested evidence for its chat reaches the gap's
  // required lower bound — never from a request acknowledgement.
  private async closeCoveredGaps(event: LiveMessageEvent): Promise<number> {
    const minTsByChat = new Map<string, number>();
    for (const message of event.messages ?? []) {
      if (message.timestampMs == null) {
        continue;
      }
      const current = minTsByChat.get(message.chatSourceId);
      minTsByChat.set(message.chatSourceId, current == null ? message.timestampMs : Math.min(current, message.timestampMs));
    }
    if (minTsByChat.size === 0) {
      return 0;
    }
    const gaps = (await this.repository.listLiveGaps(["open", "retrying"])).filter((gap) => minTsByChat.has(gap.chatSourceId));
    let closed = 0;
    for (const gap of gaps) {
      if (gap.id == null) {
        continue;
      }
      const bound = gap.requiredLowerBoundAtMs ?? gap.startAtMs;
      const minTs = minTsByChat.get(gap.chatSourceId)!;
      if (bound == null || minTs <= bound + GAP_TOLERANCE_MS) {
        await this.repository.updateLiveGapStatus(gap.id, "closed", "Covered by ingested history evidence.");
        closed += 1;
      }
    }
    return closed;
  }

  private async updateCheckpoints(event: LiveMessageEvent): Promise<void> {
    const byChat = new Map<string, NonNullable<LiveMessageEvent["messages"]>>();
    for (const message of event.messages ?? []) {
      const messages = byChat.get(message.chatSourceId) ?? [];
      messages.push(message);
      byChat.set(message.chatSourceId, messages);
    }
    if (byChat.size === 0) {
      return;
    }
    const current = new Map((await this.repository.listLiveCheckpoints([...byChat.keys()])).map((checkpoint) => [checkpoint.chatSourceId, checkpoint]));
    for (const [chatSourceId, messages] of byChat) {
      const sorted = [...messages].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
      const oldest = sorted[0];
      const latest = sorted[sorted.length - 1];
      await this.repository.upsertLiveCheckpoint(
        auditMessageEventCheckpoint(
          current.get(chatSourceId),
          chatSourceId,
          latest?.sourceMessageKey ?? null,
          latest?.timestampMs ?? null,
          oldest?.sourceMessageKey ?? null,
          oldest?.timestampMs ?? null
        )
      );
    }
  }

  async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Live maintainer failed.";
    this.stopRecoveryLoop();
    await configuredTraceRecorder?.record("live.failed", { runId: this.runId, message });
    await this.repository.upsertLiveSession({ id: "default", status: "error", clientName: this.client.name, lastError: message.slice(0, 500) });
    if (this.runId && !this.stopping) {
      await this.repository.failLiveSyncRun(this.runId, "LIVE_MAINTAINER_FAILED", message, this.totals, this.totals.warnings);
    }
  }
}

export function liveOptionsFromConfig(): LiveMaintainerOptions {
  return {
    clientName: config.live.client,
    authDir: config.live.authDir,
    readOnly: true,
    maxBackfillPerChatMessages: config.live.maxBackfillPerChatMessages,
    maxBackfillPerChatDays: config.live.maxBackfillPerChatDays,
    maxConcurrentChatBackfills: config.live.maxConcurrentChatBackfills,
    minBackfillDelayMs: config.live.minBackfillDelayMs,
    maxGapRetries: config.live.maxGapRetries,
    recoveryIntervalMs: config.live.recoveryIntervalMs,
    auditSettleMs: config.live.auditSettleMs
  };
}

function affectedChatSourceIds(event: LiveMessageEvent): string[] {
  return [
    ...new Set([
      ...(event.chats ?? []).map((chat) => chat.sourceChatId),
      ...(event.messages ?? []).map((message) => message.chatSourceId),
      ...(event.updates ?? []).map((update) => update.chatSourceId),
      ...(event.participants ?? []).map((participant) => participant.chatSourceId)
    ])
  ].filter(Boolean);
}
