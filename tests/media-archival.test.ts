import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MediaDownloadDescriptor, MediaDownloadQueueRecord, MessageRecord } from "../src/shared/types";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { MediaBlobStore } from "../src/server/media/blobStore";
import { downloadQueuedMedia } from "../src/server/media/downloader";
import { runImportMediaBackfill } from "../src/server/import/mediaBackfill";
import { interpretMessage } from "../src/server/interpretation/messageInterpretation";
import {
  installReadOnlySocketGuards,
  MEDIA_RETRY_ALLOWED_METHODS,
  READ_ONLY_BLOCKED_METHODS
} from "../src/server/live/baileysClient";
import {
  capturedLinkPreviewFromBaileysMessage,
  capturedMediaFromBaileysMessage,
  normalizeBaileysMessage
} from "../src/server/live/normalize";
import { messageKey } from "../src/server/identity/keys";

const CHAT = "15550001111@s.whatsapp.net";

describe("media archival", () => {
  it("captures the downloadable descriptor from wrapped view-once media before normalization discards it", () => {
    const mediaKey = new Uint8Array([1, 2, 3, 4]);
    const thumbnail = new Uint8Array([9, 9, 9]);
    const captured = capturedMediaFromBaileysMessage(
      {
        key: { remoteJid: CHAT, id: "VO1", fromMe: false },
        messageTimestamp: 1_712_000_000,
        message: {
          viewOnceMessageV2: {
            message: {
              imageMessage: {
                mediaKey,
                directPath: "/v/t62.7118-24/abc",
                url: "https://mmg.whatsapp.net/v/t62.7118-24/abc",
                fileEncSha256: new Uint8Array([5, 5]),
                fileSha256: new Uint8Array([6, 6]),
                mimetype: "image/jpeg",
                fileLength: 12345,
                width: 800,
                height: 600,
                jpegThumbnail: thumbnail
              }
            }
          }
        }
      },
      {
        key: { remoteJid: "raw-form@lid", id: "VO1", fromMe: false, participant: "someone@lid" }
      }
    );

    expect(captured).not.toBeNull();
    expect(captured?.isViewOnce).toBe(true);
    expect(captured?.descriptor.mediaType).toBe("image");
    expect(captured?.descriptor.mediaKey).toBe(Buffer.from(mediaKey).toString("base64"));
    expect(captured?.descriptor.directPath).toBe("/v/t62.7118-24/abc");
    expect(captured?.descriptor.fileLength).toBe(12345);
    expect(captured?.thumbnail).toEqual(thumbnail);
    // The retry key preserves the raw platform identity forms verbatim.
    expect(captured?.descriptor.retryKey).toEqual({ remoteJid: "raw-form@lid", id: "VO1", fromMe: false, participant: "someone@lid" });
  });

  it("captures sender-embedded link previews without any remote fetch", () => {
    const preview = capturedLinkPreviewFromBaileysMessage({
      key: { remoteJid: CHAT, id: "L1" },
      message: {
        extendedTextMessage: {
          text: "look at https://example.com/post",
          title: "Example post",
          description: "An example page",
          canonicalUrl: "https://example.com/post",
          jpegThumbnail: new Uint8Array([1, 2])
        }
      }
    });
    expect(preview?.title).toBe("Example post");
    expect(preview?.canonicalUrl).toBe("https://example.com/post");
    expect(preview?.thumbnail?.length).toBe(2);
    expect(capturedLinkPreviewFromBaileysMessage({ key: { remoteJid: CHAT, id: "L2" }, message: { conversation: "no preview" } })).toBeNull();
  });

  it("keeps every receipt and presence method blocked while allowing only the media re-upload request", () => {
    const calls: string[] = [];
    const socket: Record<string, unknown> = {};
    for (const method of [...READ_ONLY_BLOCKED_METHODS, ...MEDIA_RETRY_ALLOWED_METHODS]) {
      socket[method] = () => {
        calls.push(method);
        return Promise.resolve({});
      };
    }
    installReadOnlySocketGuards(socket);
    for (const method of ["readMessages", "sendReceipt", "sendReceipts", "sendPresenceUpdate", "sendMessage", "chatModify"]) {
      expect(() => (socket[method] as () => unknown)(), method).toThrow(/Read-only live maintainer blocked/);
    }
    expect(() => (socket.updateMediaMessage as () => unknown)()).not.toThrow();
    expect(calls).toEqual(["updateMediaMessage"]);
  });

  it("never sends a read or played receipt from the media layer, even during re-upload recovery", async () => {
    // Underlying spies survive guard installation; the guard replaces the
    // socket methods with throwers, so any receipt attempt would explode AND
    // the spies must stay uncalled.
    const spies = {
      readMessages: vi.fn(),
      sendReceipt: vi.fn(),
      sendReceipts: vi.fn(),
      sendPresenceUpdate: vi.fn(),
      sendMessage: vi.fn()
    };
    const socket: Record<string, unknown> = { ...spies };
    installReadOnlySocketGuards(socket);
    const task = makeQueueTask("M1");
    let reuploaded = false;
    const expiredError = Object.assign(new Error("media not found"), { output: { statusCode: 404 } });
    const outcome = await downloadQueuedMedia(
      task,
      { allowReupload: true },
      {
        fetchContent: async () => {
          if (!reuploaded) {
            throw expiredError;
          }
          return Buffer.from("decrypted-bytes");
        },
        requestReupload: async (message) => {
          reuploaded = true;
          return message;
        }
      }
    );
    expect(outcome.status).toBe("stored");
    expect(outcome.usedReupload).toBe(true);
    expect(outcome.bytes?.toString()).toBe("decrypted-bytes");
    // The one sanctioned outbound happened; no receipt/presence method did.
    expect(spies.readMessages).not.toHaveBeenCalled();
    expect(spies.sendReceipt).not.toHaveBeenCalled();
    expect(spies.sendReceipts).not.toHaveBeenCalled();
    expect(spies.sendPresenceUpdate).not.toHaveBeenCalled();
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });

  it("reports expired when re-upload is not allowed and transient on other failures", async () => {
    const task = makeQueueTask("M2");
    const gone = Object.assign(new Error("gone"), { output: { statusCode: 410 } });
    const expired = await downloadQueuedMedia(task, { allowReupload: false }, { fetchContent: async () => Promise.reject(gone) });
    expect(expired.status).toBe("expired");
    const flaky = await downloadQueuedMedia(task, { allowReupload: true }, { fetchContent: async () => Promise.reject(new Error("socket hang up")) });
    expect(flaky.status).toBe("transient");
  });

  it("drives the durable queue end to end: enqueue, claim, store, honest availability", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-queue-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const store = new MediaBlobStore(path.join(tempDir, "media"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([liveMediaMessage("IMG1", 1000), liveMediaMessage("IMG2", 2000)]);
      const enqueued = await repository.enqueueMediaDownloads([
        queueInput("IMG1", { isViewOnce: true, priority: 100 }),
        queueInput("IMG2", { priority: 0 })
      ]);
      expect(enqueued).toBe(2);

      // Highest priority (view-once) claims first, and claiming marks the row in flight.
      const claimed = await repository.claimDueMediaDownloads(1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].messageKey).toBe(messageKey(CHAT, "IMG1"));
      expect(claimed[0].isViewOnce).toBe(true);

      const blob = await store.putBytes(Buffer.from("fake-image-bytes"));
      await repository.completeMediaDownload(claimed[0].id!, {
        messageKey: claimed[0].messageKey,
        chatSourceId: CHAT,
        sha256: blob.sha256,
        storagePath: blob.storagePath,
        mimeType: "image/jpeg",
        byteSize: blob.byteSize,
        width: 800,
        height: 600,
        durationMs: null,
        thumbnail: claimed[0].thumbnail,
        source: "live-download",
        isViewOnce: true
      });

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      const byId = new Map(messages.map((message) => [message.sourceMessageId, message]));
      const storedMessage = byId.get("IMG1");
      expect(storedMessage?.media?.availability).toBe("stored");
      expect(storedMessage?.media?.isViewOnce).toBe(true);
      expect(storedMessage?.media?.hasThumbnail).toBe(true);
      expect(storedMessage?.interpretation?.reason).toBeNull();
      // Still-queued media reports pending, not a false claim either way.
      expect(byId.get("IMG2")?.media?.availability).toBe("pending");

      // The stored blob round-trips through the store path.
      const asset = await repository.getMediaAssetForMessage(storedMessage!.id);
      expect(asset).not.toBeNull();
      const bytes = await readFile(store.absolutePath(asset!.storagePath));
      expect(bytes.toString()).toBe("fake-image-bytes");

      // Restart recovery: claimed-but-unfinished work returns to pending.
      await repository.claimDueMediaDownloads(5);
      expect(await repository.resetInFlightMediaDownloads()).toBe(1);

      // Terminal expiry surfaces the honest unrecoverable state.
      const reclaimed = await repository.claimDueMediaDownloads(5);
      await repository.markMediaDownloadTerminal(reclaimed[0].id!, "expired_unrecoverable", "link expired");
      const after = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(after.find((message) => message.sourceMessageId === "IMG2")?.media?.availability).toBe("expired_unrecoverable");
      const summary = await repository.getMediaQueueSummary();
      expect(summary.stored).toBe(1);
      expect(summary.expiredUnrecoverable).toBe(1);
      expect(summary.assets).toBe(1);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps archived media and held text when the sender revokes the message", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-revoke-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const store = new MediaBlobStore(path.join(tempDir, "media"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([{ ...liveMediaMessage("PIC1", 1000), caption: "keep this caption" }]);
      const blob = await store.putBytes(Buffer.from("revoked-media-bytes"));
      await repository.linkMediaAsset({
        messageKey: messageKey(CHAT, "PIC1"),
        chatSourceId: CHAT,
        sha256: blob.sha256,
        storagePath: blob.storagePath,
        mimeType: "image/jpeg",
        byteSize: blob.byteSize,
        width: null,
        height: null,
        durationMs: null,
        source: "live-download",
        isViewOnce: false
      });

      await repository.applyLiveMessageUpdates([
        {
          eventKey: "wa-web:delete:test",
          chatSourceId: CHAT,
          sourceMessageKey: messageKey(CHAT, "PIC1"),
          updateType: "delete",
          occurredAtMs: 2000,
          metadata: null
        }
      ]);

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const [message] = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(message.isDeleted).toBe(true);
      // Held content survives the tombstone: caption, media link, and blob.
      expect(message.caption).toBe("keep this caption");
      expect(message.media?.availability).toBe("stored");
      const asset = await repository.getMediaAssetForMessage(message.id);
      expect(asset).not.toBeNull();
      expect(fs.existsSync(store.absolutePath(asset!.storagePath))).toBe(true);
      // Interpretation keeps the real kind (the deleted state rides the DTO).
      expect(message.interpretation?.label).toBe("Photo");
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retains prior versions when live edits arrive and exposes them in order", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-edits-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([{ ...liveMediaMessage("TXT1", 1000), messageType: "text", hasMedia: false, body: "first version" }]);
      const edit = (body: string, at: number) => ({
        eventKey: `wa-web:edit:${body}`,
        chatSourceId: CHAT,
        sourceMessageKey: messageKey(CHAT, "TXT1"),
        updateType: "edit" as const,
        occurredAtMs: at,
        metadata: { body }
      });
      await repository.applyLiveMessageUpdates([edit("second version", 2000)]);
      await repository.applyLiveMessageUpdates([edit("third version", 3000)]);

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const [message] = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(message.body).toBe("third version");
      expect(message.isEdited).toBe(true);
      expect(message.editRevisionCount).toBe(2);
      const revisions = await repository.listMessageEditRevisions(message.id);
      expect(revisions.map((revision) => revision.body)).toEqual(["first version", "second version"]);
      expect(revisions.map((revision) => revision.revisionIndex)).toEqual([0, 1]);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates identical media by content hash and keeps re-linking idempotent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-dedupe-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const store = new MediaBlobStore(path.join(tempDir, "media"));
      const first = await store.putBytes(Buffer.from("same-bytes"));
      const second = await store.putBytes(Buffer.from("same-bytes"));
      expect(second.sha256).toBe(first.sha256);
      expect(second.storagePath).toBe(first.storagePath);

      const asset = {
        messageKey: messageKey(CHAT, "DUP1"),
        chatSourceId: CHAT,
        sha256: first.sha256,
        storagePath: first.storagePath,
        mimeType: "image/jpeg",
        byteSize: first.byteSize,
        width: null,
        height: null,
        durationMs: null,
        source: "import-folder" as const,
        isViewOnce: false
      };
      const idA = await repository.linkMediaAsset(asset);
      const idB = await repository.linkMediaAsset(asset);
      expect(idB).toBe(idA);
      // A forward of the same content in another message shares the blob.
      const idC = await repository.linkMediaAsset({ ...asset, messageKey: messageKey(CHAT, "DUP2") });
      expect(idC).not.toBe(idA);
      expect((await repository.getMediaQueueSummary()).assets).toBe(2);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("matches import media by content hash and recorded path, warns on missing, never aborts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-import-"));
    try {
      const repository = new MemoryArchiveRepository();
      const store = new MediaBlobStore(path.join(tempDir, "store"));
      const mediaRoot = path.join(tempDir, "Media");
      await mkdir(path.join(mediaRoot, "WhatsApp Images", "Sent"), { recursive: true });
      await mkdir(path.join(mediaRoot, "WhatsApp Video"), { recursive: true });
      await mkdir(path.join(mediaRoot, ".Statuses"), { recursive: true });
      const imageBytes = Buffer.from("image-bytes-1");
      await writeFile(path.join(mediaRoot, "WhatsApp Images", "IMG-001.jpg"), imageBytes);
      await writeFile(path.join(mediaRoot, "WhatsApp Video", "VID-001.mp4"), Buffer.from("video-bytes-1"));
      // Unrelated hidden-dir content must be skipped by the walk.
      await writeFile(path.join(mediaRoot, ".Statuses", "STATUS.jpg"), Buffer.from("status-bytes"));

      const summary = await runImportMediaBackfill({
        repository,
        store,
        mediaRoot,
        totalRefs: 3,
        refs: [
          {
            chatSourceId: CHAT,
            sourceMessageId: "IMG-MSG",
            messageType: "image",
            filePath: "Media/WhatsApp Images/IMG-001.jpg",
            fileSize: imageBytes.length,
            mimeType: "image/jpeg",
            mediaName: "IMG-001.jpg",
            fileHashB64: createHash("sha256").update(imageBytes).digest("base64"),
            width: null,
            height: null,
            durationMs: null,
            isViewOnce: false,
            thumbnail: null
          },
          {
            chatSourceId: CHAT,
            sourceMessageId: "VID-MSG",
            messageType: "video",
            // Recorded path is stale; basename fallback should still match.
            filePath: "Media/WhatsApp Video/old-folder/VID-001.mp4",
            fileSize: null,
            mimeType: "video/mp4",
            mediaName: "VID-001.mp4",
            fileHashB64: null,
            width: null,
            height: null,
            durationMs: null,
            isViewOnce: false,
            thumbnail: null
          },
          {
            chatSourceId: CHAT,
            sourceMessageId: "GONE-MSG",
            messageType: "image",
            filePath: "Media/WhatsApp Images/IMG-MISSING.jpg",
            fileSize: 10,
            mimeType: "image/jpeg",
            mediaName: "IMG-MISSING.jpg",
            fileHashB64: null,
            width: null,
            height: null,
            durationMs: null,
            isViewOnce: false,
            thumbnail: null
          }
        ]
      });

      expect(summary.processedRefs).toBe(3);
      expect(summary.matchedRefs).toBe(2);
      expect(summary.copiedAssets).toBe(2);
      expect(summary.missingRefs).toBe(1);

      // Re-running the same backfill is idempotent: no duplicate assets.
      await runImportMediaBackfill({
        repository,
        store,
        mediaRoot,
        totalRefs: 1,
        refs: [
          {
            chatSourceId: CHAT,
            sourceMessageId: "IMG-MSG",
            messageType: "image",
            filePath: "Media/WhatsApp Images/IMG-001.jpg",
            fileSize: imageBytes.length,
            mimeType: "image/jpeg",
            mediaName: "IMG-001.jpg",
            fileHashB64: createHash("sha256").update(imageBytes).digest("base64"),
            width: null,
            height: null,
            durationMs: null,
            isViewOnce: false,
            thumbnail: null
          }
        ]
      });
      expect((await repository.getMediaQueueSummary()).assets).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enqueues file-less media with a descriptor for CDN recovery, leaves keyless media honestly missing, and is dedup-safe", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-recover-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const store = new MediaBlobStore(path.join(tempDir, "media"));
      const mediaRoot = path.join(tempDir, "Media");
      await mkdir(mediaRoot, { recursive: true });
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      // Two imported (non-wa-web) media messages with no local file.
      await repository.upsertMessages([
        { ...liveMediaMessage("RECOVER", 1000), sourceTable: "message" },
        { ...liveMediaMessage("GONE", 2000), sourceTable: "message" }
      ]);

      const descriptor: MediaDownloadDescriptor = {
        mediaType: "image",
        mediaKey: Buffer.from("k".repeat(32)).toString("base64"),
        directPath: "/v/t62/recoverable",
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTimestamp: 0,
        mimeType: "image/jpeg",
        fileName: null,
        fileLength: 42,
        width: null,
        height: null,
        durationSeconds: null,
        retryKey: null
      };
      const fileless = (id: string, downloadDescriptor: MediaDownloadDescriptor | null) => ({
        chatSourceId: CHAT,
        sourceMessageId: id,
        messageType: "image",
        filePath: null,
        fileSize: null,
        mimeType: "image/jpeg",
        mediaName: null,
        fileHashB64: null,
        width: null,
        height: null,
        durationMs: null,
        isViewOnce: false,
        thumbnail: null,
        downloadDescriptor
      });

      const summary = await runImportMediaBackfill({
        repository,
        store,
        mediaRoot,
        totalRefs: 2,
        refs: [fileless("RECOVER", descriptor), fileless("GONE", null)]
      });
      expect(summary.matchedRefs).toBe(0);
      expect(summary.queuedForRecovery).toBe(1);
      expect(summary.unrecoverable).toBe(1);
      expect((await repository.getMediaQueueSummary()).pending).toBe(1);

      // Availability is honest: recoverable → pending; keyless → import_missing
      // with the "never saved on your phone" reason (never folder-blame).
      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      const byId = new Map(messages.map((message) => [message.sourceMessageId, message]));
      expect(byId.get("RECOVER")?.media?.availability).toBe("pending");
      expect(byId.get("GONE")?.media?.availability).toBe("import_missing");
      expect(byId.get("GONE")?.interpretation?.reason).toBe(
        "This media was never saved on your phone, so the backup has no copy of it."
      );

      // Re-running the backfill does not double-enqueue.
      const again = await runImportMediaBackfill({
        repository,
        store,
        mediaRoot,
        totalRefs: 1,
        refs: [fileless("RECOVER", descriptor)]
      });
      expect(again.queuedForRecovery).toBe(1);
      expect((await repository.getMediaQueueSummary()).pending).toBe(1);

      // The enqueued descriptor round-trips for the worker to fetch.
      const claimed = await repository.claimDueMediaDownloads(10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].messageKey).toBe(messageKey(CHAT, "RECOVER"));
      expect(claimed[0].descriptor.directPath).toBe("/v/t62/recoverable");
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mirrors recovery availability in the memory repository", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
    await repository.upsertMessages([
      { ...liveMediaMessage("RECOVER", 1000), sourceTable: "message" },
      { ...liveMediaMessage("GONE", 2000), sourceTable: "message" }
    ]);
    await repository.enqueueMediaDownloads([
      {
        messageKey: messageKey(CHAT, "RECOVER"),
        chatSourceId: CHAT,
        sourceMessageId: "RECOVER",
        descriptor: {
          mediaType: "image",
          mediaKey: Buffer.from("k".repeat(32)).toString("base64"),
          directPath: "/v/x",
          url: null,
          fileEncSha256: null,
          fileSha256: null,
          mediaKeyTimestamp: 0,
          mimeType: "image/jpeg",
          fileName: null,
          fileLength: 1,
          width: null,
          height: null,
          durationSeconds: null,
          retryKey: null
        },
        thumbnail: null,
        isViewOnce: false,
        priority: 0
      }
    ]);
    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
    const byId = new Map(messages.map((message) => [message.sourceMessageId, message]));
    expect(byId.get("RECOVER")?.media?.availability).toBe("pending");
    expect(byId.get("GONE")?.media?.availability).toBe("import_missing");
  });

  it("labels view-once envelopes withheld from linked devices honestly instead of unknown", () => {
    // Current WhatsApp delivers view-once content only to the phone; the
    // companion receives an unavailable envelope (no ciphertext) that Baileys
    // marks with key.isViewOnce.
    const withheld = normalizeBaileysMessage(
      { key: { remoteJid: CHAT, id: "VO-NULL", fromMe: false, isViewOnce: true }, messageTimestamp: 1_712_000_000, message: null },
      "wa-web:messages.upsert"
    );
    expect(withheld?.messageType).toBe("view_once");
    expect(withheld?.hasMedia).toBe(false);
    expect(withheld?.rawMetadata?.viewOnceUnavailable).toBe(true);
    const interpretation = interpretMessage({ messageType: "view_once" });
    expect(interpretation?.label).toBe("View once media");
    expect(interpretation?.reason).toContain("only to your phone");
    // Without the view-once marker, contentless rows keep the honest unknown.
    const bare = normalizeBaileysMessage(
      { key: { remoteJid: CHAT, id: "NULL1", fromMe: false }, messageTimestamp: 1_712_000_000, message: null },
      "wa-web:messages.upsert"
    );
    expect(bare?.messageType).toBe("unknown");
  });

  it("filters Signal-protocol transport envelopes instead of archiving them as unknown messages", () => {
    // Sender-key distribution with no user content: protocol noise, no row.
    const skdmOnly = normalizeBaileysMessage(
      {
        key: { remoteJid: "12036000000000@g.us", id: "SKDM1", fromMe: false, participant: CHAT },
        messageTimestamp: 1_712_000_000,
        message: { senderKeyDistributionMessage: { groupId: "12036000000000@g.us" }, messageContextInfo: {} }
      },
      "wa-web:messages.upsert"
    );
    expect(skdmOnly).toBeNull();
    // The same envelope carrying real content stays a normal message.
    const skdmWithText = normalizeBaileysMessage(
      {
        key: { remoteJid: "12036000000000@g.us", id: "SKDM2", fromMe: false, participant: CHAT },
        messageTimestamp: 1_712_000_000,
        message: { senderKeyDistributionMessage: { groupId: "12036000000000@g.us" }, conversation: "hello group" }
      },
      "wa-web:messages.upsert"
    );
    expect(skdmWithText?.messageType).toBe("text");
    expect(skdmWithText?.body).toBe("hello group");
  });

  it("maps newer live content keys to the shared vocabulary", () => {
    const poll = normalizeBaileysMessage(
      { key: { remoteJid: CHAT, id: "PRS1" }, messageTimestamp: 1, message: { pollResultSnapshotMessage: { name: "Snapshot" } } },
      "wa-web:messages.upsert"
    );
    expect(poll?.messageType).toBe("poll");
    const placeholder = normalizeBaileysMessage(
      { key: { remoteJid: CHAT, id: "PH1" }, messageTimestamp: 1, message: { placeholderMessage: {} } },
      "wa-web:messages.upsert"
    );
    expect(placeholder?.messageType).toBe("waiting_for_message");
  });

  it("never lets a contentless re-delivery downgrade an archived classification, and removes protocol noise rows", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-type-guard-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      // A system stub arrives first (e.g. undecryptable placeholder), then an
      // empty unknown re-delivery for the same key: system must survive.
      await repository.upsertMessages([{ ...liveMediaMessage("GUARD1", 1000), messageType: "system", hasMedia: false, mediaMimeType: null }]);
      await repository.upsertMessages([{ ...liveMediaMessage("GUARD1", 1000), messageType: "unknown", hasMedia: false, mediaMimeType: null }]);
      // Legacy noise rows from before normalization filtered them.
      await repository.upsertMessages([
        { ...liveMediaMessage("SKDM-ROW", 2000), messageType: "unknown_senderKeyDistributionMessage", hasMedia: false, mediaMimeType: null }
      ]);
      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      let messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(messages.find((message) => message.sourceMessageId === "GUARD1")?.messageType).toBe("system");

      const removed = await repository.removeProtocolNoiseMessages();
      expect(removed).toBe(1);
      messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(messages.some((message) => message.sourceMessageId === "SKDM-ROW")).toBe(false);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("interprets deleted and media messages honestly", () => {
    // Deleted with nothing captured stays the placeholder.
    expect(interpretMessage({ messageType: "image", isDeleted: true, hasHeldContent: false })).toEqual({
      label: "Deleted message",
      reason: null
    });
    // Deleted with held content keeps the real kind.
    expect(interpretMessage({ messageType: "image", isDeleted: true, hasHeldContent: true, mediaAvailability: "stored" })).toEqual({
      label: "Photo",
      reason: null
    });
    // Deleted text with held content needs no interpretation at all.
    expect(interpretMessage({ messageType: "text", isDeleted: true, hasHeldContent: true })).toBeNull();
    // Stored view-once drops the old fixed claim entirely.
    expect(interpretMessage({ messageType: "view_once_image", mediaAvailability: "stored" })).toEqual({
      label: "View once photo",
      reason: null
    });
    expect(interpretMessage({ messageType: "view_once_video", mediaAvailability: "not_captured" })?.reason).toContain("offline");
    expect(interpretMessage({ messageType: "video", mediaAvailability: "expired_unrecoverable" })?.reason).toContain("expired");
    expect(interpretMessage({ messageType: "audio", mediaAvailability: "downloading" })?.reason).toBe("Media is downloading.");
  });
});

