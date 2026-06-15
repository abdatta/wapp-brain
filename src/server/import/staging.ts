import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { config } from "../config";
import { ensureManagedWorkDir } from "../cleanup";
import type { ArchiveRepository } from "../db/repository";
import { prepareMsgstore } from "./decrypt";
import { openReadableSQLite } from "./sqlite";
import { runImport } from "./importer";
import { ImportTerminalProgress } from "./progress";
import { PublicError, publicErrorMessage, safeBasename } from "../privacy";
import type {
  ImportJobSummary,
  ImportMode,
  ImportProgressEvent,
  ImportRequest,
  ImportStagingFileKind,
  ImportStagingFileSummary,
  ImportStagingSessionSummary,
  ImportVerificationSummary
} from "../../shared/types";

interface StagedFile extends ImportStagingFileSummary {
  path: string;
}

interface ImportStagingSession {
  id: string;
  createdAt: string;
  root: string;
  files: Partial<Record<ImportStagingFileKind, StagedFile>>;
}

interface StartImportJobInput {
  sessionId?: string | null;
  mode: ImportMode;
  key?: string | null;
  keepDecrypted?: boolean;
  paths?: Partial<Pick<ImportRequest, "msgstorePath" | "waPath" | "mediaPath" | "keyPath">>;
}

interface ImportJobState extends ImportJobSummary {
  abortController: AbortController;
  terminalProgress: ImportTerminalProgressLike | null;
  lastFileLogAt: number;
  lastMessageLogAt: number;
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

const sessions = new Map<string, ImportStagingSession>();
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

export async function createImportStagingSession(): Promise<ImportStagingSessionSummary> {
  await ensureManagedWorkDir();
  const id = crypto.randomUUID();
  const root = path.resolve(config.workDir, "import-staging", id);
  await mkdir(root, { recursive: true });
  const session: ImportStagingSession = {
    id,
    createdAt: new Date().toISOString(),
    root,
    files: {}
  };
  sessions.set(id, session);
  return publicSession(session);
}

export async function stageImportFile(
  sessionId: string,
  kind: ImportStagingFileKind,
  fileName: string,
  source: Readable,
  relativePath?: string | null
): Promise<ImportStagingSessionSummary> {
  const session = requireSession(sessionId);
  const safeName = sanitizeFileName(fileName || `${kind}.bin`);
  const target =
    kind === "media"
      ? path.join(session.root, "media", sanitizeRelativePath(relativePath ?? safeName))
      : path.join(session.root, `${kind}-${safeName}`);
  assertWithin(session.root, target);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(source, createWriteStream(target, { flags: "w" }));
  const size = (await stat(target)).size;
  if (kind === "media") {
    const current = session.files.media;
    session.files.media = {
      kind,
      name: current?.name ?? "Selected media folder",
      size: (current?.size ?? 0) + size,
      stagedAt: new Date().toISOString(),
      path: path.join(session.root, "media")
    };
  } else {
    session.files[kind] = {
      kind,
      name: safeName,
      size,
      stagedAt: new Date().toISOString(),
      path: target
    };
  }
  return publicSession(session);
}

export function getImportStagingSession(sessionId: string): ImportStagingSessionSummary {
  return publicSession(requireSession(sessionId));
}

export async function cancelImportStagingSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await rm(session.root, { recursive: true, force: true });
}

