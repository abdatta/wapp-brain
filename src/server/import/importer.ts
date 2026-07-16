import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type {
  CapturedLinkPreview,
  ImportRequest,
  ImportTotals,
  ImportWarning,
  LiveMessageUpdateRecord,
  MessageRecord,
  MessageSecretRecord
} from "../../shared/types";
import { config } from "../config";
import { ensureManagedWorkDir } from "../cleanup";
import type { ArchiveRepository } from "../db/repository";
import { configuredTraceRecorder } from "../diagnostics/traceRecorder";
import { mediaBlobStore } from "../media/blobStore";
import { PublicError, publicErrorMessage, safeBasename } from "../privacy";
import { runPersonAutoConnectPass } from "../persons/autoConnect";
import { runRetainedPayloadDecryptionPass } from "../live/secretsPass";
import { prepareMsgstore, prepareSidecarDatabase } from "./decrypt";
import { mediaBackfillWarning, runImportMediaBackfill } from "./mediaBackfill";
import { parseWhatsAppSource } from "./parser";
import type { ImportProgressHandler } from "./progress";
import { openReadableSQLite } from "./sqlite";

const MESSAGE_BATCH_SIZE = 750;
const ADD_ON_BATCH_SIZE = 500;

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
  // A wrong/absent media folder never blocks message import: it degrades to a
  // warning and the import proceeds without media.
  const mediaRootProblem = request.mediaPath ? describeMediaDirectoryProblem(request.mediaPath) : null;
  const mediaRoot = request.mediaPath && !mediaRootProblem ? request.mediaPath : null;
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
      await repository.recordIdentityLinks(parsed.identityLinks);
    }
    // Merge still-split LID identities before any ingest: message rows then
    // land in already-canonical chats and the (chat, key_id) idempotency check
    // sees the merged row. Deferring to the background sweep (3 per tick) would
    // leave re-imported history transiently duplicated for hours. Post-heal
    // re-imports find nothing split, so this pass is free when there is no work.
    const splitIdentities = await repository.listUnmergedLidIdentities(100000);
    let identityMerges = 0;
    if (splitIdentities.length) {
      options.onProgress?.({
        type: "step",
        step: "identity-merge",
        message: `Merging ${splitIdentities.length} split identities.`
      });
      for (const { lid, pn } of splitIdentities) {
        await repository.mergeIdentity(lid, pn);
        identityMerges += 1;
        if (identityMerges % 25 === 0) {
          options.onProgress?.({
            type: "step",
            step: "identity-merge",
            message: `Merging split identities (${identityMerges}/${splitIdentities.length}).`
          });
          await yieldToEventLoop(options.signal);
        }
      }
      options.onProgress?.({
        type: "step",
        step: "identity-merge",
        message: `Merged ${identityMerges} split identities.`
      });
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
    // Per-source link and name counts make msgstore-derived enrichment visible
    // even when wa.db is missing or empty.
    const jidMapLinks = parsed.identityLinks.filter((link) => link.source === "msgstore.jid_map").length;
    const waDbLinks = parsed.identityLinks.length - jidMapLinks;
    const lidNamesRead = parsed.contacts.filter((contact) => contact.rawMetadata?.source === "lid_display_name").length;
    const enrichmentWarning: ImportWarning = {
      severity: "info",
      code: "CONTACT_ENRICHMENT",
      entityType: "contact",
      message: `Contact enrichment: ${parsed.contacts.length} contacts read, ${namedChatsAfter} of ${parsed.chats.length} chats named (${Math.max(0, namedChatsAfter - namedChatsBefore)} improved by contact propagation), ${parsed.identityLinks.length} identity links read (${waDbLinks} wa.db, ${jidMapLinks} msgstore jid_map), ${lidNamesRead} LID display names read, ${identityMerges} split identities merged.`,
      context: {
        contactsRead: parsed.contacts.length,
        chatsNamed: namedChatsAfter,
        namesImproved: Math.max(0, namedChatsAfter - namedChatsBefore),
        identityLinks: parsed.identityLinks.length,
        waDbLinks,
        jidMapLinks,
        lidNamesRead,
        identityMerges
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
    // Archives written by earlier importer versions hold edited messages under
    // their edit keys; collapse those onto the canonical original-key rows.
    const editRekeys = parsed.getEditRekeys();
    if (editRekeys.length > 0) {
      const collapsed = await repository.collapseSupersededMessages(editRekeys);
      if (collapsed > 0) {
        // Informational summary entry; deliberately excluded from warning
        // counters (persistedWarningCount indexes into parsed.warnings).
        await repository.addWarnings(runId, [
          {
            severity: "info",
            code: "EDIT_IDENTITY_COLLAPSE",
            entityType: "message",
            message: `Edited messages: ${collapsed} stale edit-key row(s) collapsed onto their original-key identity.`,
            context: { collapsed, candidates: editRekeys.length }
          }
        ]);
      }
    }

    throwIfAborted(options.signal);
    options.onProgress?.({ type: "step", step: "signals", message: "Importing structured local message signals." });
    // Signal capture intentionally follows canonical messages, edit-key
    // collapse, chats, and identity repair: every signal can now use the same
    // durable message identity as its read and evidence consumers.
    const repairedFalseSelfFacts = await repository.repairAmbiguousSelfMembershipFacts();
    if (repairedFalseSelfFacts > 0) {
      await repository.addWarnings(runId, [{
        severity: "info",
        code: "SYSTEM_ROLE_REPAIR",
        entityType: "message",
        message: `Repaired ${repairedFalseSelfFacts} ambiguous self-attributed group event(s); their source messages remain as generic system rows.`,
        context: { repaired: repairedFalseSelfFacts }
      }]);
    }
    const signalBatch = parsed.getArchiveSignalBatch();
    const signalResult = await repository.upsertArchiveSignals(signalBatch);
    let previewCount = 0;
    let previewBatch: CapturedLinkPreview[] = [];
    for (const preview of parsed.iterateLinkPreviews()) {
      throwIfAborted(options.signal);
      previewBatch.push(preview);
      if (previewBatch.length >= ADD_ON_BATCH_SIZE) {
        previewCount += await repository.recordLinkPreviews(previewBatch);
        previewBatch = [];
        await yieldToEventLoop(options.signal);
      }
    }
    if (previewBatch.length > 0) {
      previewCount += await repository.recordLinkPreviews(previewBatch);
    }
    const signalCounts = Object.fromEntries(
      Object.entries(signalBatch).map(([family, rows]) => [family, rows?.length ?? 0])
    );
    if (Object.values(signalCounts).some((count) => count > 0) || previewCount > 0) {
      await repository.addWarnings(runId, [
        {
          severity: "info",
          code: "ARCHIVE_SIGNAL_CAPTURE",
          entityType: "message",
          message: `Structured signal capture completed: ${signalResult.changedMessageKeys.length} message anchor(s) enriched, ${previewCount} link preview(s) recorded, and ${signalResult.skippedUnanchoredRecords} unanchored companion record(s) skipped.`,
          context: { ...signalCounts, linkPreviews: previewCount, skippedUnanchoredRecords: signalResult.skippedUnanchoredRecords }
        }
      ]);
    }
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
    options.onProgress?.({ type: "step", step: "addons", message: "Importing reactions, poll votes, and event responses." });
    const addOnCounts: Record<string, number> = {};
    let addOnBatch: Array<Omit<LiveMessageUpdateRecord, "applied">> = [];
    for (const update of parsed.iterateAddOnUpdates()) {
      throwIfAborted(options.signal);
      addOnBatch.push(update);
      addOnCounts[update.updateType] = (addOnCounts[update.updateType] ?? 0) + 1;
      if (addOnBatch.length >= ADD_ON_BATCH_SIZE) {
        await repository.applyLiveMessageUpdates(addOnBatch);
        addOnBatch = [];
        await yieldToEventLoop(options.signal);
      }
    }
    if (addOnBatch.length > 0) {
      await repository.applyLiveMessageUpdates(addOnBatch);
    }
    const addOnTotal = Object.values(addOnCounts).reduce((sum, count) => sum + count, 0);
    if (addOnTotal > 0) {
      // Informational summary entry; deliberately excluded from warning
      // counters (persistedWarningCount indexes into parsed.warnings).
      await repository.addWarnings(runId, [
        {
          severity: "info",
          code: "ADD_ON_SUMMARY",
          entityType: "message",
          message: `Message add-ons: ${addOnCounts.reaction ?? 0} reactions, ${addOnCounts.poll_vote ?? 0} poll votes, ${addOnCounts.event_response ?? 0} event responses applied to original messages.`,
          context: addOnCounts
        }
      ]);
    }

    throwIfAborted(options.signal);
    // Secrets backfill arms historical messages for late decryption of
    // secret-encrypted updates (poll votes, event responses, edits).
    let secretsBackfilled = 0;
    let secretBatch: MessageSecretRecord[] = [];
    for (const secret of parsed.iterateMessageSecrets()) {
      throwIfAborted(options.signal);
      secretBatch.push(secret);
      if (secretBatch.length >= ADD_ON_BATCH_SIZE) {
        secretsBackfilled += await repository.recordMessageSecrets(secretBatch);
        secretBatch = [];
        await yieldToEventLoop(options.signal);
      }
    }
    if (secretBatch.length > 0) {
      secretsBackfilled += await repository.recordMessageSecrets(secretBatch);
    }
    if (secretsBackfilled > 0) {
      const decryption = await runRetainedPayloadDecryptionPass(repository, { limit: 500 });
      // Informational summary entry; deliberately excluded from warning
      // counters (persistedWarningCount indexes into parsed.warnings).
      await repository.addWarnings(runId, [
        {
          severity: "info",
          code: "SECRET_BACKFILL",
          entityType: "message",
          message: `Message secrets: ${secretsBackfilled} newly backfilled from the backup (${await repository.countMessageSecrets()} total); ${decryption.decrypted} retained encrypted update(s) decrypted retroactively.`,
          context: { secretsBackfilled, decrypted: decryption.decrypted }
        }
      ]);
    }

    throwIfAborted(options.signal);
    // Media backfill: read the sidecar mappings, match files in the provided
    // folder, copy into the content-addressed store, link with import
    // provenance. Warn-not-abort throughout.
    if (mediaRootProblem) {
      const warning: ImportWarning = {
        severity: "warning",
        code: "MEDIA_FOLDER_UNREADABLE",
        entityType: "message",
        message: `Media folder was skipped: ${mediaRootProblem} Messages imported without media.`,
        context: { folder: safeBasename(request.mediaPath) }
      };
      await repository.addWarnings(runId, [warning]);
      warningCount += 1;
    } else if (mediaRoot && parsed.mediaRefCountEstimate > 0) {
      options.onProgress?.({ type: "step", step: "media", message: "Archiving media from the provided folder." });
      try {
        const mediaSummary = await runImportMediaBackfill({
          repository,
          store: mediaBlobStore,
          mediaRoot,
          refs: parsed.iterateMediaRefs(),
          totalRefs: parsed.mediaRefCountEstimate,
          onProgress: options.onProgress,
          signal: options.signal,
          resolveChatSourceId: (jid) => repository.resolveIdentityJid(jid)
        });
        const warning = mediaBackfillWarning(mediaSummary);
        await repository.addWarnings(runId, [warning]);
        if (warning.severity !== "info") {
          warningCount += 1;
        }
        await configuredTraceRecorder?.record("import.media_backfill", { runId, ...mediaSummary });
      } catch (error) {
        if (error instanceof PublicError && error.code === "IMPORT_CANCELLED") {
          throw error;
        }
        // Any other media failure is a warning; the message import stands.
        await repository.addWarnings(runId, [
          {
            severity: "warning",
            code: "MEDIA_INGEST_FAILED",
            entityType: "message",
            message: "Media ingestion failed part-way; messages were imported without the remaining media.",
            context: { message: publicErrorMessage(error) }
          }
        ]);
        warningCount += 1;
      }
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
    // Person auto-connect over the signals this import just landed (number
    // changes; Google groupings if a sync already persisted them). Bounded,
    // idempotent, metadata-only — a failure never fails the import.
    try {
      const autoConnect = await runPersonAutoConnectPass(repository);
      const connected = autoConnect.googleConnected + autoConnect.numberChangeConnected;
      if (connected > 0) {
        await configuredTraceRecorder?.record("import.person_auto_connect", { runId, ...autoConnect });
      }
    } catch (error) {
      await repository.addWarnings(runId, [
        {
          severity: "warning",
          code: "PERSON_AUTO_CONNECT_FAILED",
          message: "Person auto-connect could not complete after the import; the maintenance pass will retry.",
          context: { message: publicErrorMessage(error) }
        }
      ]);
      warningCount += 1;
    }
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

// Non-fatal media-folder validation: returns a human explanation of the
// problem, or null when the directory is usable. Never throws — a bad media
// path must not abort the message import.
function describeMediaDirectoryProblem(directoryPath: string): string | null {
  if (!directoryPath || /^https?:\/\//i.test(directoryPath)) {
    return "The media folder must be a local directory path.";
  }
  if (!fs.existsSync(directoryPath)) {
    return "The media folder was not found.";
  }
  try {
    if (!fs.statSync(directoryPath).isDirectory()) {
      return "The media folder path is not a directory.";
    }
  } catch {
    return "The media folder could not be read.";
  }
  return null;
}
