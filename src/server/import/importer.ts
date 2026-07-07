import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ImportRequest, ImportTotals, ImportWarning, MessageRecord } from "../../shared/types";
import { config } from "../config";
import { ensureManagedWorkDir } from "../cleanup";
import type { ArchiveRepository } from "../db/repository";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { PublicError, publicErrorMessage, safeBasename } from "../privacy";
import { prepareMsgstore, prepareSidecarDatabase } from "./decrypt";
import { parseWhatsAppSource } from "./parser";
import type { ImportProgressHandler } from "./progress";
import { openReadableSQLite } from "./sqlite";

const MESSAGE_BATCH_SIZE = 750;

export interface RunImportOptions {
  onProgress?: ImportProgressHandler;
  signal?: AbortSignal;
}

export async function runImport(
  repository: ArchiveRepository,
  request: ImportRequest,
  options: RunImportOptions = {}
): Promise<ImportTotals> {
  await configuredTraceRecorder?.record("import.start", {
    request: {
      ...request,
      key: request.key ? { present: true, length: request.key.length } : null
    }
  });
  throwIfAborted(options.signal);
  options.onProgress?.({ type: "step", step: "validating", message: "Validating local input files." });
  validateLocalPath(request.msgstorePath, "msgstore");
  if (request.waPath) {
    validateLocalPath(request.waPath, "wa.db");
  }
  if (request.mediaPath) {
    validateLocalDirectory(request.mediaPath, "media");
  }
  if (request.keyPath) {
    validateLocalPath(request.keyPath, "backup key");
  }

  const sourceSummary = {
    msgstore: safeBasename(request.msgstorePath),
    wa: safeBasename(request.waPath),
    media: request.mediaPath ? safeBasename(request.mediaPath) : null,
    encrypted: /\.crypt15$/i.test(request.msgstorePath),
    waEncrypted: request.waPath ? /\.crypt15$/i.test(request.waPath) : false,
    keepDecrypted: Boolean(request.keepDecrypted)
  };
  options.onProgress?.({ type: "step", step: "initializing", message: "Opening the local archive database." });
  const runId = await repository.startImportRun(sourceSummary);
  throwIfAborted(options.signal);
  const totals: ImportTotals = { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
  let warningCount = 0;
  let prepared: Awaited<ReturnType<typeof prepareMsgstore>> | null = null;
  let preparedWa: Awaited<ReturnType<typeof prepareSidecarDatabase>> | null = null;
  let msgstoreDb: ReturnType<typeof openReadableSQLite> | null = null;
  let waDb: ReturnType<typeof openReadableSQLite> | null = null;

  try {
    await ensureManagedWorkDir();
    throwIfAborted(options.signal);
    const outputDir = path.resolve(config.workDir, "decrypted");
    await mkdir(outputDir, { recursive: true });
    options.onProgress?.({ type: "step", step: "preparing", message: "Preparing msgstore input." });
    prepared = await prepareMsgstore({
      encryptedPath: request.msgstorePath,
      key: request.key,
      keyPath: request.keyPath,
      outputDir,
      keepDecrypted: request.keepDecrypted,
      onProgress: options.onProgress,
      signal: options.signal
    });
    if (request.waPath) {
      throwIfAborted(options.signal);
      options.onProgress?.({ type: "step", step: "preparing", message: "Preparing contacts database input." });
      preparedWa = await prepareSidecarDatabase({
        encryptedPath: request.waPath,
        key: request.key,
        keyPath: request.keyPath,
        outputDir,
        keepDecrypted: request.keepDecrypted,
        label: "contacts database",
        outputPrefix: "wa",
        onProgress: options.onProgress,
        signal: options.signal
      });
    }
    throwIfAborted(options.signal);
    options.onProgress?.({ type: "step", step: "opening", message: "Opening readable WhatsApp databases." });
    msgstoreDb = openReadableSQLite(prepared.sqlitePath, "msgstore");
    waDb = preparedWa ? openReadableSQLite(preparedWa.sqlitePath, "wa.db") : null;

    throwIfAborted(options.signal);
    options.onProgress?.({ type: "step", step: "parsing", message: "Inspecting WhatsApp schema and contacts." });
    // Content fingerprint scopes surrogate ids for keyless rows: idempotent for
    // the same backup, collision-free across different backups.
    const sourceFingerprint = await fingerprintFile(prepared.sqlitePath);
    const parsed = parseWhatsAppSource(msgstoreDb, waDb, sourceFingerprint);
    await configuredTraceRecorder?.record("import.parsed", {
      runId,
      supported: parsed.supported,
      schemaReport: parsed.schemaReport,
      messageCountEstimate: parsed.messageCountEstimate,
      contacts: parsed.contacts,
      chats: parsed.chats,
      warnings: parsed.warnings
    });
    let persistedWarningCount = parsed.warnings.length;
    warningCount = persistedWarningCount;
    await repository.addWarnings(runId, parsed.warnings);
    options.onProgress?.({
      type: "warnings",
      count: parsed.warnings.length,
      codes: [...new Set(parsed.warnings.map((warning) => warning.code))].slice(0, 20)
    });
    if (!parsed.supported) {
      throw new PublicError(
        "UNSUPPORTED_MSGSTORE_SCHEMA",
        "msgstore did not contain a supported WhatsApp message schema."
      );
    }

    throwIfAborted(options.signal);
    options.onProgress?.({ type: "step", step: "contacts", message: "Importing contacts." });
    if (parsed.identityLinks.length) {
      await repository.recordIdentityLinks(parsed.identityLinks.map((link) => ({ ...link, source: "wa.db" })));
    }
    await repository.upsertContacts(runId, parsed.contacts);
    totals.contacts = parsed.contacts.length;
    options.onProgress?.({ type: "step", step: "chats", message: "Importing chats." });
    await repository.upsertChats(runId, parsed.chats);
    totals.chats = parsed.chats.length;
    // Re-propagate contact names now that the chats exist (replace-mode imports
    // create chats after contacts), then report enrichment visibly.
    const namedChatsBefore = await countResolvedChatNames(repository);
    await repository.upsertContacts(runId, parsed.contacts);
    const namedChatsAfter = await countResolvedChatNames(repository);
    // Informational summary entry; deliberately excluded from warning counters
    // (persistedWarningCount indexes into parsed.warnings for late additions).
    const enrichmentWarning: ImportWarning = {
      severity: "info",
      code: "CONTACT_ENRICHMENT",
      entityType: "contact",
      message: `Contact enrichment: ${parsed.contacts.length} contacts read, ${namedChatsAfter} of ${parsed.chats.length} chats named (${Math.max(0, namedChatsAfter - namedChatsBefore)} improved by contact propagation), ${parsed.identityLinks.length} identity links learned.`,
      context: {
        contactsRead: parsed.contacts.length,
        chatsNamed: namedChatsAfter,
        namesImproved: Math.max(0, namedChatsAfter - namedChatsBefore),
        identityLinks: parsed.identityLinks.length
      }
    };
    await repository.addWarnings(runId, [enrichmentWarning]);

    options.onProgress?.({ type: "step", step: "messages", message: "Importing messages in batches." });
    options.onProgress?.({
      type: "message-progress",
      processedMessages: 0,
      persistedMessages: 0,
      totalMessages: parsed.messageCountEstimate
    });
    await yieldToEventLoop(options.signal);
    const messageBatch: MessageRecord[] = [];
    let processedMessages = 0;
    for (const message of parsed.iterateMessages()) {
      throwIfAborted(options.signal);
      messageBatch.push(message);
      processedMessages += 1;
      if (messageBatch.length >= MESSAGE_BATCH_SIZE) {
        totals.messages += await flushMessageBatch(repository, runId, messageBatch);
        throwIfAborted(options.signal);
        options.onProgress?.({
          type: "message-progress",
          processedMessages,
          persistedMessages: totals.messages,
          totalMessages: parsed.messageCountEstimate
        });
        await yieldToEventLoop(options.signal);
      }
    }
    totals.messages += await flushMessageBatch(repository, runId, messageBatch);
    throwIfAborted(options.signal);
    totals.skipped = parsed.getSkippedRows();
    options.onProgress?.({
      type: "message-progress",
      processedMessages: parsed.messageCountEstimate ?? processedMessages + totals.skipped,
      persistedMessages: totals.messages,
      totalMessages: parsed.messageCountEstimate
    });
    await yieldToEventLoop(options.signal);
    if (parsed.warnings.length > persistedWarningCount) {
      const newWarnings = parsed.warnings.slice(persistedWarningCount);
      await repository.addWarnings(runId, newWarnings);
      persistedWarningCount = parsed.warnings.length;
      warningCount = persistedWarningCount;
      options.onProgress?.({
        type: "warnings",
        count: parsed.warnings.length,
        codes: [...new Set(parsed.warnings.map((warning) => warning.code))].slice(0, 20)
      });
    }

    throwIfAborted(options.signal);
    options.onProgress?.({ type: "step", step: "participants", message: "Importing inferred group participants." });
    const participants = parsed.getParticipants();
    await configuredTraceRecorder?.record("import.participants", { runId, participants });
    await repository.upsertContacts(
      runId,
      participants.map((participant) => ({
        sourceJid: participant.sourceJid,
        displayName: participant.displayName,
        rawMetadata: { source: "participants" }
      }))
    );
    totals.participants = await repository.upsertParticipants(participants);

    options.onProgress?.({ type: "step", step: "finalizing", message: "Refreshing chat statistics." });
    await repository.refreshChatStats();
    throwIfAborted(options.signal);
    totals.warnings = warningCount;
    await repository.completeImportRun(runId, totals, warningCount);
    await configuredTraceRecorder?.record("import.complete", { runId, totals, warningCount });
    options.onProgress?.({ type: "complete", totals });
    return totals;
  } catch (error) {
    const message = publicErrorMessage(error);
    await configuredTraceRecorder?.record("import.failed", {
      runId,
      code: error instanceof PublicError ? error.code : "IMPORT_FAILED",
      message,
      totals,
      warningCount
    });
    await repository.failImportRun(runId, error instanceof PublicError ? error.code : "IMPORT_FAILED", message, totals, warningCount);
    throw error;
  } finally {
    msgstoreDb?.close();
    waDb?.close();
    await prepared?.cleanup();
    await preparedWa?.cleanup();
  }
}

async function fingerprintFile(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 12)));
  });
}

