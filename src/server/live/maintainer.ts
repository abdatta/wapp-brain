import { createHash } from "node:crypto";
import type { ArchiveRepository } from "../db/repository";
import { config } from "../config";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { messageKey } from "../identity/keys";
import { normalizeJid } from "../import/jid";
import { mediaBlobStore } from "../media/blobStore";
import { runPersonAutoConnectPass } from "../persons/autoConnect";
import { runPersonSuggestionDetectors } from "../persons/suggestions";
import { assertLiveDependencySafe } from "./dependency";
import { auditChatGaps, auditMessageEventCheckpoint, GAP_TOLERANCE_MS } from "./auditor";
import { recoverDueGaps } from "./recovery";
import { runRetainedPayloadDecryptionPass } from "./secretsPass";
import { ARCHIVE_SIGNAL_CAPTURE_VERSION } from "../../shared/types";
import type { ArchiveSignalBatch, LiveSyncProgress, MediaDownloadQueueRecord, MessageRecord } from "../../shared/types";
import { addEventToTotals, emptyLiveTotals, type LiveMaintainerOptions, type LiveMessageEvent, type LiveWhatsAppClient } from "./types";

const INGEST_MESSAGE_CHUNK_SIZE = 500;

// Media download bounds: a bounded batch per recovery tick with small
// concurrency, run AFTER gap recovery and the secrets pass so media work can
// never starve them. Transient failures back off exponentially to a cap;
// expired links get a bounded number of media re-upload requests, rate-limited
// per tick, then go terminal as expired_unrecoverable.
const MEDIA_DOWNLOAD_BATCH_SIZE = 8;
const MEDIA_DOWNLOAD_CONCURRENCY = 3;
const MEDIA_MAX_TRANSIENT_ATTEMPTS = 8;
const MEDIA_MAX_REUPLOAD_ATTEMPTS = 3;
const MEDIA_REUPLOAD_REQUESTS_PER_TICK = 2;
const MEDIA_RETRY_BASE_DELAY_MS = 30_000;
const MEDIA_RETRY_MAX_DELAY_MS = 3_600_000;
// Priorities: view-once first (its content is time-limited and absent from
// backups), then fresh media (CDN links expire), then everything else.
const MEDIA_PRIORITY_VIEW_ONCE = 100;
const MEDIA_PRIORITY_FRESH = 50;
const MEDIA_FRESH_WINDOW_MS = 48 * 3_600_000;

