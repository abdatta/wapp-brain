import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { cleanupSensitiveWorkDirs } from "./cleanup";
import { createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { BaileysLiveWhatsAppClient } from "./live/baileysClient";
import { runImport } from "./import/importer";
import {
  cancelImportJob,
  cancelImportStagingSession,
  createImportStagingSession,
  getCurrentImportJob,
  getImportJob,
  getImportStagingSession,
  stageImportFile,
  startImportJob,
  verifyImportKey
} from "./import/staging";
import { assertLiveBaselineReady } from "./live/baseline";
import { liveOptionsFromConfig } from "./live/maintainer";
import { LiveMaintainer } from "./live/maintainer";
import { isLocalDatabaseError, publicErrorMessage } from "./privacy";
import { withGuidedSetup } from "./onboarding";
import type { LivePairingSummary } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const repository = createArchiveRepository();
let activeMaintainer: LiveMaintainer | null = null;
let activeClient: BaileysLiveWhatsAppClient | null = null;
let livePairing: LivePairingSummary = idlePairing();

app.get("/api/status", async (_req, res) => {
  try {
    res.json(withGuidedSetup(await repository.getStatus()));
  } catch {
    res.json(withGuidedSetup({
      database: {
        configured: true,
        initialized: false,
        adapter: config.archive.adapter,
        error: "Local archive database is not initialized or not reachable."
      },
      counts: { chats: 0, contacts: 0, participants: 0, messages: 0, warnings: 0 },
      latestImport: null,
      latestWarnings: []
    }));
  }
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
    await assertLiveBaselineReady(repository, config.live.maxBackfillPerChatDays);
    const phoneNumber = typeof req.body?.phoneNumber === "string" && req.body.phoneNumber.trim() ? req.body.phoneNumber.trim() : null;
    await startLiveMaintainer(phoneNumber);
    res.json({ ok: true, pairing: livePairing, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/live/resume", async (_req, res) => {
  try {
    await assertLiveBaselineReady(repository, config.live.maxBackfillPerChatDays);
    await startLiveMaintainer(null);
    res.json({ ok: true, pairing: livePairing, live: await repository.getLiveStatus() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/live/pairing", (_req, res) => {
  res.json(livePairing);
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
      keyPath: req.body?.keyPath ? String(req.body.keyPath) : null,
      keepDecrypted: Boolean(req.body?.keepDecrypted),
      mode: req.body?.mode === "replace" ? "replace" : "merge"
    });
    res.json({ ok: true, totals });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/staging", async (_req, res) => {
  try {
    res.json({ ok: true, session: await createImportStagingSession() });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.get("/api/import/staging/:sessionId", (req, res) => {
  try {
    res.json(getImportStagingSession(req.params.sessionId));
  } catch (error) {
    res.status(400).json({ error: publicErrorMessage(error) });
  }
});

app.post("/api/import/staging/:sessionId/:kind", async (req, res) => {
  try {
    const kind = importFileKind(req.params.kind);
    const fileName = stringQuery(req.query.name) ?? `${kind}.bin`;
    const relativePath = stringQuery(req.query.relativePath);
    const session = await stageImportFile(req.params.sessionId, kind, fileName, req, relativePath);
    res.json({ ok: true, session });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.delete("/api/import/staging/:sessionId", async (req, res) => {
  try {
    await cancelImportStagingSession(req.params.sessionId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/verify-key", async (req, res) => {
  try {
    res.json({
      ok: true,
      verification: await verifyImportKey({
        sessionId: req.body?.sessionId ? String(req.body.sessionId) : null,
        msgstorePath: req.body?.msgstorePath ? String(req.body.msgstorePath) : null,
        key: req.body?.key ? String(req.body.key) : null,
        keyPath: req.body?.keyPath ? String(req.body.keyPath) : null,
        useStagedKey: Boolean(req.body?.useStagedKey)
      })
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicErrorMessage(error) });
  }
});

app.post("/api/import/jobs", async (req, res) => {
  try {
    res.json({
      ok: true,
      job: startImportJob(repository, {
        sessionId: req.body?.sessionId ? String(req.body.sessionId) : null,
        mode: req.body?.mode === "replace" ? "replace" : "merge",
        key: req.body?.key ? String(req.body.key) : null,
        keepDecrypted: Boolean(req.body?.keepDecrypted),
        paths: {
          msgstorePath: req.body?.paths?.msgstorePath ? String(req.body.paths.msgstorePath) : undefined,
          waPath: req.body?.paths?.waPath ? String(req.body.paths.waPath) : undefined,
          mediaPath: req.body?.paths?.mediaPath ? String(req.body.paths.mediaPath) : undefined,
          keyPath: req.body?.paths?.keyPath ? String(req.body.paths.keyPath) : undefined
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

const distDir = path.resolve(__dirname, "../../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(config.app.port, config.app.host, () => {
  console.log(`Wapp Brain listening on http://${config.app.host}:${config.app.port}`);
});

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

function importFileKind(value: string) {
  if (value === "msgstore" || value === "wa" || value === "media" || value === "key") {
    return value;
  }
  throw new Error("Unsupported import file kind.");
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
      state: update.state === "pairing" || update.state === "connected" || update.state === "disconnected" || update.state === "stopped" || update.state === "error" ? update.state : "pairing",
      qrDataUrl: update.qrDataUrl ?? livePairing.qrDataUrl,
      pairingCode: update.pairingCode ?? livePairing.pairingCode,
      updatedAt: new Date().toISOString(),
      expiresAt: update.state === "pairing" ? new Date(Date.now() + 60_000).toISOString() : livePairing.expiresAt,
      lastError: update.lastError ?? null
    };
  });
  activeMaintainer = new LiveMaintainer(repository, activeClient, options);
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