// Counts chats whose display resolves to a name/phone, so enrichment deltas
// (names improved by wa.db) are observable in the import summary.
async function countResolvedChatNames(repository: ArchiveRepository): Promise<number> {
  let offset = 0;
  let count = 0;
  for (;;) {
    const page = await repository.listChats({ limit: 200, offset, includeEventOnly: true });
    count += page.filter((chat) => Boolean(chat.displayName)).length;
    if (page.length < 200) {
      break;
    }
    offset += page.length;
  }
  return count;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PublicError("IMPORT_CANCELLED", "Import stopped by user request.");
  }
}

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await setImmediate();
  throwIfAborted(signal);
}

async function flushMessageBatch(repository: ArchiveRepository, runId: string, batch: MessageRecord[]): Promise<number> {
  if (batch.length === 0) {
    return 0;
  }
  await configuredTraceRecorder?.record("import.message_batch", { runId, messages: batch });
  const chats = new Map(
    batch.map((message) => [
      message.chatSourceId,
      {
        sourceChatId: message.chatSourceId,
        jid: message.chatSourceId,
        displayName: null,
        chatType: "unknown" as const,
        rawMetadata: { source: "messages" }
      }
    ])
  );
  const contacts = batch
    .map((message) => message.senderSourceJid)
    .filter((jid): jid is string => Boolean(jid))
    .map((jid) => ({ sourceJid: jid, displayName: null, rawMetadata: { source: "messages" } }));
  await repository.upsertChats(runId, [...chats.values()]);
  await repository.upsertContacts(runId, contacts);
  const count = await repository.upsertMessages(batch);
  batch.length = 0;
  return count;
}

function validateLocalPath(filePath: string, label: string): void {
  if (!filePath || /^https?:\/\//i.test(filePath)) {
    throw new PublicError("INPUT_NOT_LOCAL", `${label} must be a local file path.`);
  }
  if (!fs.existsSync(filePath)) {
    throw new PublicError("INPUT_MISSING", `${label} file was not found.`);
  }
}

function validateLocalDirectory(directoryPath: string, label: string): void {
  if (!directoryPath || /^https?:\/\//i.test(directoryPath)) {
    throw new PublicError("INPUT_NOT_LOCAL", `${label} must be a local directory path.`);
  }
  if (!fs.existsSync(directoryPath)) {
    throw new PublicError("INPUT_MISSING", `${label} directory was not found.`);
  }
  const stats = fs.statSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new PublicError("INPUT_INVALID", `${label} path must be a directory.`);
  }
}