export interface LiveMaintainerCallbacks {
  onArchiveChanged?: (event: LiveMessageEvent) => void | Promise<void>;
  // Media queue state changed (claimed for download, stored, or terminal) for
  // these chats — lets open threads flip queued → downloading → rendered media
  // without a reload.
  onMediaChanged?: (chatSourceIds: string[]) => void | Promise<void>;
  // The last recovery-tick pass: brain assimilation. Self-guards (no-op unless
  // scheduling is auto) and holds its own `brain` job lock; wired to the brain
  // scheduler in server.ts so live/ stays decoupled from brain/.
  runBrainPass?: () => Promise<void>;
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
      await this.runPersonPass();
      await this.runGroupNamingPass();
      await this.runSecretsPass();
      // Media runs last on the tick so gap recovery and secrets never wait.
      await this.runMediaDownloadPass();
      // Brain assimilation runs after media — the lowest-priority pass, so it
      // can never starve gap/identity/secrets/media. Its own errors stay inside
      // the brain (never inflate live-sync warnings).
      if (this.callbacks.runBrainPass) {
        try {
          await this.callbacks.runBrainPass();
        } catch (error) {
          console.error(`[brain] auto pass failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
        }
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

  // Retained secret-encrypted payloads become readable when their secret
  // arrives (live capture or backup backfill); decrypt a bounded batch per
  // tick and apply the results as normal targeted updates.
  private async runSecretsPass(): Promise<void> {
    const result = await runRetainedPayloadDecryptionPass(this.repository, { meJid: this.linkedDeviceJid, limit: 200 });
    if (result.decrypted > 0) {
      await configuredTraceRecorder?.record("live.secrets_decrypted", { runId: this.runId, ...result });
    }
  }

  private mediaPassRunning = false;

  // Claim a bounded batch of due media downloads, fetch + decrypt each, store
  // the blob content-addressed, link the asset, and mark the queue row
  // terminal. Transient failures back off; expired links get bounded,
  // rate-limited media re-upload requests before going unrecoverable.
  private async runMediaDownloadPass(): Promise<void> {
    if (this.mediaPassRunning || !this.connected || !this.client.downloadMedia) {
      return;
    }
    this.mediaPassRunning = true;
    let reuploadBudget = MEDIA_REUPLOAD_REQUESTS_PER_TICK;
    try {
      const tasks = await this.repository.claimDueMediaDownloads(MEDIA_DOWNLOAD_BATCH_SIZE, Date.now());
      if (tasks.length === 0) {
        return;
      }
      const affectedChats = [...new Set(tasks.map((task) => task.chatSourceId))];
      await this.callbacks.onMediaChanged?.(affectedChats);
      let stored = 0;
      let failedTransient = 0;
      let expired = 0;
      const queue = [...tasks];
      const worker = async (): Promise<void> => {
        for (;;) {
          const task = queue.shift();
          if (!task || this.stopping) {
            return;
          }
          const allowReupload = task.reuploadAttempts < MEDIA_MAX_REUPLOAD_ATTEMPTS && reuploadBudget > 0;
          const outcome = await this.client.downloadMedia!(task, { allowReupload });
          if (outcome.usedReupload) {
            reuploadBudget -= 1;
          }
          if (outcome.status === "stored" && outcome.bytes) {
            const blob = await mediaBlobStore.putBytes(outcome.bytes);
            await this.repository.completeMediaDownload(task.id!, {
              messageKey: task.messageKey,
              chatSourceId: task.chatSourceId,
              sha256: blob.sha256,
              storagePath: blob.storagePath,
              mimeType: task.descriptor.mimeType,
              byteSize: blob.byteSize,
              width: task.descriptor.width,
              height: task.descriptor.height,
              durationMs: task.descriptor.durationSeconds != null ? Math.round(task.descriptor.durationSeconds * 1000) : null,
              thumbnail: task.thumbnail ?? null,
              source: outcome.usedReupload ? "media-retry" : "live-download",
              isViewOnce: task.isViewOnce
            });
            stored += 1;
            continue;
          }
          if (outcome.status === "expired") {
            // Re-upload attempts are bounded per message; once exhausted — or
            // when no retry key was ever captured — the state goes terminal
            // instead of looping forever.
            const reuploadAttemptsAfter = task.reuploadAttempts + (outcome.usedReupload ? 1 : 0);
            const recoverable = Boolean(task.descriptor.retryKey) && reuploadAttemptsAfter < MEDIA_MAX_REUPLOAD_ATTEMPTS;
            if (recoverable) {
              await this.repository.markMediaDownloadRetry(
                task.id!,
                outcome.error ?? "Media link expired.",
                Date.now() + retryDelayMs(task.attempts),
                { countReupload: outcome.usedReupload }
              );
            } else {
              await this.repository.markMediaDownloadTerminal(task.id!, "expired_unrecoverable", outcome.error ?? null);
              expired += 1;
            }
            continue;
          }
          // Transient failure: back off and retry to a cap, then mark failed.
          if (task.attempts + 1 >= MEDIA_MAX_TRANSIENT_ATTEMPTS) {
            await this.repository.markMediaDownloadTerminal(task.id!, "failed", outcome.error ?? null);
          } else {
            await this.repository.markMediaDownloadRetry(
              task.id!,
              outcome.error ?? "Media download failed.",
              Date.now() + retryDelayMs(task.attempts)
            );
          }
          failedTransient += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(MEDIA_DOWNLOAD_CONCURRENCY, queue.length) }, () => worker()));
      if (stored || failedTransient || expired) {
        await this.callbacks.onMediaChanged?.(affectedChats);
        console.log(`[live] media pass: ${stored} stored, ${failedTransient} failed transient, ${expired} expired of ${tasks.length} claimed`);
        await configuredTraceRecorder?.record("live.media_download_pass", {
          runId: this.runId,
          claimed: tasks.length,
          stored,
          failedTransient,
          expired
        });
      }
    } catch (error) {
      await configuredTraceRecorder?.record("live.media_download_pass_failed", {
        runId: this.runId,
        message: error instanceof Error ? error.message.slice(0, 500) : "Media download pass failed."
      });
    } finally {
      this.mediaPassRunning = false;
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

  private personTickCount = 0;

  // Two-level person model maintenance: certainty-grade auto-connect (google
  // groupings + number-change events) every tick — cheap, idempotent scans —
  // and the heavier deterministic suggestion detectors every Nth tick. Person
  // work is metadata-only by construction; its errors never inflate live-sync
  // warnings.
  private async runPersonPass(): Promise<void> {
    this.personTickCount += 1;
    try {
      const summary = await runPersonAutoConnectPass(this.repository);
      const connected = summary.googleConnected + summary.numberChangeConnected;
      if (connected > 0) {
        console.log(
          `[persons] auto-connect: ${summary.googleConnected} via google, ${summary.numberChangeConnected} via number change, ${summary.unions} union(s)`
        );
        await configuredTraceRecorder?.record("live.person_auto_connect", { runId: this.runId, ...summary });
      }
      if (this.personTickCount % Math.max(1, config.persons.detectorTickInterval) === 0) {
        const detected = await runPersonSuggestionDetectors(this.repository);
        if (detected.created > 0 || detected.updated > 0) {
          console.log(`[persons] suggestion detectors: ${detected.created} new, ${detected.updated} updated`);
          await configuredTraceRecorder?.record("live.person_suggestions", { runId: this.runId, ...detected });
        }
      }
    } catch (error) {
      console.error(`[persons] pass failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
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
    // Direct group notifications do not include a WhatsApp message envelope,
    // but their verified signal is still meaningful thread history. Create a
    // local-only system anchor before persisting it so the same thread UI can
    // render it. This never affects live totals or chat conversation recency.
    const timeline = materializeUnanchoredLiveSystemEvents(event);
    if (timeline.messages.length) {
      await this.repository.upsertMessages(timeline.messages);
    }
    if (event.updates?.length) await this.repository.applyLiveMessageUpdates(event.updates);
    const archiveSignals = timeline.archiveSignals;
    if (hasArchiveSignals(archiveSignals)) {
      await this.repository.upsertArchiveSignals(archiveSignals);
    }
    if (event.secrets?.length) await this.repository.recordMessageSecrets(event.secrets);
    if (event.retainedPayloads?.length) {
      await this.repository.retainEncryptedPayloads(event.retainedPayloads);
      // Try immediately — the target's secret often already arrived (with the
      // poll/event itself or from a backup backfill).
      await runRetainedPayloadDecryptionPass(this.repository, { meJid: this.linkedDeviceJid, limit: 50 });
    }
    if (event.mediaDescriptors?.length) {
      // Every media-bearing message gets a durable queue row; view-once and
      // fresh media jump the line because their content is time-limited.
      const now = Date.now();
      const enqueued = await this.repository.enqueueMediaDownloads(
        event.mediaDescriptors.map((capture) => ({
          messageKey: messageKey(capture.chatSourceId, capture.sourceMessageId),
          chatSourceId: capture.chatSourceId,
          sourceMessageId: capture.sourceMessageId,
          descriptor: capture.descriptor,
          thumbnail: capture.thumbnail,
          isViewOnce: capture.isViewOnce,
          priority: capture.isViewOnce
            ? MEDIA_PRIORITY_VIEW_ONCE
            : capture.messageTimestampMs != null && now - capture.messageTimestampMs < MEDIA_FRESH_WINDOW_MS
              ? MEDIA_PRIORITY_FRESH
              : 0
        }))
      );
      if (enqueued > 0 && event.mode === "notify") {
        // Fresh real-time media downloads eagerly (CDN links expire fastest,
        // and view-once may vanish); history chunks wait for the tick.
        void this.runMediaDownloadPass();
      }
    }
    if (event.linkPreviews?.length) {
      await this.repository.recordLinkPreviews(event.linkPreviews);
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
    // Exact traces retain every raw and normalized event. Copying the entire
    // archive after contact/LID-only events, however, serializes a large file
    // copy for each event and can delay the very message ingestion being
    // diagnosed. A message-bearing event still gets its complete local archive
    // snapshot after all of its related writes have committed.
    if (liveEventNeedsArchiveSnapshot(event)) {
      await configuredTraceRecorder?.snapshotArchive(`after-live-event-${event.eventKey.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80)}`, config.archive.sqlitePath);
    }
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
      collect(message.quotedSnapshot?.quotedSourceChatId);
      collect(message.quotedSnapshot?.quotedSenderSourceJid);
    }
    for (const chat of event.chats ?? []) collect(chat.sourceChatId);
    for (const participant of event.participants ?? []) {
      collect(participant.chatSourceId);
      collect(participant.sourceJid);
    }
    for (const update of event.updates ?? []) collect(update.chatSourceId);
    for (const capture of event.mediaDescriptors ?? []) collect(capture.chatSourceId);
    for (const preview of event.linkPreviews ?? []) collect(preview.chatSourceId);
    for (const signal of event.archiveSignals?.numberChanges ?? []) {
      collect(signal.chatSourceId);
      collect(signal.oldJid);
      collect(signal.newJid);
      collect(signal.actorJid);
    }
    for (const signal of event.archiveSignals?.membershipPeriods ?? []) {
      collect(signal.groupSourceId);
      collect(signal.participantJid);
    }
    for (const signal of event.archiveSignals?.membershipEvents ?? []) {
      collect(signal.groupSourceId);
      collect(signal.participantJid);
      collect(signal.actorJid);
    }
    for (const signal of event.archiveSignals?.chatMetadataHistory ?? []) {
      collect(signal.chatSourceId);
      collect(signal.actorJid);
    }
    for (const signal of event.archiveSignals?.vcards ?? []) collect(signal.resolvedJid);
    for (const signal of event.archiveSignals?.deletions ?? []) collect(signal.revokedByJid);
    for (const signal of event.archiveSignals?.engagementAggregates ?? []) {
      collect(signal.chatSourceId);
      collect(signal.counterpartyJid);
    }
    const canonical = new Map<string, string>();
    for (const jid of uniqueJids) {
      canonical.set(jid, await this.repository.resolveIdentityJid(jid));
    }
    // Baileys reports the linked account in device form, while quoted
    // participants may be phone or canonical-LID forms. Resolve both once and
    // retain the source JID; `quotedFromMe` is the durable owner signal, not a
    // guessed contact name.
    const linkedOwnerJid = this.linkedDeviceJid ? await this.repository.resolveIdentityJid(this.linkedDeviceJid) : null;
    const ownerIdentities = new Set(
      [this.linkedDeviceJid, linkedOwnerJid]
        .map((jid) => normalizeJid(jid))
        .filter((jid): jid is string => Boolean(jid))
    );
    const resolve = (jid: string | null | undefined): string | null =>
      jid == null ? null : jid === "me" ? "me" : canonical.get(jid) ?? jid;
    const messages = event.messages?.map((message) => {
      const chatSourceId = resolve(message.chatSourceId) ?? message.chatSourceId;
      return {
        ...message,
        chatSourceId,
        senderSourceJid: resolve(message.senderSourceJid) ?? message.senderSourceJid,
        quotedSnapshot: message.quotedSnapshot
          ? (() => {
              const quotedSenderSourceJid =
                resolve(message.quotedSnapshot.quotedSenderSourceJid) ?? message.quotedSnapshot.quotedSenderSourceJid;
              const quotedFromMe =
                message.quotedSnapshot.quotedFromMe ??
                (quotedSenderSourceJid === "me" || ownerIdentities.has(normalizeJid(quotedSenderSourceJid) ?? "") ? true : null);
              return {
                ...message.quotedSnapshot,
                quotedSourceChatId:
                  resolve(message.quotedSnapshot.quotedSourceChatId) ?? message.quotedSnapshot.quotedSourceChatId,
                quotedSenderSourceJid,
                quotedFromMe,
                mentionedJids: (message.quotedSnapshot.mentionedJids ?? []).map((jid) => resolve(jid) ?? jid)
              };
            })()
          : null,
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
    // Media linkage keys canonicalize; the descriptor keeps the raw retry key
    // untouched because a re-upload must reference the delivery exactly.
    const mediaDescriptors = event.mediaDescriptors?.map((capture) => ({
      ...capture,
      chatSourceId: resolve(capture.chatSourceId) ?? capture.chatSourceId
    }));
    const linkPreviews = event.linkPreviews?.map((preview) => ({
      ...preview,
      chatSourceId: resolve(preview.chatSourceId) ?? preview.chatSourceId
    }));
    const sourceMessageKeys = new Map<string, string>();
    for (let index = 0; index < (event.messages?.length ?? 0); index += 1) {
      const before = event.messages![index];
      const after = messages![index];
      sourceMessageKeys.set(before.sourceMessageKey, after.sourceMessageKey);
    }
    const signalMessageKey = (sourceMessageKey: string | null): string | null =>
      sourceMessageKey == null ? null : sourceMessageKeys.get(sourceMessageKey) ?? sourceMessageKey;
    const archiveSignals = event.archiveSignals
      ? {
          ...event.archiveSignals,
          numberChanges: event.archiveSignals.numberChanges?.map((signal) => ({
            ...signal,
            chatSourceId: signal.chatSourceId == null ? null : resolve(signal.chatSourceId) ?? signal.chatSourceId,
            sourceMessageKey: signalMessageKey(signal.sourceMessageKey),
            oldJid: resolve(signal.oldJid) ?? signal.oldJid,
            newJid: resolve(signal.newJid) ?? signal.newJid,
            actorJid: signal.actorJid == null ? null : resolve(signal.actorJid) ?? signal.actorJid
          })),
          membershipPeriods: event.archiveSignals.membershipPeriods?.map((signal) => ({
            ...signal,
            groupSourceId: resolve(signal.groupSourceId) ?? signal.groupSourceId,
            participantJid: resolve(signal.participantJid) ?? signal.participantJid
          })),
          membershipEvents: event.archiveSignals.membershipEvents?.map((signal) => ({
            ...signal,
            groupSourceId: resolve(signal.groupSourceId) ?? signal.groupSourceId,
            participantJid: resolve(signal.participantJid) ?? signal.participantJid,
            actorJid: signal.actorJid == null ? null : resolve(signal.actorJid) ?? signal.actorJid,
            sourceMessageKey: signalMessageKey(signal.sourceMessageKey)
          })),
          chatMetadataHistory: event.archiveSignals.chatMetadataHistory?.map((signal) => ({
            ...signal,
            chatSourceId: resolve(signal.chatSourceId) ?? signal.chatSourceId,
            actorJid: signal.actorJid == null ? null : resolve(signal.actorJid) ?? signal.actorJid,
            sourceMessageKey: signalMessageKey(signal.sourceMessageKey)
          })),
          locations: event.archiveSignals.locations?.map((signal) => ({ ...signal, sourceMessageKey: signalMessageKey(signal.sourceMessageKey)! })),
          locationObservations: event.archiveSignals.locationObservations?.map((signal) => ({ ...signal, sourceMessageKey: signalMessageKey(signal.sourceMessageKey)! })),
          vcards: event.archiveSignals.vcards?.map((signal) => ({
            ...signal,
            sourceMessageKey: signalMessageKey(signal.sourceMessageKey)!,
            resolvedJid: signal.resolvedJid == null ? null : resolve(signal.resolvedJid) ?? signal.resolvedJid
          })),
          editEvents: event.archiveSignals.editEvents?.map((signal) => ({ ...signal, sourceMessageKey: signalMessageKey(signal.sourceMessageKey)! })),
          deletions: event.archiveSignals.deletions?.map((signal) => ({
            ...signal,
            sourceMessageKey: signalMessageKey(signal.sourceMessageKey)!,
            revokedByJid: signal.revokedByJid == null ? null : resolve(signal.revokedByJid) ?? signal.revokedByJid
          })),
          mediaInterpretations: event.archiveSignals.mediaInterpretations?.map((signal) => ({ ...signal, sourceMessageKey: signalMessageKey(signal.sourceMessageKey)! })),
          engagementAggregates: event.archiveSignals.engagementAggregates?.map((signal) => ({
            ...signal,
            chatSourceId: resolve(signal.chatSourceId) ?? signal.chatSourceId,
            counterpartyJid: signal.counterpartyJid == null ? null : resolve(signal.counterpartyJid) ?? signal.counterpartyJid
          }))
        }
      : undefined;
    return { ...event, messages, chats, participants, updates, mediaDescriptors, linkPreviews, archiveSignals };
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

function archiveSignalsForEvent(event: LiveMessageEvent): ArchiveSignalBatch {
  const batch: ArchiveSignalBatch = {
    numberChanges: [...(event.archiveSignals?.numberChanges ?? [])],
    membershipPeriods: [...(event.archiveSignals?.membershipPeriods ?? [])],
    membershipEvents: [...(event.archiveSignals?.membershipEvents ?? [])],
    chatMetadataHistory: [...(event.archiveSignals?.chatMetadataHistory ?? [])],
    locations: [...(event.archiveSignals?.locations ?? [])],
    locationObservations: [...(event.archiveSignals?.locationObservations ?? [])],
    vcards: [...(event.archiveSignals?.vcards ?? [])],
    editEvents: [...(event.archiveSignals?.editEvents ?? [])],
    deletions: [...(event.archiveSignals?.deletions ?? [])],
    mediaInterpretations: [...(event.archiveSignals?.mediaInterpretations ?? [])],
    engagementAggregates: [...(event.archiveSignals?.engagementAggregates ?? [])]
  };
  for (const update of event.updates ?? []) {
    const observedAtMs = update.occurredAtMs ?? event.occurredAtMs ?? null;
    const provenance = {
      source: "live" as const,
      sourceEventKey: update.eventKey,
      observedAtMs,
      captureVersion: ARCHIVE_SIGNAL_CAPTURE_VERSION
    };
    if (update.updateType === "delete") {
      batch.deletions?.push({
        sourceMessageKey: update.sourceMessageKey,
        revokedByJid: typeof update.metadata?.revokedByJid === "string" ? update.metadata.revokedByJid : null,
        revokedByAdmin: typeof update.metadata?.revokedByAdmin === "boolean" ? update.metadata.revokedByAdmin : null,
        deletionKind: typeof update.metadata?.deletionKind === "string" ? update.metadata.deletionKind : null,
        ...provenance
      });
    } else if (update.updateType === "edit") {
      batch.editEvents?.push({
        eventKey: `live:edit:${update.eventKey}`,
        sourceMessageKey: update.sourceMessageKey,
        originalSourceMessageId: null,
        observedEditMessageId: null,
        ...provenance
      });
    }
  }
  return batch;
}

function hasArchiveSignals(batch: ArchiveSignalBatch): boolean {
  return Object.values(batch).some((records) => records?.length);
}

// Baileys exposes some verified group changes as direct notifications rather
// than message envelopes. We retain those as local timeline system rows only
// when they came from live sync; unanchored backup history stays query-only so
// the importer never invents a message that the source did not provide.
function materializeUnanchoredLiveSystemEvents(event: LiveMessageEvent): { messages: MessageRecord[]; archiveSignals: ArchiveSignalBatch } {
  const archiveSignals = archiveSignalsForEvent(event);
  const messages: MessageRecord[] = [];
  const addAnchor = (
    kind: "number-change" | "membership" | "chat-metadata",
    eventKey: string,
    chatSourceId: string | null,
    observedAtMs: number | null,
    assign: (sourceMessageKey: string) => void
  ) => {
    if (!chatSourceId) {
      return;
    }
    const hash = createHash("sha256").update(`${kind}:${eventKey}`).digest("hex").slice(0, 20);
    const sourceMessageId = `live-system-${hash}`;
    const sourceMessageKey = messageKey(chatSourceId, sourceMessageId);
    assign(sourceMessageKey);
    messages.push({
      sourceMessageId,
      sourceMessageKey,
      sourceTable: "wa-web-system-timeline",
      sourceRowId: sourceMessageId,
      chatSourceId,
      senderSourceJid: null,
      timestampMs: observedAtMs,
      sentAtIso: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
      fromMe: null,
      direction: "system",
      messageType: "system",
      rawTypeCode: "live-system-timeline",
      body: null,
      caption: null,
      hasMedia: false,
      mediaMimeType: null,
      mediaName: null,
      isDeleted: false,
      isForwarded: false,
      isStarred: false,
      rawMetadata: { source: "wa-web-system-timeline", signalKind: kind }
    });
  };
  for (const signal of archiveSignals.numberChanges ?? []) {
    if (signal.source === "live" && signal.sourceMessageKey == null) {
      addAnchor("number-change", signal.eventKey, signal.chatSourceId, signal.observedAtMs, (sourceMessageKey) => {
        signal.sourceMessageKey = sourceMessageKey;
      });
    }
  }
  for (const signal of archiveSignals.membershipEvents ?? []) {
    if (signal.source === "live" && signal.sourceMessageKey == null) {
      addAnchor("membership", signal.eventKey, signal.groupSourceId, signal.observedAtMs, (sourceMessageKey) => {
        signal.sourceMessageKey = sourceMessageKey;
      });
    }
  }
  for (const signal of archiveSignals.chatMetadataHistory ?? []) {
    if (signal.source === "live" && signal.sourceMessageKey == null) {
      addAnchor("chat-metadata", signal.eventKey, signal.chatSourceId, signal.observedAtMs, (sourceMessageKey) => {
        signal.sourceMessageKey = sourceMessageKey;
      });
    }
  }
  return { messages, archiveSignals };
}

export function liveEventNeedsArchiveSnapshot(
  event: Pick<LiveMessageEvent, "messages" | "updates" | "secrets" | "retainedPayloads" | "mediaDescriptors" | "linkPreviews" | "archiveSignals">
): boolean {
  return Boolean(
    event.messages?.length ||
      event.updates?.length ||
      event.secrets?.length ||
      event.retainedPayloads?.length ||
      event.mediaDescriptors?.length ||
      event.linkPreviews?.length ||
      hasArchiveSignals(event.archiveSignals ?? {})
  );
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

function retryDelayMs(attempts: number): number {
  return Math.min(MEDIA_RETRY_MAX_DELAY_MS, MEDIA_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempts, 8));
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
