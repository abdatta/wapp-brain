import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import * as cliProgress from "cli-progress";
import ora, { type Ora } from "ora";
import { cleanupDecryptedWorkDir } from "./cleanup";
import { config } from "./config";
import { archiveAdapterLabel, createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { SqliteArchiveRepository } from "./db/sqliteRepository";
import { runDoctor } from "./doctor";
import { inspectArchive } from "./import/inspect";
import { runImport } from "./import/importer";
import { createSyntheticFixture } from "./import/fixtures";
import type { ImportProgressEvent } from "./import/progress";
import { publicErrorMessage, redactForDisplay, safeBasename } from "./privacy";

type Args = Record<string, string | boolean>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "init-db") {
    await initializeArchiveDatabase();
    console.log(`${archiveAdapterLabel()} archive initialized.`);
    return;
  }

  if (command === "doctor") {
    const checks = await runDoctor();
    for (const check of checks) {
      const label = check.status.toUpperCase().padEnd(4, " ");
      console.log(`${label} ${check.name}: ${check.message}`);
    }
    if (checks.some((check) => check.status === "fail")) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "cleanup") {
    const summary = await cleanupDecryptedWorkDir();
    console.log(
      `Cleanup complete: removed_files=${summary.removedFiles} removed_directories=${summary.removedDirectories}`
    );
    return;
  }

  if (command === "generate-fixtures") {
    const dir = String(args.dir ?? args._ ?? "fixtures/generated/basic");
    const fixture = await createSyntheticFixture(path.resolve(dir), {
      large: Boolean(args.large),
      manyChats: numberArg(args["many-chats"]),
      missingOptional: Boolean(args["missing-optional"]),
      privacyCanary: Boolean(args["privacy-canary"])
    });
    console.log(`Synthetic fixture created: ${path.basename(fixture.directory)}`);
    console.log(`msgstore: ${fixture.msgstorePath}`);
    console.log(`wa: ${fixture.waPath}`);
    return;
  }

  if (command === "inspect") {
    const msgstorePath = stringArg(args.msgstore);
    if (!msgstorePath) {
      throw new Error("Missing --msgstore path.");
    }
    const summary = await inspectArchive({
      msgstorePath,
      waPath: stringArg(args.wa),
      key: stringArg(args.key),
      keyPath: stringArg(args["key-file"]),
      keepDecrypted: Boolean(args["keep-decrypted"])
    });
    console.log(
      `Inspect complete: supported=${summary.supported} schema=${summary.schemaKind} tables=${summary.counts.tables} chats=${summary.counts.chats} contacts=${summary.counts.contacts} warnings=${summary.counts.warnings}`
    );
    for (const warning of summary.warnings.slice(0, 10)) {
      console.log(`WARN ${warning.code}: ${warning.message}`);
    }
    return;
  }

  if (command === "import") {
    await runImportCommand(args);
    return;
  }

  printHelp();
}

async function runImportCommand(args: Args): Promise<void> {
  const msgstorePath = stringArg(args.msgstore) ?? stringArg(args._);
  if (!msgstorePath) {
    throw new Error("Missing --msgstore path.");
  }

  const waPath = stringArg(args.wa) ?? stringArg(args["wa-db"]);
  const mediaPath = stringArg(args.media) ?? stringArg(args["media-dir"]);
  const archivePath = stringArg(args.archive) ?? stringArg(args["archive-db"]) ?? stringArg(args.db);
  const keyPath = stringArg(args["key-file"]);
  const logger = await createCliLogger("import");
  const progress = new ImportCliProgress();
  const repository = archivePath ? new SqliteArchiveRepository(path.resolve(archivePath)) : createArchiveRepository();
  const logPathForDisplay = displayPath(logger.logPath);

  console.log(`Debug log: ${logPathForDisplay}`);
  logger.info("import command started", {
    msgstore: safeBasename(msgstorePath),
    wa: safeBasename(waPath),
    media: safeBasename(mediaPath),
    archive: safeBasename(archivePath ?? config.archive.sqlitePath),
    hasInlineKey: Boolean(stringArg(args.key)),
    hasKeyFile: Boolean(keyPath),
    keepDecrypted: Boolean(args["keep-decrypted"])
  });
  await logInputSummary(logger, "msgstore", msgstorePath);
  if (waPath) {
    await logInputSummary(logger, "wa.db", waPath);
  }
  if (mediaPath) {
    await logInputSummary(logger, "media", mediaPath);
  }

  const onProgress = createProgressHandler(progress, logger);
  try {
    const totals = await runImport(
      repository,
      {
        msgstorePath,
        waPath,
        mediaPath,
        key: stringArg(args.key),
        keyPath,
        keepDecrypted: Boolean(args["keep-decrypted"])
      },
      { onProgress }
    );
    progress.complete(totals);
    logger.info("import command completed", { totals });
    console.log(
      `Import complete: chats=${totals.chats} contacts=${totals.contacts} participants=${totals.participants} messages=${totals.messages} skipped=${totals.skipped} warnings=${totals.warnings}`
    );
  } catch (error) {
    progress.fail(publicErrorMessage(error));
    logger.error("import command failed", serializeError(error));
    console.error(`Import failed: ${publicErrorMessage(error)}`);
    console.error(`Debug log: ${logPathForDisplay}`);
    process.exitCode = 1;
  } finally {
    await repository.close?.();
    await logger.close();
  }
}

