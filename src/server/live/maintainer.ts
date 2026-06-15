import type { ArchiveRepository } from "../db/repository";
import { config } from "../config";
import { assertLiveDependencySafe } from "./dependency";
import { auditChatGaps, auditMessageEventCheckpoint, computeArchiveWatermarks } from "./auditor";
import { recoverDueGaps } from "./recovery";
import { addEventToTotals, emptyLiveTotals, type LiveMaintainerOptions, type LiveMessageEvent, type LiveWhatsAppClient } from "./types";

export class LiveMaintainer {
  private runId: string | null = null;
  private totals = emptyLiveTotals();
  private stopping = false;
  private lastDisconnectedAtMs: number | null = null;

  constructor(
    private readonly repository: ArchiveRepository,
    private readonly client: LiveWhatsAppClient,
    private readonly options: LiveMaintainerOptions
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
      await this.repository.upsertLiveSession({
        id: "default",
        status: update.state,
        clientName: this.client.name,
        linkedDeviceJid: update.linkedDeviceJid ?? null,
        lastConnectedAt: update.state === "connected" ? new Date().toISOString() : undefined,
        lastDisconnectedAt: update.state === "disconnected" ? new Date().toISOString() : undefined,
        lastError: update.lastError ?? null
      });
      if (update.state === "disconnected") {
        this.lastDisconnectedAtMs = Date.now();
      }
      if (update.state === "connected" && this.lastDisconnectedAtMs != null) {
        const result = await auditChatGaps(
          this.repository,
          {
            watermarks: await computeArchiveWatermarks(this.repository),
            requiredLowerBoundAtMs: Date.now(),
            reason: "disconnect"
          },
          { maxGapRetries: this.options.maxGapRetries }
        );
        this.totals = { ...this.totals, gapsOpened: this.totals.gapsOpened + result.gapsOpened };
        this.lastDisconnectedAtMs = null;
      }
    });
    this.client.onEvent((event) => this.ingestEvent(event));
    await this.client.connect();
    return this.runId;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.client.disconnect();
    await this.repository.upsertLiveSession({ id: "default", status: "stopped", clientName: this.client.name });
    if (this.runId) {
      await this.repository.completeLiveSyncRun(this.runId, this.totals, this.totals.warnings);
    }
  }

  async runRecoveryOnce(): Promise<void> {
    const summary = await recoverDueGaps(this.repository, this.client, this.options);
    this.totals = {
      ...this.totals,
      gapsClosed: this.totals.gapsClosed + summary.closed,
      warnings: this.totals.warnings + summary.uncertain + summary.needsUserAction
    };
  }

  private async ingestEvent(event: LiveMessageEvent): Promise<void> {
    if (await this.repository.hasLiveEventReceipt(event.eventKey)) {
      return;
    }
    if (event.contacts?.length) await this.repository.upsertContacts(this.runId ?? "live", event.contacts);
    if (event.chats?.length) await this.repository.upsertChats(this.runId ?? "live", event.chats);
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
    await this.repository.refreshChatStats();
    await this.updateCheckpoints(event);
    this.totals = addEventToTotals(this.totals, event);
  }

  private async updateCheckpoints(event: LiveMessageEvent): Promise<void> {
    const byChat = new Map<string, NonNullable<LiveMessageEvent["messages"]>>();
    for (const message of event.messages ?? []) {
      const messages = byChat.get(message.chatSourceId) ?? [];
      messages.push(message);
      byChat.set(message.chatSourceId, messages);
    }
    const current = new Map((await this.repository.listLiveCheckpoints()).map((checkpoint) => [checkpoint.chatSourceId, checkpoint]));
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
    maxGapRetries: config.live.maxGapRetries
  };
}
