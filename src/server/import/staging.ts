import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { ensureManagedWorkDir } from "../cleanup";
import type { ArchiveRepository } from "../db/repository";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { prepareMsgstore, prepareSidecarDatabase } from "./decrypt";
import { openReadableSQLite } from "./sqlite";
import { runImport } from "./importer";
import { ImportTerminalProgress } from "./progress";
import { PublicError, publicErrorMessage } from "../privacy";
import type {
  ImportJobSummary,
  ImportMode,
  ImportProgressEvent,
  ImportRequest,
  ImportVerificationSummary
} from "../../shared/types";

// Inputs are read in place from disk (the native picker / typed paths resolve to
// absolute paths). Nothing is uploaded or copied into the app; the only staged
// artifacts are the importer's decrypted intermediates under the work dir.
interface StartImportJobInput {
  mode: ImportMode;
  key?: string | null;
  keepDecrypted?: boolean;
  paths: Partial<Pick<ImportRequest, "msgstorePath" | "waPath" | "mediaPath">>;
}

interface StartImportJobCallbacks {
  onArchiveChanged?: (summary: { source: "import"; messageCount: number; contactCount: number }) => void | Promise<void>;
}

interface ImportJobState extends ImportJobSummary {
  abortController: AbortController;
  terminalProgress: ImportTerminalProgressLike | null;
  lastFileLogAt: number;
  lastMessageLogAt: number;
  lastMediaLogAt: number;
}

interface ImportTerminalProgressLike {
  handle(event: ImportProgressEvent): void;
  fail(message: string): void;
  stop(message?: string): void;
}

interface ImportJobLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const jobs = new Map<string, ImportJobState>();
const MAX_RETAINED_EVENTS = 80;
const PROGRESS_LOG_INTERVAL_MS = 5000;
let importJobLogger: ImportJobLogger = console;
let createImportTerminalProgress = (label: string): ImportTerminalProgressLike => new ImportTerminalProgress(label);

export function setImportJobLoggerForTests(logger: ImportJobLogger): () => void {
  const previous = importJobLogger;
  importJobLogger = logger;
  return () => {
    importJobLogger = previous;
  };
}

export function setImportTerminalProgressFactoryForTests(factory: (label: string) => ImportTerminalProgressLike): () => void {
  const previous = createImportTerminalProgress;
  createImportTerminalProgress = factory;
  return () => {
    createImportTerminalProgress = previous;
  };
}

// Verifies the text key locally against the detected msgstore (and optional
// contacts DB), reading the files in place. Key files are not accepted.
export async function verifyImportKey(input: {
  msgstorePath?: string | null;
  waPath?: string | null;
  key?: string | null;
}): Promise<ImportVerificationSummary> {
  const msgstorePath = input.msgstorePath;
  const waPath = input.waPath;
  if (!msgstorePath) {
    throw new PublicError("IMPORT_VERIFY_MISSING_BACKUP", "Select a msgstore backup before verifying the key.");
  }
  const encryptedInputs = [
    { path: msgstorePath, label: "msgstore" },
    ...(waPath ? [{ path: waPath, label: "contacts database" }] : [])
  ].filter((inputFile) => /\.crypt15$/i.test(inputFile.path));
  const plaintextInputs = [
    { path: msgstorePath, label: "msgstore" },
    ...(waPath ? [{ path: waPath, label: "wa.db" }] : [])
  ].filter((inputFile) => !/\.crypt15$/i.test(inputFile.path));
  if (encryptedInputs.length === 0) {
    openPlaintextInputs(plaintextInputs);
    return { ok: true, encrypted: false, message: "Plain SQLite databases opened successfully. No backup key is required." };
  }
  await ensureManagedWorkDir();
  const verifyDir = path.resolve(config.workDir, "import-verify", crypto.randomUUID());
  await mkdir(verifyDir, { recursive: true });
  const prepared: Array<Awaited<ReturnType<typeof prepareMsgstore>>> = [];
  try {
    for (const inputFile of encryptedInputs) {
      const next =
        inputFile.label === "msgstore"
          ? await prepareMsgstore({
              encryptedPath: inputFile.path,
              key: input.key ?? null,
              outputDir: verifyDir,
              keepDecrypted: false
            })
          : await prepareSidecarDatabase({
              encryptedPath: inputFile.path,
              key: input.key ?? null,
              outputDir: verifyDir,
              keepDecrypted: false,
              label: inputFile.label,
              outputPrefix: "wa"
            });
      prepared.push(next);
      const db = openReadableSQLite(next.sqlitePath, `decrypted ${inputFile.label}`);
      db.close();
    }
    openPlaintextInputs(plaintextInputs);
    const labels = encryptedInputs.map((inputFile) => inputFile.label).join(" and ");
    return { ok: true, encrypted: true, message: `Backup key verified locally against the encrypted ${labels}.` };
  } finally {
    await Promise.all(prepared.map((result) => result.cleanup()));
    await rm(verifyDir, { recursive: true, force: true });
  }
}