export async function verifyImportKey(input: {
  sessionId?: string | null;
  msgstorePath?: string | null;
  key?: string | null;
  keyPath?: string | null;
  useStagedKey?: boolean;
}): Promise<ImportVerificationSummary> {
  const session = input.sessionId ? requireSession(input.sessionId) : null;
  const msgstorePath = session?.files.msgstore?.path ?? input.msgstorePath;
  const keyPath = input.useStagedKey ? session?.files.key?.path : input.keyPath;
  if (!msgstorePath) {
    throw new PublicError("IMPORT_VERIFY_MISSING_BACKUP", "Select a msgstore backup before verifying the key.");
  }
  const encrypted = /\.crypt15$/i.test(msgstorePath);
  if (!encrypted) {
    const db = openReadableSQLite(msgstorePath, "msgstore");
    db.close();
    return { ok: true, encrypted: false, message: "Plain SQLite msgstore opened successfully. No backup key is required." };
  }
  const verifyDir = path.join(session?.root ?? path.resolve(config.workDir, "import-staging", "manual"), "verify");
  await mkdir(verifyDir, { recursive: true });
  let prepared: Awaited<ReturnType<typeof prepareMsgstore>> | null = null;
  try {
    prepared = await prepareMsgstore({
      encryptedPath: msgstorePath,
      key: input.key ?? null,
      keyPath: keyPath ?? null,
      outputDir: verifyDir,
      keepDecrypted: false
    });
    const db = openReadableSQLite(prepared.sqlitePath, "decrypted msgstore");
    db.close();
    return { ok: true, encrypted: true, message: "Backup key verified locally against the encrypted backup." };
  } finally {
    await prepared?.cleanup();
    await rm(verifyDir, { recursive: true, force: true });
  }
}

export function startImportJob(repository: ArchiveRepository, input: StartImportJobInput): ImportJobSummary {
  const active = findActiveJob();
  if (active) {
    throw new PublicError("IMPORT_JOB_ACTIVE", "An import is already running. Reopen the progress screen to monitor or stop it.");
  }
  const session = input.sessionId ? requireSession(input.sessionId) : null;
  const request: ImportRequest = {
    msgstorePath: session?.files.msgstore?.path ?? input.paths?.msgstorePath ?? "",
    waPath: session?.files.wa?.path ?? input.paths?.waPath ?? null,
    mediaPath: session?.files.media?.path ?? input.paths?.mediaPath ?? null,
    key: input.key ?? null,
    keyPath: session?.files.key?.path ?? input.paths?.keyPath ?? null,
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
    lastMessageLogAt: 0
  };
  jobs.set(job.id, job);
  void runJob(repository, job, request, session?.id ?? null);
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

async function runJob(repository: ArchiveRepository, job: ImportJobState, request: ImportRequest, sessionId: string | null): Promise<void> {
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
    logJob(job, "info", `completed messages=${totals.messages.toLocaleString()} warnings=${totals.warnings.toLocaleString()}`);
    if (sessionId) {
      await cancelImportStagingSession(sessionId);
    }
  } catch (error) {
    await restorePoint?.restore();
    job.status = isCancellation(error, job) ? "cancelled" : "failed";
    job.finishedAt = new Date().toISOString();
    job.error = job.status === "cancelled" ? "Import stopped. The local archive was rolled back to its previous state." : publicErrorMessage(error);
    if (job.status === "cancelled") {
      job.terminalProgress?.stop(job.error);
    } else {
      job.terminalProgress?.fail(job.error);
    }
    logJob(job, job.status === "cancelled" ? "warn" : "error", job.error);
    if (sessionId) {
      await cancelImportStagingSession(sessionId);
    }
  } finally {
    await restorePoint?.dispose();
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

function requireSession(sessionId: string): ImportStagingSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new PublicError("IMPORT_SESSION_MISSING", "Import staging session was not found.");
  }
  return session;
}

function publicSession(session: ImportStagingSession): ImportStagingSessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt,
    files: Object.fromEntries(
      Object.entries(session.files).map(([kind, file]) => [
        kind,
        file
          ? {
              kind: file.kind,
              name: file.name,
              size: file.size,
              stagedAt: file.stagedAt
            }
          : undefined
      ])
    ) as ImportStagingSessionSummary["files"]
  };
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

function sanitizeFileName(value: string): string {
  return (safeBasename(value) ?? "selected-file").replace(/[^A-Za-z0-9_. -]/g, "_").slice(0, 120) || "selected-file";
}

function sanitizeRelativePath(value: string): string {
  return value
    .split(/[\\/]+/)
    .map((part) => sanitizeFileName(part))
    .filter(Boolean)
    .join(path.sep);
}

function assertWithin(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PublicError("IMPORT_STAGING_UNSAFE_PATH", "Selected file could not be staged safely.");
  }
}
