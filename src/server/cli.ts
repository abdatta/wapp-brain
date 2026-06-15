import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { cleanupSensitiveWorkDirs } from "./cleanup";
import { config } from "./config";
import { archiveAdapterLabel, createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { SqliteArchiveRepository } from "./db/sqliteRepository";
import { runDoctor } from "./doctor";
import { inspectArchive } from "./import/inspect";
import { runImport } from "./import/importer";
import { createSyntheticFixture } from "./import/fixtures";
import { BaileysLiveWhatsAppClient, runBaileysProof } from "./live/baileysClient";
import { assertLiveBaselineReady } from "./live/baseline";
import { LiveMaintainer, liveOptionsFromConfig } from "./live/maintainer";
import { ImportTerminalProgress, type ImportProgressEvent } from "./import/progress";
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
    const summary = await cleanupSensitiveWorkDirs();
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

  if (command === "live-status") {
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await repository.getLiveStatus(), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-gaps") {
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-retry-gap") {
    const id = numberArg(args.id ?? args._);
    if (!id) {
      throw new Error("Missing --id for live gap retry.");
    }
    const repository = createArchiveRepository();
    try {
      await repository.updateLiveGapStatus(id, "open", "User requested retry from CLI.");
      console.log(`Gap ${id} scheduled for retry.`);
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-cleanup-state" || command === "live-unlink") {
    await rm(config.live.authDir, { recursive: true, force: true });
    console.log(`Live auth state removed from ${displayPath(config.live.authDir)}.`);
    return;
  }

  if (command === "live-proof") {
    const repository = createArchiveRepository();
    try {
      await assertLiveBaselineReady(repository, config.live.maxBackfillPerChatDays);
    } finally {
      await repository.close?.();
    }
    const result = await runBaileysProof({
      phoneNumber: stringArg(args.phone),
      timeoutMs: numberArg(args.timeout) ?? 60_000
    });
    console.log(`Baileys proof complete: connected=${result.connected} messages_upsert=${result.receivedMessagesUpsert} history_sync=${result.receivedHistorySync}`);
    console.log(`Result written to ${displayPath(config.live.spikePath)}.`);
    for (const note of result.notes) {
      console.log(note);
    }
    return;
  }

  if (command === "live-start") {
    await runLiveStartCommand(args);
    return;
  }

  printHelp();
}

async function runLiveStartCommand(args: Args): Promise<void> {
  const repository = createArchiveRepository();
  const options = liveOptionsFromConfig();
  await assertLiveBaselineReady(repository, options.maxBackfillPerChatDays);
  const client = new BaileysLiveWhatsAppClient({
    authDir: options.authDir,
    phoneNumber: stringArg(args.phone),
    connectTimeoutMs: numberArg(args.timeout)
  });
  const maintainer = new LiveMaintainer(repository, client, options);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await maintainer.stop();
    await repository.close?.();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    const runId = await maintainer.start();
    console.log(`Live maintainer started: run=${runId}`);
    console.log("Press Ctrl+C to stop.");
    if (Boolean(args.once)) {
      await maintainer.runRecoveryOnce();
      await stop();
      return;
    }
    await new Promise(() => undefined);
  } catch (error) {
    await maintainer.fail(error);
    await repository.close?.();
    throw error;
  }
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
  const progress = new ImportTerminalProgress();
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

function createProgressHandler(progress: ImportTerminalProgress, logger: CliLogger): (event: ImportProgressEvent) => void {
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
  tsx src/server/cli.ts live-proof [--phone <countrycode-number>] [--timeout <ms>]
  tsx src/server/cli.ts live-start [--phone <countrycode-number>] [--once]
  tsx src/server/cli.ts live-status
  tsx src/server/cli.ts live-gaps
  tsx src/server/cli.ts live-retry-gap --id <gap-id>
  tsx src/server/cli.ts live-unlink

Notes:
  - Keys and message contents are never printed by the CLI.
  - Encrypted backups are crypt15-only; plaintext msgstore.db remains supported for fixtures or already-decrypted local files.
  - By default, imports write to the local SQLite file configured by ARCHIVE_DB_PATH or .wapp-brain/archive.sqlite.
  - Each import writes a unique verbose debug log under .wapp-brain/logs.
  - inspect reports schema compatibility and counts without message bodies.
  - live-* commands are explicit opt-in and store auth/session state only under .wapp-brain/live.
  - Use --keep-decrypted only if you intentionally want the decrypted msgstore left in the local work directory.
  - cleanup removes app-managed decrypted working files and import staging files.`);
}

main().catch((error) => {
  console.error(publicErrorMessage(error));
  process.exitCode = 1;
});