function createProgressHandler(progress: ImportCliProgress, logger: CliLogger): (event: ImportProgressEvent) => void {
  let lastFileLogAt = 0;
  let lastMessageLogAt = 0;
  return (event) => {
    progress.handle(event);
    const now = Date.now();
    if (event.type === "file-progress") {
      const done = event.processedBytes >= event.totalBytes;
      if (!done && now - lastFileLogAt < 5000) {
        return;
      }
      lastFileLogAt = now;
    }
    if (event.type === "message-progress") {
      const done = event.totalMessages != null && event.processedMessages >= event.totalMessages;
      if (!done && now - lastMessageLogAt < 5000) {
        return;
      }
      lastMessageLogAt = now;
    }
    logger.debug("progress", event);
  };
}

type FileProgressPhase = Extract<ImportProgressEvent, { type: "file-progress" }>["phase"];

class ImportCliProgress {
  private spinner: Ora = ora({ text: "Starting import.", stream: process.stderr });
  private fileBar: cliProgress.SingleBar | null = null;
  private messageBar: cliProgress.SingleBar | null = null;
  private filePhase: FileProgressPhase | null = null;
  private lastFileUpdateAt = 0;
  private lastMessageUpdateAt = 0;

  handle(event: ImportProgressEvent): void {
    switch (event.type) {
      case "step":
        if (event.step !== "messages") {
          this.stopMessageBar();
        }
        if (event.step !== "decrypting") {
          this.stopFileBar();
        }
        this.setSpinner(event.message);
        break;
      case "file-progress":
        this.handleFileProgress(event);
        break;
      case "message-progress":
        this.handleMessageProgress(event);
        break;
      case "warnings":
        if (event.count > 0) {
          this.setSpinner(`Recorded ${event.count.toLocaleString()} import warning(s).`);
        }
        break;
      case "complete":
        this.complete(event.totals);
        break;
    }
  }

  complete(totals: { messages: number; warnings: number }): void {
    this.stopFileBar();
    this.stopMessageBar();
    if (this.spinner.isSpinning) {
      this.spinner.succeed(`Import complete: ${totals.messages.toLocaleString()} messages, ${totals.warnings.toLocaleString()} warning(s).`);
    }
  }

  fail(message: string): void {
    this.stopFileBar();
    this.stopMessageBar();
    if (this.spinner.isSpinning) {
      this.spinner.fail(message);
    } else {
      process.stderr.write(`Import failed: ${message}\n`);
    }
  }

  private handleFileProgress(event: Extract<ImportProgressEvent, { type: "file-progress" }>): void {
    const now = Date.now();
    const done = event.processedBytes >= event.totalBytes;
    if (!done && now - this.lastFileUpdateAt < 100) {
      return;
    }
    this.lastFileUpdateAt = now;
    if (this.filePhase !== event.phase) {
      this.stopFileBar();
      this.stopMessageBar();
      if (this.spinner.isSpinning) {
        this.spinner.stop();
      }
      this.filePhase = event.phase;
      this.fileBar = new cliProgress.SingleBar(
        {
          format: "{task} |{bar}| {percentage}% | {done}/{size} | ETA {eta_formatted}",
          barsize: 28,
          clearOnComplete: false,
          hideCursor: true,
          stream: process.stderr
        },
        cliProgress.Presets.shades_classic
      );
      this.fileBar.start(event.totalBytes, 0, {
        task: event.message,
        done: "0 B",
        size: formatBytes(event.totalBytes)
      });
    }
    this.fileBar?.update(event.processedBytes, {
      task: event.message,
      done: formatBytes(event.processedBytes),
      size: formatBytes(event.totalBytes)
    });
    if (done) {
      this.stopFileBar();
      this.setSpinner(event.phase === "verify" ? "Encrypted backup verified." : "Encrypted payload decrypted.");
    }
  }