export function startImportJob(repository: ArchiveRepository, input: StartImportJobInput, callbacks: StartImportJobCallbacks = {}): ImportJobSummary {
  const active = findActiveJob();
  if (active) {
    throw new PublicError("IMPORT_JOB_ACTIVE", "An import is already running. Reopen the progress screen to monitor or stop it.");
  }
  const request: ImportRequest = {
    msgstorePath: input.paths.msgstorePath ?? "",
    waPath: input.paths.waPath ?? null,
    mediaPath: input.paths.mediaPath ?? null,
    key: input.key ?? null,
    keepDecrypted: Boolean(input.keepDecrypted),
    mode: input.mode
  };
  const job: ImportJobState = {
    id: crypto.randomUUID(),
    status: "queued",
    mode: input.mode,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    events: [],
    totals: null,
    error: null,
    abortController: new AbortController(),
    terminalProgress: shouldShowTerminalProgress() ? createImportTerminalProgress("Starting UI import.") : null,
    lastFileLogAt: 0,
    lastMessageLogAt: 0,
    lastMediaLogAt: 0
  };
  jobs.set(job.id, job);
  void runJob(repository, job, request, callbacks);
  return publicJob(job);
}

export function getImportJob(jobId: string): ImportJobSummary {
  const job = jobs.get(jobId);
  if (!job) {
    throw new PublicError("IMPORT_JOB_MISSING", "Import job was not found.");
  }
  return publicJob(job);
}

export function getCurrentImportJob(): ImportJobSummary | null {
  const active = findActiveJob();
  if (active) {
    return publicJob(active);
  }
  const latest = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest && (latest.status === "failed" || latest.status === "cancelled") ? publicJob(latest) : null;
}

export function cancelImportJob(jobId: string): ImportJobSummary {
  const job = jobs.get(jobId);
  if (!job) {
    throw new PublicError("IMPORT_JOB_MISSING", "Import job was not found.");
  }
  if (job.status !== "queued" && job.status !== "running" && job.status !== "cancelling") {
    throw new PublicError("IMPORT_JOB_NOT_RUNNING", "This import is no longer running.");
  }
  if (job.status !== "cancelling") {
    job.status = "cancelling";
    job.error = "Stopping import and rolling back local archive changes.";
    job.abortController.abort();
    logJob(job, "warn", "stop requested; rolling back local archive changes");
  }
  return publicJob(job);
}

async function runJob(
  repository: ArchiveRepository,
  job: ImportJobState,
  request: ImportRequest,
  callbacks: StartImportJobCallbacks
): Promise<void> {
  let restorePoint: Awaited<ReturnType<ArchiveRepository["createRestorePoint"]>> | null = null;
  try {
    restorePoint = await repository.createRestorePoint(`import-${job.id}`);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    logJob(job, "info", `started mode=${job.mode}`);
    throwIfCancelled(job);
    if (request.mode === "replace") {
      pushEvent(job, { type: "step", step: "validating", message: "Clearing existing archive data for replacement import." });
      await repository.clearArchiveData();
    }
    throwIfCancelled(job);
    const totals = await runImport(repository, request, {
      onProgress: (event) => pushEvent(job, event),
      signal: job.abortController.signal
    });
    throwIfCancelled(job);
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.totals = totals;
    await configuredTraceRecorder?.snapshotArchive(`after-import-job-${job.id}`, config.archive.sqlitePath);
    await callbacks.onArchiveChanged?.({ source: "import", messageCount: totals.messages, contactCount: totals.contacts });
    logJob(job, "info", `completed messages=${totals.messages.toLocaleString()} warnings=${totals.warnings.toLocaleString()}`);
  } catch (error) {
    // A legacy-gate refusal happens before anything is written; skip the
    // (expensive) full-archive rollback in that case.
    if (!(error instanceof PublicError && error.code === "ARCHIVE_LEGACY_IDENTITY")) {
      await restorePoint?.restore();
    }
    job.status = isCancellation(error, job) ? "cancelled" : "failed";
    job.finishedAt = new Date().toISOString();
    job.error = job.status === "cancelled" ? "Import stopped. The local archive was rolled back to its previous state." : publicErrorMessage(error);
    if (job.status === "cancelled") {
      job.terminalProgress?.stop(job.error);
    } else {
      job.terminalProgress?.fail(job.error);
    }
    logJob(job, job.status === "cancelled" ? "warn" : "error", job.error);
  } finally {
    await restorePoint?.dispose();
  }
}

function openPlaintextInputs(inputs: Array<{ path: string; label: string }>): void {
  for (const input of inputs) {
    const db = openReadableSQLite(input.path, input.label);
    db.close();
  }
}

