import type { ArchiveRepository } from "../db/repository";
import { config } from "../config";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { messageKey } from "../identity/keys";
import { assertLiveDependencySafe } from "./dependency";
import { auditChatGaps, auditMessageEventCheckpoint, GAP_TOLERANCE_MS } from "./auditor";
import { recoverDueGaps } from "./recovery";
import { runRetainedPayloadDecryptionPass } from "./secretsPass";
import type { LiveSyncProgress } from "../../shared/types";
import { addEventToTotals, emptyLiveTotals, type LiveMaintainerOptions, type LiveMessageEvent, type LiveWhatsAppClient } from "./types";

const INGEST_MESSAGE_CHUNK_SIZE = 500;

export interface LiveMaintainerCallbacks {
  onArchiveChanged?: (event: LiveMessageEvent) => void | Promise<void>;
}

export class LiveMaintainer {
  private runId: string | null = null;
  private totals = emptyLiveTotals();
  private stopping = false;
  private connected = false;
  private linkedDeviceJid: string | null = null;
  private hasConnectedThisProcess = false;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryRunning = false;
  private auditDueAtMs: number | null = null;
  private pendingAuditTrigger: "late_start" | "disconnect" | null = null;
  private readonly namingAttempts = new Map<string, { count: number; nextAtMs: number }>();
  private readonly progress = {
    processedMessages: 0,
    processedEvents: 0,
    queuedMessages: 0,
    historySyncPercent: null as number | null,
    lastEventAtMs: null as number | null
  };

  // Snapshot of in-memory counters only — safe to serve on every UI poll even
  // while ingestion is grinding, because it never touches the database.
  getSyncProgress(): LiveSyncProgress {
    const lastEventAtMs = this.progress.lastEventAtMs;
    const auditPending = this.pendingAuditTrigger != null;
    const backfillOutstanding = this.totals.gapsOpened > this.totals.gapsClosed;
    const historyPushRunning = this.progress.historySyncPercent != null && this.progress.historySyncPercent < 100;
    return {
      // Active means "there is catch-up work in flight", not merely "an event
      // arrived recently": platform push running, downtime audit still due,
      // per-chat backfill outstanding, or a fresh event burst.
      active:
        this.connected &&
        (historyPushRunning || auditPending || backfillOutstanding || (lastEventAtMs != null && Date.now() - lastEventAtMs < 45_000)),
      connected: this.connected,
      processedMessages: this.progress.processedMessages,
      processedEvents: this.progress.processedEvents,
      queuedMessages: this.progress.queuedMessages,
      historySyncPercent: this.progress.historySyncPercent,
      auditPending,
      gapsOpened: this.totals.gapsOpened,
      gapsClosed: this.totals.gapsClosed,
      lastEventAt: lastEventAtMs ? new Date(lastEventAtMs).toISOString() : null
    };
  }

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
      if (update.linkedDeviceJid) {
        // Decryption of secret-encrypted payloads authored or targeted by the
        // user needs the real linked-device jid behind archived "me".
        this.linkedDeviceJid = update.linkedDeviceJid;
      }
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
      await this.sweepUnmergedIdentities();
      await this.runGroupNamingPass();
      await this.runSecretsPass();
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

  // Retained secret-encrypted payloads become readable when their secret
  // arrives (live capture or backup backfill); decrypt a bounded batch per
  // tick and apply the results as normal targeted updates.
  private async runSecretsPass(): Promise<void> {
    const result = await runRetainedPayloadDecryptionPass(this.repository, { meJid: this.linkedDeviceJid, limit: 200 });
    if (result.decrypted > 0) {
      await configuredTraceRecorder?.record("live.secrets_decrypted", { runId: this.runId, ...result });
    }
  }

  // Links can be learned while the archive is closed (or by the importer);
  // merge a bounded batch of still-split identities per tick.
  private async sweepUnmergedIdentities(): Promise<void> {
    const unmerged = await this.repository.listUnmergedLidIdentities(3);
    for (const { lid, pn } of unmerged) {
      const merged = await this.repository.mergeIdentity(lid, pn);
      await configuredTraceRecorder?.record("live.identity_merged", { runId: this.runId, lid, source: "sweep", ...merged });
    }
  }