  private handleMessageProgress(event: Extract<ImportProgressEvent, { type: "message-progress" }>): void {
    const now = Date.now();
    const total = event.totalMessages;
    if (total == null || total <= 0) {
      if (now - this.lastMessageUpdateAt >= 1000 || event.processedMessages === 0) {
        this.setSpinner(`Imported ${event.persistedMessages.toLocaleString()} messages...`);
        this.lastMessageUpdateAt = now;
      }
      return;
    }
    const done = event.processedMessages >= total;
    if (!done && now - this.lastMessageUpdateAt < 100) {
      return;
    }
    this.lastMessageUpdateAt = now;
    this.stopFileBar();
    if (!this.messageBar) {
      if (this.spinner.isSpinning) {
        this.spinner.stop();
      }
      this.messageBar = new cliProgress.SingleBar(
        {
          format: "Importing messages |{bar}| {percentage}% | {value}/{total} | ETA {eta_formatted}",
          barsize: 28,
          clearOnComplete: false,
          hideCursor: true,
          stream: process.stderr
        },
        cliProgress.Presets.shades_classic
      );
      this.messageBar.start(total, 0);
    }
    this.messageBar.update(Math.min(event.processedMessages, total));
    if (done) {
      this.stopMessageBar();
      this.setSpinner(`Persisted ${event.persistedMessages.toLocaleString()} messages.`);
    }
  }

  private setSpinner(message: string): void {
    this.spinner.text = message;
    if (!this.spinner.isSpinning) {
      this.spinner.start();
    }
  }

  private stopFileBar(): void {
    if (this.fileBar) {
      this.fileBar.stop();
      this.fileBar = null;
      this.filePhase = null;
    }
  }

  private stopMessageBar(): void {
    if (this.messageBar) {
      this.messageBar.stop();
      this.messageBar = null;
    }
  }
}

interface CliLogger {
  logPath: string;
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function createCliLogger(prefix: string): Promise<CliLogger> {
  const logDir = path.resolve(config.workDir, "logs");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `${prefix}-${stamp}-${randomBytes(4).toString("hex")}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });
  const write = (level: string, message: string, context?: Record<string, unknown>) => {
    const entry = sanitizeLogValue({
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context ?? null
    });
    stream.write(`${JSON.stringify(entry)}\n`);
  };
  write("info", "log started", { log: path.basename(logPath) });
  return {
    logPath,
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(resolve);
      })
  };
}

async function logInputSummary(logger: CliLogger, label: string, inputPath: string): Promise<void> {
  try {
    const inputStat = await stat(inputPath);
    logger.debug("input summary", {
      label,
      basename: path.basename(inputPath),
      kind: inputStat.isDirectory() ? "directory" : "file",
      sizeBytes: inputStat.isFile() ? inputStat.size : null
    });
  } catch (error) {
    logger.warn("input summary unavailable", { label, error: publicErrorMessage(error) });
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : null;
    return {
      name: error.name,
      code,
      publicMessage: publicErrorMessage(error),
      stack: redactForDisplay(error.stack ?? error.message)
    };
  }
  return { publicMessage: publicErrorMessage(error) };
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactForDisplay(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, sanitizeLogValue(nestedValue)])
    );
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function parseArgs(values: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = values[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else if (!args._) {
      args._ = value;
    }
  }
  return args;
}

function stringArg(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function printHelp(): void {
  console.log(`Usage:
  npm run init-db
  npm run doctor
  npm run cleanup
  npm run generate-fixtures -- --dir fixtures/generated/basic
  npm run inspect -- --msgstore <msgstore.db|msgstore.db.crypt15> [--wa <wa.db>] [--key <64-hex-key> | --key-file <encrypted_backup.key>]
  npm run import -- --msgstore <msgstore.db.crypt15> [--wa <wa.db>] [--media <WhatsApp/Media>] [--archive <archive.sqlite>] [--key <64-hex-key> | --key-file <encrypted_backup.key>]

Notes:
  - Keys and message contents are never printed by the CLI.
  - Encrypted backups are crypt15-only; plaintext msgstore.db remains supported for fixtures or already-decrypted local files.
  - By default, imports write to the local SQLite file configured by ARCHIVE_DB_PATH or .wapp-brain/archive.sqlite.
  - Each import writes a unique verbose debug log under .wapp-brain/logs.
  - inspect reports schema compatibility and counts without message bodies.
  - Use --keep-decrypted only if you intentionally want the decrypted msgstore left in the local work directory.
  - cleanup removes app-managed decrypted working files only.`);
}

main().catch((error) => {
  console.error(publicErrorMessage(error));
  process.exitCode = 1;
});
