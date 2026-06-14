import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ImportRequest, ImportTotals, MessageRecord } from "../../shared/types";
import { config } from "../config";
import { ensureManagedWorkDir } from "../cleanup";
import type { ArchiveRepository } from "../db/repository";
import { PublicError, publicErrorMessage, safeBasename } from "../privacy";
import { prepareMsgstore } from "./decrypt";
import { parseWhatsAppSource } from "./parser";
import type { ImportProgressHandler } from "./progress";
import { openReadableSQLite } from "./sqlite";

const MESSAGE_BATCH_SIZE = 750;

export interface RunImportOptions {
  onProgress?: ImportProgressHandler;
}

export async function runImport(
  repository: ArchiveRepository,
  request: ImportRequest,
  options: RunImportOptions = {}
): Promise<ImportTotals> {
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
    keepDecrypted: Boolean(request.keepDecrypted)
  };
  options.onProgress?.({ type: "step", step: "initializing", message: "Opening the local archive database." });
  const runId = await repository.startImportRun(sourceSummary);
  const totals: ImportTotals = { contacts: 0, chats: 0, participants: 0, messages: 0, skipped: 0, warnings: 0 };
  let warningCount = 0;
  let prepared: Awaited<ReturnType<typeof prepareMsgstore>> | null = null;
  let msgstoreDb: ReturnType<typeof openReadableSQLite> | null = null;
  let waDb: ReturnType<typeof openReadableSQLite> | null = null;

  try {
    await ensureManagedWorkDir();
    const outputDir = path.resolve(config.workDir, "decrypted");
    await mkdir(outputDir, { recursive: true });
    options.onProgress?.({ type: "step", step: "preparing", message: "Preparing msgstore input." });
    prepared = await prepareMsgstore({
      encryptedPath: request.msgstorePath,
      key: request.key,
      keyPath: request.keyPath,
      outputDir,
      keepDecrypted: request.keepDecrypted,
      onProgress: options.onProgress
    });
    options.onProgress?.({ type: "step", step: "opening", message: "Opening readable WhatsApp databases." });
    msgstoreDb = openReadableSQLite(prepared.sqlitePath, "msgstore");
    waDb = request.waPath ? openReadableSQLite(request.waPath, "wa.db") : null;

    options.onProgress?.({ type: "step", step: "parsing", message: "Inspecting WhatsApp schema and contacts." });
    const parsed = parseWhatsAppSource(msgstoreDb, waDb);
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

    options.onProgress?.({ type: "step", step: "contacts", message: "Importing contacts." });
    await repository.upsertContacts(runId, parsed.contacts);
    totals.contacts = parsed.contacts.length;
    options.onProgress?.({ type: "step", step: "chats", message: "Importing chats." });
    await repository.upsertChats(runId, parsed.chats);
    totals.chats = parsed.chats.length;

    options.onProgress?.({ type: "step", step: "messages", message: "Importing messages in batches." });
    options.onProgress?.({
      type: "message-progress",
      processedMessages: 0,
      persistedMessages: 0,
      totalMessages: parsed.messageCountEstimate
    });
    const messageBatch: MessageRecord[] = [];
    let processedMessages = 0;
    for (const message of parsed.iterateMessages()) {
      messageBatch.push(message);
      processedMessages += 1;
      if (messageBatch.length >= MESSAGE_BATCH_SIZE) {
        totals.messages += await flushMessageBatch(repository, runId, messageBatch);
        options.onProgress?.({
          type: "message-progress",
          processedMessages,
          persistedMessages: totals.messages,
          totalMessages: parsed.messageCountEstimate
        });
      }
    }
    totals.messages += await flushMessageBatch(repository, runId, messageBatch);
    totals.skipped = parsed.getSkippedRows();
    options.onProgress?.({
      type: "message-progress",
      processedMessages: parsed.messageCountEstimate ?? processedMessages + totals.skipped,
      persistedMessages: totals.messages,
      totalMessages: parsed.messageCountEstimate
    });
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

    options.onProgress?.({ type: "step", step: "participants", message: "Importing inferred group participants." });
    const participants = parsed.getParticipants();
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
    totals.warnings = warningCount;
    await repository.completeImportRun(runId, totals, warningCount);
    options.onProgress?.({ type: "complete", totals });
    return totals;
  } catch (error) {
    const message = publicErrorMessage(error);
    await repository.failImportRun(runId, error instanceof PublicError ? error.code : "IMPORT_FAILED", message, totals, warningCount);
    throw error;
  } finally {
    msgstoreDb?.close();
    waDb?.close();
    await prepared?.cleanup();
  }
}

async function flushMessageBatch(repository: ArchiveRepository, runId: string, batch: MessageRecord[]): Promise<number> {
  if (batch.length === 0) {
    return 0;
  }
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