  // Groups must have a name or become an explicit alert; while connected,
  // actively fetch missing subjects, bounded and with per-chat backoff.
  private async runGroupNamingPass(): Promise<void> {
    if (!this.connected || !this.client.fetchGroupMetadata) {
      return;
    }
    const now = Date.now();
    // Pull a wide candidate window so permanently-failing groups (left groups,
    // forbidden metadata) cannot starve the rest of the queue.
    const candidates = (await this.repository.listUnnamedGroupChats(50)).filter((jid) => {
      const attempt = this.namingAttempts.get(jid);
      return !attempt || (attempt.nextAtMs <= now && attempt.count < 5);
    });
    for (const jid of candidates.slice(0, 3)) {
      const attempt = this.namingAttempts.get(jid) ?? { count: 0, nextAtMs: 0 };
      this.namingAttempts.set(jid, { count: attempt.count + 1, nextAtMs: now + 600_000 * 2 ** attempt.count });
      try {
        const metadata = await this.client.fetchGroupMetadata(jid);
        if (!metadata) {
          continue;
        }
        if (metadata.identityLinks.length) {
          await this.repository.recordIdentityLinks(metadata.identityLinks.map((link) => ({ ...link, source: "group-metadata" })));
        }
        if (metadata.subject) {
          await this.repository.upsertChats(this.runId ?? "live", [
            { sourceChatId: jid, jid, displayName: metadata.subject, chatType: "group", rawMetadata: { source: "wa-web-group-metadata" } }
          ]);
        }
        if (metadata.participants.length) {
          await this.repository.upsertParticipants(
            metadata.participants.map((participant) => ({
              chatSourceId: jid,
              sourceJid: participant.jid,
              membershipSource: "source" as const,
              rawMetadata: { source: "wa-web-group-metadata", role: participant.role ?? null }
            }))
          );
        }
        await configuredTraceRecorder?.record("live.group_metadata_fetched", {
          runId: this.runId,
          jid,
          hasSubject: Boolean(metadata.subject),
          participants: metadata.participants.length
        });
      } catch (error) {
        await configuredTraceRecorder?.record("live.group_metadata_failed", {
          runId: this.runId,
          jid,
          message: error instanceof Error ? error.message.slice(0, 300) : "Group metadata fetch failed."
        });
      }
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

  private async ingestEvent(rawEvent: LiveMessageEvent): Promise<void> {
    await configuredTraceRecorder?.record("live.ingest_event.start", { runId: this.runId, event: rawEvent });
    if (await this.repository.hasLiveEventReceipt(rawEvent.eventKey)) {
      await configuredTraceRecorder?.record("live.ingest_event.skipped_duplicate", { runId: this.runId, eventKey: rawEvent.eventKey });
      return;
    }
    // Identity mappings first, so the rest of the event ingests canonically and
    // records archived earlier under the LID form merge immediately.
    if (rawEvent.identityLinks?.length) {
      const learned = await this.repository.recordIdentityLinks(
        rawEvent.identityLinks.map((link) => ({ ...link, source: rawEvent.eventType }))
      );
      let processed = 0;
      for (const lid of learned) {
        const pn = await this.repository.resolveIdentityJid(lid);
        if (pn !== lid) {
          const merged = await this.repository.mergeIdentity(lid, pn);
          if (merged.chatsMerged || merged.contactsMerged || merged.messagesCollapsed) {
            await configuredTraceRecorder?.record("live.identity_merged", { runId: this.runId, lid, ...merged });
          }
        }
        // History sync can deliver thousands of mappings in one event; yield
        // periodically so the API stays responsive while they process.
        processed += 1;
        if (processed % 25 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    // Canonicalize once here so upserts AND post-ingest bookkeeping (stats,
    // gap closure, checkpoints, receipts) all see the same identities the
    // repository will store — including links learned this very event.
    const event = await this.canonicalizeEvent(rawEvent);
    const historyPercent = Number((rawEvent.rawMetadata as { progress?: unknown } | null | undefined)?.progress);
    if (Number.isFinite(historyPercent)) {
      this.progress.historySyncPercent = Math.max(this.progress.historySyncPercent ?? 0, Math.min(100, historyPercent));
    }
    this.progress.lastEventAtMs = Date.now();
    if (event.chats?.length) await this.repository.upsertChats(this.runId ?? "live", event.chats);
    if (event.contacts?.length) await this.repository.upsertContacts(this.runId ?? "live", event.contacts);
    if (event.participants?.length) await this.repository.upsertParticipants(event.participants);
    if (event.messages?.length) {
      // History chunks can carry thousands of messages; ingest in slices and
      // yield between them so API requests keep flowing during catch-up.
      this.progress.queuedMessages = event.messages.length;
      for (let index = 0; index < event.messages.length; index += INGEST_MESSAGE_CHUNK_SIZE) {
        const chunk = event.messages.slice(index, index + INGEST_MESSAGE_CHUNK_SIZE);
        await this.repository.upsertMessages(chunk);
        this.progress.processedMessages += chunk.length;
        this.progress.queuedMessages = Math.max(0, event.messages.length - index - chunk.length);
        if (index + INGEST_MESSAGE_CHUNK_SIZE < event.messages.length) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    if (event.updates?.length) await this.repository.applyLiveMessageUpdates(event.updates);
    if (event.secrets?.length) await this.repository.recordMessageSecrets(event.secrets);
    if (event.retainedPayloads?.length) {
      await this.repository.retainEncryptedPayloads(event.retainedPayloads);
      // Try immediately — the target's secret often already arrived (with the
      // poll/event itself or from a backup backfill).
      await runRetainedPayloadDecryptionPass(this.repository, { meJid: this.linkedDeviceJid, limit: 50 });
    }
    this.progress.processedEvents += 1;
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

  private async canonicalizeEvent(event: LiveMessageEvent): Promise<LiveMessageEvent> {
    // Resolve each unique identity once per event: history chunks carry
    // thousands of rows but only a handful of distinct chats/senders.
    const uniqueJids = new Set<string>();
    const collect = (jid: string | null | undefined) => {
      if (jid && jid !== "me") {
        uniqueJids.add(jid);
      }
    };
    for (const message of event.messages ?? []) {
      collect(message.chatSourceId);
      collect(message.senderSourceJid);
    }
    for (const chat of event.chats ?? []) collect(chat.sourceChatId);
    for (const participant of event.participants ?? []) {
      collect(participant.chatSourceId);
      collect(participant.sourceJid);
    }
    for (const update of event.updates ?? []) collect(update.chatSourceId);
    const canonical = new Map<string, string>();
    for (const jid of uniqueJids) {
      canonical.set(jid, await this.repository.resolveIdentityJid(jid));
    }
    const resolve = (jid: string | null | undefined): string | null =>
      jid == null ? null : jid === "me" ? "me" : canonical.get(jid) ?? jid;
    const messages = event.messages?.map((message) => {
      const chatSourceId = resolve(message.chatSourceId) ?? message.chatSourceId;
      return {
        ...message,
        chatSourceId,
        senderSourceJid: resolve(message.senderSourceJid) ?? message.senderSourceJid,
        sourceMessageKey: messageKey(chatSourceId, message.sourceMessageId)
      };
    });
    const chats = event.chats?.map((chat) => {
      const sourceChatId = resolve(chat.sourceChatId) ?? chat.sourceChatId;
      return { ...chat, sourceChatId, jid: sourceChatId };
    });
    const participants = event.participants?.map((participant) => ({
      ...participant,
      chatSourceId: resolve(participant.chatSourceId) ?? participant.chatSourceId,
      sourceJid: resolve(participant.sourceJid) ?? participant.sourceJid
    }));
    const updates = event.updates?.map((update) => ({
      ...update,
      chatSourceId: resolve(update.chatSourceId) ?? update.chatSourceId
    }));
    return { ...event, messages, chats, participants, updates };
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