function liveMediaMessage(id: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(CHAT, id),
    sourceTable: "wa-web:messages.upsert",
    sourceRowId: id,
    chatSourceId: CHAT,
    senderSourceJid: CHAT,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: "image",
    rawTypeCode: "image",
    body: null,
    caption: null,
    hasMedia: true,
    mediaMimeType: "image/jpeg",
    mediaName: null,
    quotedSourceMessageId: null,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    rawMetadata: null
  };
}

function queueInput(id: string, options: { isViewOnce?: boolean; priority: number }) {
  return {
    messageKey: messageKey(CHAT, id),
    chatSourceId: CHAT,
    sourceMessageId: id,
    descriptor: makeDescriptor(id),
    thumbnail: new Uint8Array([1, 2, 3]),
    isViewOnce: Boolean(options.isViewOnce),
    priority: options.priority
  };
}

function makeDescriptor(id: string) {
  return {
    mediaType: "image" as const,
    mediaKey: Buffer.from(`key-${id}`).toString("base64"),
    directPath: `/v/${id}`,
    url: `https://mmg.whatsapp.net/v/${id}`,
    fileEncSha256: null,
    fileSha256: null,
    mediaKeyTimestamp: 1_712_000_000,
    mimeType: "image/jpeg",
    fileName: null,
    fileLength: 100,
    width: 800,
    height: 600,
    durationSeconds: null,
    retryKey: { remoteJid: CHAT, id, fromMe: false, participant: null }
  };
}

function makeQueueTask(id: string): MediaDownloadQueueRecord {
  return {
    id: 1,
    messageKey: messageKey(CHAT, id),
    chatSourceId: CHAT,
    sourceMessageId: id,
    descriptor: makeDescriptor(id),
    thumbnail: null,
    isViewOnce: false,
    status: "pending",
    attempts: 0,
    reuploadAttempts: 0,
    nextAttemptAtMs: null,
    lastError: null,
    priority: 0
  };
}