function pushEvent(job: ImportJobSummary, event: ImportProgressEvent): void {
  job.events.push(event);
  if (job.events.length > MAX_RETAINED_EVENTS) {
    retainProgressMilestones(job.events);
  }
  if (event.type === "complete") {
    job.totals = event.totals;
  }
  (job as Partial<ImportJobState>).terminalProgress?.handle(event);
  logProgressEvent(job, event);
}

function retainProgressMilestones(events: ImportProgressEvent[]): void {
  const recent = new Set(events.slice(-MAX_RETAINED_EVENTS));
  for (const type of ["step", "file-progress", "message-progress", "warnings", "complete"] as const) {
    const latest = [...events].reverse().find((event) => event.type === type);
    if (latest) {
      recent.add(latest);
    }
  }
  events.splice(
    0,
    events.length,
    ...events.filter((event) => recent.has(event))
  );
}

function publicJob(job: ImportJobSummary): ImportJobSummary {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: [...job.events],
    totals: job.totals,
    error: job.error
  };
}

function findActiveJob(): ImportJobState | null {
  return [...jobs.values()].find((job) => job.status === "queued" || job.status === "running" || job.status === "cancelling") ?? null;
}

function throwIfCancelled(job: ImportJobState): void {
  if (job.abortController.signal.aborted) {
    throw new PublicError("IMPORT_CANCELLED", "Import stopped by user request.");
  }
}

function isCancellation(error: unknown, job: ImportJobState): boolean {
  return job.abortController.signal.aborted || (error instanceof PublicError && error.code === "IMPORT_CANCELLED");
}

function shouldShowTerminalProgress(): boolean {
  if (process.env.WAPP_IMPORT_PROGRESS === "off" || process.env.WAPP_IMPORT_PROGRESS === "0" || process.env.CI) {
    return false;
  }
  if (process.env.WAPP_IMPORT_PROGRESS === "bars") {
    return true;
  }
  return Boolean(process.stderr.isTTY) || process.env.npm_lifecycle_event === "server" || process.env.npm_lifecycle_event === "dev:server";
}

function logProgressEvent(job: ImportJobSummary, event: ImportProgressEvent): void {
  switch (event.type) {
    case "step":
      logJob(job, "info", `step=${event.step} ${event.message}`);
      return;
    case "file-progress": {
      const state = job as Partial<ImportJobState>;
      const now = Date.now();
      const done = event.processedBytes >= event.totalBytes;
      if (!done && state.lastFileLogAt && now - state.lastFileLogAt < PROGRESS_LOG_INTERVAL_MS) {
        return;
      }
      state.lastFileLogAt = now;
      logJob(
        job,
        "info",
        `${event.phase} ${formatBytes(event.processedBytes)} / ${formatBytes(event.totalBytes)} (${progressPercent(event.processedBytes, event.totalBytes)}%)`
      );
      return;
    }
    case "message-progress": {
      const state = job as Partial<ImportJobState>;
      const now = Date.now();
      const done = event.totalMessages != null && event.processedMessages >= event.totalMessages;
      if (!done && state.lastMessageLogAt && now - state.lastMessageLogAt < PROGRESS_LOG_INTERVAL_MS) {
        return;
      }
      state.lastMessageLogAt = now;
      const total = event.totalMessages == null ? "unknown" : event.totalMessages.toLocaleString();
      logJob(
        job,
        "info",
        `messages processed=${event.processedMessages.toLocaleString()} persisted=${event.persistedMessages.toLocaleString()} total=${total}`
      );
      return;
    }
    case "media-progress": {
      const state = job as Partial<ImportJobState>;
      const now = Date.now();
      const done = event.totalRefs != null && event.processedRefs >= event.totalRefs;
      if (!done && state.lastMediaLogAt && now - state.lastMediaLogAt < PROGRESS_LOG_INTERVAL_MS) {
        return;
      }
      state.lastMediaLogAt = now;
      const total = event.totalRefs == null ? "unknown" : event.totalRefs.toLocaleString();
      logJob(
        job,
        "info",
        `media processed=${event.processedRefs.toLocaleString()} matched=${event.matchedRefs.toLocaleString()} copied=${event.copiedAssets.toLocaleString()} missing=${event.missingRefs.toLocaleString()} total=${total}`
      );
      return;
    }
    case "warnings":
      if (event.count > 0) {
        logJob(job, "warn", `warnings count=${event.count.toLocaleString()} codes=${event.codes.join(",")}`);
      }
      return;
    case "complete":
      return;
  }
}

function logJob(job: ImportJobSummary, level: keyof ImportJobLogger, message: string): void {
  importJobLogger[level](`[import:${job.id.slice(0, 8)}] ${message}`);
}

function progressPercent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units.shift() ?? "KB";
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift() ?? unit;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
