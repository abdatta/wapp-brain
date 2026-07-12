import express from "express";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { cleanupSensitiveWorkDirs } from "./cleanup";
import { createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { mediaBlobStore } from "./media/blobStore";
import { configuredTraceRecorder, getTraceRecorderSummary } from "./diagnostics/traceRecorder";
import { BaileysLiveWhatsAppClient } from "./live/baileysClient";
import { runImport } from "./import/importer";
import { listWaContacts } from "./import/waContacts";
import {
  cancelImportJob,
  getCurrentImportJob,
  getImportJob,
  startImportJob,
  verifyImportKey
} from "./import/staging";
import { detectBackupFolder } from "./import/detectBackup";
import { isPickerAvailable, pickImportPath } from "./import/nativePicker";
import { closeLegacyWallClockGaps } from "./live/auditor";
import { assertLiveBaselineExists } from "./live/baseline";
import { ensureUsableLiveCreds } from "./live/baileysClient";
import { liveOptionsFromConfig } from "./live/maintainer";
import { LiveMaintainer } from "./live/maintainer";
import { queryMemory, resolveMemoryCitation, runMemoryConsolidation, validateMemoryStore } from "./memory/consolidation";
import { disableRemoteMemoryProvider, enableCodexProvider, getMemoryProviderStatus } from "./memory/provider";
import { isLocalDatabaseError, publicErrorMessage } from "./privacy";
import { GoogleContactsService } from "./googleContacts";
import { getSearchReindexProgress, startSearchReindex } from "./search/reindexJob";
import { withGuidedSetup } from "./onboarding";
import type { ArchiveChangeEvent, LivePairingSummary, PickKind } from "../shared/types";
import type { LiveMessageEvent } from "./live/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const repository = createArchiveRepository();
const googleContacts = new GoogleContactsService(config.googleContacts);
let activeMaintainer: LiveMaintainer | null = null;
let activeClient: BaileysLiveWhatsAppClient | null = null;
let livePairing: LivePairingSummary = idlePairing();
let archiveEventId = 0;
const archiveEventClients = new Set<Response>();

app.get("/api/status", async (_req, res) => {
  try {
    res.json({ ...withGuidedSetup(await repository.getStatus()), pickerAvailable: isPickerAvailable() });
  } catch {
    res.json({
      ...withGuidedSetup({
        database: {
          configured: true,
          initialized: false,
          adapter: config.archive.adapter,
          error: "Local archive database is not initialized or not reachable."
        },
        counts: { chats: 0, contacts: 0, participants: 0, messages: 0, warnings: 0 },
        latestImport: null,
        latestWarnings: []
      }),
      pickerAvailable: isPickerAvailable()
    });
  }
});

app.get("/api/google-contacts/status", async (_req, res) => {
  try { res.json(await googleContacts.status()); }
  catch (error) { res.status(400).json({ error: publicErrorMessage(error) }); }
});

app.get("/api/google-contacts/oauth/start", (_req, res) => {
  try { res.redirect(googleContacts.createAuthorizationUrl()); }
  catch (error) { res.redirect(`/?googleContacts=error&message=${encodeURIComponent(publicErrorMessage(error))}`); }
});

app.get("/api/google-contacts/oauth/callback", async (req, res) => {
  try {
    await googleContacts.handleCallback(typeof req.query.code === "string" ? req.query.code : "", typeof req.query.state === "string" ? req.query.state : "");
    res.redirect("/?googleContacts=connected");
  } catch (error) {
    res.redirect(`/?googleContacts=error&message=${encodeURIComponent(publicErrorMessage(error))}`);
  }
});

app.post("/api/google-contacts/sync", async (_req, res) => {
  try {
    const result = await googleContacts.sync(repository);
    if (result.improvedNames > 0) broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: result.improvedNames });
    res.json({ ok: true, result, status: await googleContacts.status() });
  } catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.delete("/api/google-contacts", async (_req, res) => {
  try { res.json({ ok: true, ...(await googleContacts.disconnect()), status: await googleContacts.status() }); }
  catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
});

app.get("/api/live/status", async (_req, res) => {
  try {
    res.json(await repository.getLiveStatus());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/live/gaps", async (_req, res) => {
  try {
    res.json(await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/live/gaps/:id/retry", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, error: "Invalid gap id." });
      return;
    }
    await repository.updateLiveGapStatus(id, "open", "User requested retry from local API.");
    res.json({ ok: true, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/unlink", async (_req, res) => {
  try {
    await stopActiveMaintainer();
    const options = liveOptionsFromConfig();
    await fs.promises.rm(options.authDir, { recursive: true, force: true });
    await repository.upsertLiveSession({ id: "default", status: "not_configured", clientName: options.clientName, lastError: null });
    livePairing = idlePairing();
    res.json({ ok: true, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/stop", async (_req, res) => {
  try {
    await stopActiveMaintainer();
    const options = liveOptionsFromConfig();
    await repository.upsertLiveSession({ id: "default", status: "stopped", clientName: options.clientName, lastError: null });
    res.json({ ok: true, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/link", async (req, res) => {
  try {
    await assertLiveBaselineExists(repository, config.live.maxBackfillPerChatDays);
    const phoneNumber = typeof req.body?.phoneNumber === "string" && req.body.phoneNumber.trim() ? req.body.phoneNumber.trim() : null;
    // WhatsApp only issues a pairing QR for UNREGISTERED credentials. After a
    // remote unlink (logged_out) the stored creds still exist but are dead —
    // reconnecting with them just yields another 401 and no QR, forever.
    // Re-pairing therefore needs a clean slate: stop any maintainer holding
    // the dead session and remove the auth state (including its backup).
    const options = liveOptionsFromConfig();
    const live = await repository.getLiveStatus();
    if (live.session?.status === "logged_out" || !(await ensureUsableLiveCreds(options.authDir))) {
      await stopActiveMaintainer();
      await fs.promises.rm(options.authDir, { recursive: true, force: true });
      await repository.upsertLiveSession({ id: "default", status: "not_configured", clientName: options.clientName, lastError: null });
      livePairing = idlePairing();
    }
    await startLiveMaintainer(phoneNumber);
    res.json({ ok: true, pairing: livePairing, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/resume", async (_req, res) => {
  try {
    // Resume never requires a fresh baseline: long downtime is represented as
    // honest gaps/uncertainty by the evidence-based audit instead of a refusal.
    await startLiveMaintainer(null);
    res.json({ ok: true, pairing: livePairing, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/live/pairing", (_req, res) => {
  res.json(livePairing);
});

// In-memory counters only — no database access, so it answers instantly even
// while heavy history-sync ingestion is running.
app.get("/api/live/progress", (_req, res) => {
  res.json(
    activeMaintainer?.getSyncProgress() ?? {
      active: false,
      connected: false,
      processedMessages: 0,
      processedEvents: 0,
      queuedMessages: 0,
      historySyncPercent: null,
      auditPending: false,
      gapsOpened: 0,
      gapsClosed: 0,
      lastEventAt: null
    }
  );
});

app.get("/api/archive/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  archiveEventClients.add(res);
  req.on("close", () => {
    archiveEventClients.delete(res);
  });
});

app.get("/api/diagnostics/trace", (_req, res) => {
  res.json(getTraceRecorderSummary());
});

app.get("/api/memory/status", async (_req, res) => {
  try {
    res.json(await repository.getMemoryStatus(await getMemoryProviderStatus()));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/runs", async (req, res) => {
  try {
    res.json({
      ok: true,
      result: await runMemoryConsolidation(repository, {
        kind: req.body?.kind === "manual" || req.body?.kind === "rebuild" ? req.body.kind : "rem",
        startAtMs: numberBody(req.body?.startAtMs),
        endAtMs: numberBody(req.body?.endAtMs),
        chatSourceIds: Array.isArray(req.body?.chatSourceIds) ? req.body.chatSourceIds.filter((item: unknown): item is string => typeof item === "string") : undefined,
        dryRun: Boolean(req.body?.dryRun),
        force: Boolean(req.body?.force)
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/query", async (req, res) => {
  try {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "Missing memory query." });
      return;
    }
    res.json(await queryMemory(repository, query));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/memory/citations/:citation", async (req, res) => {
  try {
    res.json(await resolveMemoryCitation(repository, req.params.citation));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/validate", async (_req, res) => {
  try {
    res.json(await validateMemoryStore(repository));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/provider/enable-codex", async (_req, res) => {
  try {
    res.json(await enableCodexProvider());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/memory/provider/disable", async (_req, res) => {
  try {
    res.json(await disableRemoteMemoryProvider());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/init-db", async (_req, res) => {
  try {
    await initializeArchiveDatabase();
    res.json({ ok: true, status: await repository.getStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import", async (req, res) => {
  try {
    if (req.body?.mode === "replace") {
      await repository.clearArchiveData();
    }
    const totals = await runImport(repository, {
      msgstorePath: String(req.body?.msgstorePath ?? ""),
      waPath: req.body?.waPath ? String(req.body.waPath) : null,
      mediaPath: req.body?.mediaPath ? String(req.body.mediaPath) : null,
      key: req.body?.key ? String(req.body.key) : null,
      keepDecrypted: Boolean(req.body?.keepDecrypted),
      mode: req.body?.mode === "replace" ? "replace" : "merge"
    });
    await configuredTraceRecorder?.snapshotArchive("after-api-import", config.archive.sqlitePath);
    broadcastArchiveChanged({
      source: "import",
      chatSourceIds: [],
      messageCount: totals.messages,
      contactCount: totals.contacts
    });
    res.json({ ok: true, totals });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

// Opens a native OS file/folder dialog on the machine running the server and
// returns the absolute path the user selects — nothing is uploaded. Request
// abort (client closed the wizard) cancels the pending dialog.
app.post("/api/import/pick", async (req, res) => {
  try {
    const kind = pickKind(req.body?.kind);
    const controller = new AbortController();
    // Abort only on a real client disconnect. The request's own "close" fires as
    // soon as its (already-consumed) body ends, which would kill the dialog
    // instantly — the response only closes early when the client goes away.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await pickImportPath(kind, {
      startIn: req.body?.startIn ? String(req.body.startIn) : null,
      signal: controller.signal
    });
    if ("path" in result) {
      res.json({ ok: true, path: result.path });
    } else if ("cancelled" in result) {
      res.json({ ok: true, cancelled: true });
    } else {
      res.json({ ok: false, unavailable: true, reason: result.reason });
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

// Scans a selected backup folder and returns a manifest of the detected inputs
// plus recognized (reserved) auxiliary files. Works for native-picked and typed
// paths alike.
app.post("/api/import/detect", async (req, res) => {
  try {
    const root = req.body?.root ? String(req.body.root) : "";
    if (!root || /^https?:\/\//i.test(root)) {
      res.status(400).json({ ok: false, error: "Provide a local backup folder path." });
      return;
    }
    const manifest = await detectBackupFolder(root);
    res.json({ ok: true, manifest });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/verify-key", async (req, res) => {
  try {
    res.json({
      ok: true,
      verification: await verifyImportKey({
        msgstorePath: req.body?.msgstorePath ? String(req.body.msgstorePath) : null,
        waPath: req.body?.waPath ? String(req.body.waPath) : null,
        key: req.body?.key ? String(req.body.key) : null
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

// Decrypts (if needed) and lists just the wa.db contacts sidecar, independent
// of a full msgstore import — a quick "what's in this backup" check.
app.post("/api/wa-contacts", async (req, res) => {
  try {
    const waPath = req.body?.waPath ? String(req.body.waPath) : "";
    if (!waPath) {
      res.status(400).json({ ok: false, error: "Provide a local wa.db or wa.db.crypt15 path." });
      return;
    }
    const summary = await listWaContacts({
      waPath,
      key: req.body?.key ? String(req.body.key) : null,
      keyPath: req.body?.keyPath ? String(req.body.keyPath) : null
    });
    res.json({ ok: true, summary });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/jobs", async (req, res) => {
  try {
    res.json({
      ok: true,
      job: startImportJob(repository, {
        mode: req.body?.mode === "replace" ? "replace" : "merge",
        key: req.body?.key ? String(req.body.key) : null,
        keepDecrypted: Boolean(req.body?.keepDecrypted),
        paths: {
          msgstorePath: req.body?.paths?.msgstorePath ? String(req.body.paths.msgstorePath) : undefined,
          waPath: req.body?.paths?.waPath ? String(req.body.paths.waPath) : undefined,
          mediaPath: req.body?.paths?.mediaPath ? String(req.body.paths.mediaPath) : undefined
        }
      }, {
        onArchiveChanged: (summary) => {
          broadcastArchiveChanged({
            source: summary.source,
            chatSourceIds: [],
            messageCount: summary.messageCount,
            contactCount: summary.contactCount
          });
        }
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/import/jobs/current", (_req, res) => {
  try {
    res.json({ job: getCurrentImportJob() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/import/jobs/:jobId", (req, res) => {
  try {
    res.json(getImportJob(req.params.jobId));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.delete("/api/import/jobs/:jobId", (req, res) => {
  try {
    res.json({ ok: true, job: cancelImportJob(req.params.jobId) });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/cleanup", async (_req, res) => {
  try {
    res.json({ ok: true, summary: await cleanupSensitiveWorkDirs() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/chats", async (req, res) => {
  try {
    const limit = clampNumber(req.query.limit, 25, 200, 60);
    const offset = clampNumber(req.query.offset, 0, 1_000_000, 0);
    res.json(
      await repository.listChats({
        search: stringQuery(req.query.search),
        type: stringQuery(req.query.type),
        includeEventOnly: booleanQuery(req.query.includeEventOnly),
        limit,
        offset
      })
    );
  } catch (error) {
    if (error instanceof Error && isLocalDatabaseError(error.message)) {
      res.json([]);
      return;
    }
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/chats/:id/messages", async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    const limit = clampNumber(req.query.limit, 25, 300, 150);
    const offset = clampNumber(req.query.offset, 0, 5_000_000, 0);
    res.json(
      await repository.listMessages(chatId, {
        limit,
        offset,
        sender: stringQuery(req.query.sender),
        query: stringQuery(req.query.query),
        order: req.query.order === "desc" ? "desc" : "asc"
      })
    );
  } catch (error) {
    if (error instanceof Error && isLocalDatabaseError(error.message)) {
      res.json([]);
      return;
    }
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Thread window centered on one message — search deep links land here so the
// viewer opens positioned at the hit instead of paging from the newest row.
app.get("/api/chats/:id/messages/context", async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    const anchorId = Number(req.query.anchorId);
    if (!Number.isInteger(chatId) || !Number.isInteger(anchorId)) {
      res.status(400).json({ error: "A chat id and anchor message id are required." });
      return;
    }
    const radius = clampNumber(req.query.radius, 5, 150, 75);
    const window = await repository.listMessagesAround(chatId, anchorId, radius);
    if (!window) {
      res.status(404).json({ error: "The anchor message was not found in this chat." });
      return;
    }
    res.json(window);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = stringQuery(req.query.query);
    if (!query) {
      res.json({ index: await repository.getSearchIndexStatus(), totalMatches: 0, results: [] });
      return;
    }
    const type = req.query.type === "text" || req.query.type === "media" || req.query.type === "call" ? req.query.type : null;
    const direction = req.query.direction === "incoming" || req.query.direction === "outgoing" ? req.query.direction : null;
    res.json(
      await repository.searchMessages({
        query,
        chatId: optionalNumberQuery(req.query.chatId),
        sender: stringQuery(req.query.sender) ?? null,
        afterMs: optionalNumberQuery(req.query.afterMs),
        beforeMs: optionalNumberQuery(req.query.beforeMs),
        type,
        direction,
        includeNoise: booleanQuery(req.query.includeNoise),
        limit: clampNumber(req.query.limit, 1, 100, 25),
        offset: clampNumber(req.query.offset, 0, 200, 0)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/search/status", async (_req, res) => {
  try {
    res.json({ index: await repository.getSearchIndexStatus(), reindex: getSearchReindexProgress() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Brain substrate status: watermark coverage, task queue, budget ledger,
// provider health, and run-dueness in one call — the operator dashboard for
// "is the brain keeping itself updated" under manual-first control.
app.get("/api/brain/status", async (_req, res) => {
  try {
    const { getBrainProviderStatus } = await import("./brain/provider");
    const status = await repository.getBrainStatus();
    // A run is due when backlog exists and no run has completed since the
    // most recent nightly cutoff boundary. Paused mode alerts; auto executes.
    const boundary = new Date();
    boundary.setHours(config.brain.cutoffHour, 0, 0, 0);
    if (boundary.getTime() > Date.now()) {
      boundary.setDate(boundary.getDate() - 1);
    }
    const lastFinished = status.latestRun?.finishedAt ? Date.parse(status.latestRun.finishedAt) : null;
    const pending = status.totalVisibleMessages - status.assimilatedVisibleMessages;
    const runDue = status.chatsWithBacklog > 0 && (lastFinished == null || lastFinished < boundary.getTime());
    res.json({
      ...status,
      provider: getBrainProviderStatus(),
      scheduler: {
        mode: config.brain.scheduler,
        runDue,
        dueReason: runDue
          ? `${pending.toLocaleString()} messages across ${status.chatsWithBacklog.toLocaleString()} chats are waiting to be assimilated and no run has completed since the ${String(config.brain.cutoffHour).padStart(2, "0")}:00 cutoff.`
          : null
      }
    });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Manual brain runs: start with an explicit generator/model, poll progress.
app.post("/api/brain/runs", async (req, res) => {
  try {
    const { startBrainRun } = await import("./brain/runJob");
    const mode = req.body?.mode === "model" || req.body?.mode === "extractive" ? req.body.mode : "model";
    const result = startBrainRun(
      repository,
      {
        mode,
        model: typeof req.body?.model === "string" ? req.body.model : null,
        chatSourceId: typeof req.body?.chatSourceId === "string" ? req.body.chatSourceId : null,
        maxChats: clampNumber(req.body?.maxChats, 1, 5000, 10),
        maxModelCalls: clampNumber(req.body?.maxModelCalls, 1, 1000, config.brain.maxCallsPerHour)
      },
      () => {
        broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
      },
      async () => {
        const contactStatus = await googleContacts.status();
        if (!contactStatus.connected) return;
        const sync = await googleContacts.sync(repository);
        if (sync.improvedNames > 0) {
          broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: sync.improvedNames });
        }
      }
    );
    if (!result.started) {
      res.status(409).json({ error: result.refusal ?? "The brain run could not start.", progress: result.progress });
      return;
    }
    res.json({ ok: true, progress: result.progress });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/runs/current", async (_req, res) => {
  try {
    const { getBrainRunProgress } = await import("./brain/runJob");
    res.json(getBrainRunProgress());
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/brain/episodes", async (req, res) => {
  try {
    res.json(
      await repository.listBrainEpisodes({
        chatSourceId: stringQuery(req.query.chatSourceId) ?? null,
        limit: clampNumber(req.query.limit, 1, 100, 20)
      })
    );
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Reset derived brain data (episodes/claims/citations/watermarks + projected
// files) — raw messages untouched; the next run re-assimilates from scratch.
app.post("/api/brain/reset", async (req, res) => {
  try {
    const { getBrainRunProgress } = await import("./brain/runJob");
    if (getBrainRunProgress().state === "running") {
      res.status(409).json({ error: "A brain run is in progress; wait for it to finish before resetting." });
      return;
    }
    const chatSourceId = typeof req.body?.chatSourceId === "string" ? req.body.chatSourceId : null;
    const result = await repository.resetBrainDerivedData({ chatSourceId });
    const { deleteProjectedEpisodeFiles } = await import("./brain/episodes");
    const filesRemoved = deleteProjectedEpisodeFiles(result.episodeIds);
    console.log(
      `[brain] reset${chatSourceId ? ` (one chat)` : ""}: ${result.episodeIds.length} episode(s), ${result.watermarks} watermark(s), ${filesRemoved} file(s) removed`
    );
    broadcastArchiveChanged({ source: "manual", chatSourceIds: chatSourceId ? [chatSourceId] : [], messageCount: 0, contactCount: 0 });
    res.json({ ok: true, episodesRemoved: result.episodeIds.length, watermarksReset: result.watermarks, filesRemoved });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Who "me" is: evidence, episodes, and new search indexing label the owner's
// messages with this name. Historical search rows update on the next reindex.
app.post("/api/brain/owner", async (req, res) => {
  try {
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : null;
    await repository.setArchiveOwnerName(displayName);
    res.json({ ok: true, ownerName: await repository.getArchiveOwnerName() });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Provider control from the UI: opt-in/out, model selection, health probe.
app.post("/api/brain/provider", async (req, res) => {
  try {
    const { disableBrainProvider, enableBrainProvider, getBrainProviderStatus, probeBrainProvider, setBrainProviderModel } =
      await import("./brain/provider");
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    const provider = req.body?.provider === "claude-cli" || req.body?.provider === "codex" ? req.body.provider : null;
    if (action === "enable" && provider) {
      res.json({ ok: true, provider: enableBrainProvider(provider) });
    } else if (action === "disable") {
      res.json({ ok: true, provider: disableBrainProvider() });
    } else if (action === "set-model" && provider && typeof req.body?.model === "string") {
      res.json({ ok: true, provider: setBrainProviderModel(provider, req.body.model) });
    } else if (action === "probe") {
      const probe = await probeBrainProvider();
      res.json({ ok: probe.ok, provider: probe.status });
    } else if (action === "status" || action === "") {
      res.json({ ok: true, provider: getBrainProviderStatus() });
    } else {
      res.status(400).json({ error: "Unknown provider action." });
    }
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/search/reindex", async (_req, res) => {
  try {
    const reindex = startSearchReindex(repository, () => {
      broadcastArchiveChanged({ source: "manual", chatSourceIds: [], messageCount: 0, contactCount: 0 });
    });
    res.json({ ok: true, reindex });
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Local-only media serving (the whole app binds to loopback). Streams original
// blobs with HTTP range support for audio/video scrubbing. Content-addressed
// blobs are immutable, so aggressive private caching is safe. No media paths
// or bytes are logged.
app.get("/api/media/assets/:id", async (req, res) => {
  try {
    const asset = await repository.getMediaAsset(Number(req.params.id));
    if (!asset) {
      res.status(404).json({ error: "Media asset was not found." });
      return;
    }
    const stat = await mediaBlobStore.stat(asset.storagePath);
    if (!stat) {
      res.status(404).json({ error: "Media bytes are not present in the local store." });
      return;
    }
    const totalSize = stat.byteSize;
    res.setHeader("Content-Type", asset.mimeType ?? "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("ETag", `"${asset.sha256}"`);
    const range = parseRangeHeader(req.headers.range, totalSize);
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
      mediaBlobStore.openStream(asset.storagePath, range).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(totalSize));
    mediaBlobStore.openStream(asset.storagePath).pipe(res);
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/media/assets/:id/thumbnail", async (req, res) => {
  try {
    const asset = await repository.getMediaAsset(Number(req.params.id));
    if (!asset?.thumbnail?.length) {
      res.status(404).json({ error: "No thumbnail is stored for this asset." });
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.end(Buffer.from(asset.thumbnail));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/messages/:id/link-preview-thumbnail", async (req, res) => {
  try {
    const thumbnail = await repository.getLinkPreviewThumbnail(Number(req.params.id));
    if (!thumbnail?.length) {
      res.status(404).json({ error: "No link preview thumbnail is stored for this message." });
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.end(Buffer.from(thumbnail));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.get("/api/messages/:id/revisions", async (req, res) => {
  try {
    res.json(await repository.listMessageEditRevisions(Number(req.params.id)));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

// Retry control for stuck media downloads (failed/expired with a descriptor
// still held); counts only in the response, never content.
app.post("/api/media/retry", async (_req, res) => {
  try {
    const requeued = await repository.retryStuckMediaDownloads();
    res.json({ ok: true, requeued, media: await repository.getMediaQueueSummary() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

const distDir = path.resolve(__dirname, "../../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// Correct stale connected/running state from a previous process before any
// client can read live status, and clear pre-rewrite wall-clock gap noise even
// when no live session can connect.
try {
  const reconciled = await repository.reconcileLiveState();
  if (reconciled.staleSessions || reconciled.staleRuns) {
    console.log(`Reconciled stale live state: ${reconciled.staleSessions} session(s), ${reconciled.staleRuns} run(s).`);
  }
  const orphanedBrainRuns = await repository.reconcileBrainRuns();
  if (orphanedBrainRuns > 0) {
    console.log(`[brain] marked ${orphanedBrainRuns} orphaned run(s) interrupted (watermarks make interruption safe).`);
  }
  const legacyClosed = await closeLegacyWallClockGaps(repository);
  if (legacyClosed) {
    console.log(`Closed ${legacyClosed} legacy wall-clock live gap(s) superseded by evidence-based auditing.`);
  }
  // Recompute chat recency under the current visibility rules (fast, and keeps
  // archives created before rule changes correctly ordered).
  await repository.refreshChatStats();
  const clearedNames = await repository.clearIdentityDerivedChatNames();
  if (clearedNames) {
    console.log(`Cleared ${clearedNames} identity-derived chat name(s); they will resolve via contacts or the group-naming pass.`);
  }
  const noiseRemoved = await repository.removeProtocolNoiseMessages();
  if (noiseRemoved) {
    console.log(`Removed ${noiseRemoved} Signal-protocol transport envelope(s) archived as messages before normalization filtered them.`);
  }
} catch (error) {
  console.warn(`Live state reconciliation skipped: ${publicErrorMessage(error)}`);
}

app.listen(config.app.port, config.app.host, () => {
  console.log(`Wapp Brain listening on http://${config.app.host}:${config.app.port}`);
  void autoResumeLiveSync();
});

async function autoResumeLiveSync(): Promise<void> {
  if (!config.live.autoResume) {
    return;
  }
  try {
    const options = liveOptionsFromConfig();
    if (!fs.existsSync(path.join(options.authDir, "creds.json"))) {
      return;
    }
    const live = await repository.getLiveStatus();
    const sessionStatus = live.session?.status ?? "not_configured";
    if (sessionStatus === "not_configured" || sessionStatus === "logged_out") {
      return;
    }
    // Never QR-churn in the background: if the stored credentials are corrupt
    // or unpaired (and the backup cannot restore them), surface a re-link
    // action instead of silently pretending to resume.
    if (!(await ensureUsableLiveCreds(options.authDir))) {
      await repository.upsertLiveSession({
        id: "default",
        status: "logged_out",
        clientName: options.clientName,
        lastError: "Stored linked-device credentials are missing or corrupted. Re-link WhatsApp to resume live sync."
      });
      console.warn("Live auto-resume skipped: stored credentials are unusable; re-link WhatsApp from the app.");
      return;
    }
    console.log("Auto-resuming live WhatsApp sync from existing linked-device credentials.");
    await startLiveMaintainer(null);
  } catch (error) {
    console.warn(`Live auto-resume failed: ${publicErrorMessage(error)}`);
  }
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanQuery(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function optionalNumberQuery(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Single-range parser for media scrubbing ("bytes=start-end", open ends
// supported). Malformed or unsatisfiable ranges fall back to a full response.
function parseRangeHeader(header: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!header || totalSize <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }
  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix range: last N bytes.
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? totalSize - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

function pickKind(value: unknown): PickKind {
  if (value === "backup-root" || value === "media" || value === "msgstore" || value === "wa") {
    return value;
  }
  throw new Error("Unsupported picker kind.");
}

async function startLiveMaintainer(phoneNumber: string | null): Promise<void> {
  if (activeMaintainer) {
    return;
  }
  const options = liveOptionsFromConfig();
  livePairing = {
    state: "starting",
    qrDataUrl: null,
    pairingCode: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastError: null
  };
  activeClient = new BaileysLiveWhatsAppClient({
    authDir: options.authDir,
    phoneNumber,
    readOnly: true
  });
  activeClient.onConnectionUpdate((update) => {
    livePairing = {
      ...livePairing,
      state:
        update.state === "pairing" ||
        update.state === "connected" ||
        update.state === "disconnected" ||
        update.state === "stopped" ||
        update.state === "error" ||
        update.state === "logged_out"
          ? update.state
          : "pairing",
      qrDataUrl: update.qrDataUrl ?? livePairing.qrDataUrl,
      pairingCode: update.pairingCode ?? livePairing.pairingCode,
      updatedAt: new Date().toISOString(),
      expiresAt: update.state === "pairing" ? new Date(Date.now() + 60_000).toISOString() : livePairing.expiresAt,
      lastError: update.lastError ?? null
    };
  });
  activeMaintainer = new LiveMaintainer(repository, activeClient, options, {
    onArchiveChanged: (event) => {
      broadcastArchiveChanged({
        source: "live",
        chatSourceIds: chatSourceIdsFromLiveEvent(event),
        messageCount: event.messages?.length ?? 0,
        contactCount: event.contacts?.length ?? 0
      });
    },
    onMediaChanged: (chatSourceIds) => {
      broadcastArchiveChanged({ source: "live", chatSourceIds, messageCount: 0, contactCount: 0 });
    }
  });
  void activeMaintainer.start().catch(async (error: unknown) => {
    livePairing = {
      ...livePairing,
      state: "error",
      updatedAt: new Date().toISOString(),
      lastError: publicErrorMessage(error)
    };
    await activeMaintainer?.fail(error);
    activeMaintainer = null;
    activeClient = null;
  });
}

async function stopActiveMaintainer(): Promise<void> {
  if (!activeMaintainer) {
    activeClient = null;
    return;
  }
  const maintainer = activeMaintainer;
  activeMaintainer = null;
  activeClient = null;
  await maintainer.stop();
  livePairing = {
    ...livePairing,
    state: "stopped",
    updatedAt: new Date().toISOString()
  };
}

function numberBody(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function broadcastArchiveChanged(input: Omit<ArchiveChangeEvent, "id" | "type" | "updatedAt">): void {
  const event: ArchiveChangeEvent = {
    id: ++archiveEventId,
    type: "archive-updated",
    updatedAt: new Date().toISOString(),
    ...input,
    chatSourceIds: [...new Set(input.chatSourceIds)]
  };
  const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of archiveEventClients) {
    client.write(payload);
  }
}

function chatSourceIdsFromLiveEvent(event: LiveMessageEvent): string[] {
  return [
    ...(event.chats ?? []).map((chat) => chat.sourceChatId),
    ...(event.messages ?? []).map((message) => message.chatSourceId),
    ...(event.updates ?? []).map((update) => update.chatSourceId),
    ...(event.contacts ?? []).map((contact) => contact.sourceJid)
  ].filter(Boolean);
}

function idlePairing(): LivePairingSummary {
  return {
    state: "idle",
    qrDataUrl: null,
    pairingCode: null,
    startedAt: null,
    updatedAt: null,
    expiresAt: null,
    lastError: null
  };
}
