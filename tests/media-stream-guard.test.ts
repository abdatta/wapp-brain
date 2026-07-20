import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { MediaDownloadQueueRecord } from "../src/shared/types";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { collectMediaStream, downloadQueuedMedia } from "../src/server/media/downloader";
import { createUncaughtExceptionGuard, isSurvivableStreamTeardown } from "../src/server/diagnostics/processGuards";
import { messageKey } from "../src/server/identity/keys";

const CHAT = "15550001111@s.whatsapp.net";

// The exact error undici raises when the media CDN resets the connection
// mid-body (production crash 2026-07-20): Fetch.onAborted destroys its
// internal Readable with TypeError("terminated"), cause read ECONNRESET.
function undiciTerminated(): Error {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  return Object.assign(new TypeError("terminated"), { cause });
}

// Baileys' downloadEncryptedContent shape (7.0.0-rc13 messages-media.js:515):
// the HTTP source Readable piped into a decrypt Transform, with the caller
// only ever seeing the Transform. pipe() does not forward source errors.
function baileysShapedStream(options: { failMidStream?: Error } = {}): Transform {
  const source = new Readable({ read() {} });
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    }
  });
  source.pipe(output, { end: true });
  source.push(Buffer.from("part-1|"));
  if (options.failMidStream) {
    // One tick later, mimicking undici's teardown of the body stream after
    // the first chunk already flowed.
    setImmediate(() => source.destroy(options.failMidStream));
  } else {
    source.push(Buffer.from("part-2"));
    source.push(null);
  }
  return output;
}

describe("media stream guard", () => {
  it("collects a clean piped stream to a buffer", async () => {
    const bytes = await collectMediaStream(() => baileysShapedStream());
    expect(bytes.toString()).toBe("part-1|part-2");
  });

  it("rejects into the caller when the CDN source dies mid-stream, without an unhandled 'error' crash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(collectMediaStream(() => baileysShapedStream({ failMidStream: undiciTerminated() }))).rejects.toThrow(
        "terminated"
      );
      // Give teardown races time to surface; vitest fails the file if any
      // unhandled 'error' event escapes here (this is the process-survival
      // assertion — without the domain guard this test run dies).
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("absorbs stream errors that surface after the iterator already settled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let lateSource: Readable | null = null;
      const bytes = await collectMediaStream(() => {
        // An internal stream Baileys/undici created but never handed to the
        // consumer; it outlives the download and errors during teardown.
        lateSource = new Readable({ read() {} });
        const output = new Transform({
          transform(chunk, _encoding, callback) {
            callback(null, chunk);
          }
        });
        output.end(Buffer.from("all-bytes"));
        return output;
      });
      expect(bytes.toString()).toBe("all-bytes");
      lateSource!.destroy(undiciTerminated());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("after settle"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("read ECONNRESET"));
    } finally {
      warn.mockRestore();
    }
  });

  it("turns a mid-stream reset into a transient outcome carrying the socket cause", async () => {
    const outcome = await downloadQueuedMedia(
      makeQueueTask("MID1"),
      { allowReupload: true },
      { fetchContent: () => collectMediaStream(() => baileysShapedStream({ failMidStream: undiciTerminated() })) }
    );
    expect(outcome.status).toBe("transient");
    expect(outcome.error).toBe("terminated (read ECONNRESET)");
  });

  it("leaves the queue row retryable after a mid-stream reset, exactly as the maintainer records it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-media-guard-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([mediaMessage("MID2", 1000)]);
      await repository.enqueueMediaDownloads([
        {
          messageKey: messageKey(CHAT, "MID2"),
          chatSourceId: CHAT,
          sourceMessageId: "MID2",
          descriptor: makeDescriptor("MID2"),
          thumbnail: null,
          isViewOnce: false,
          priority: 0
        }
      ]);
      const [claimed] = await repository.claimDueMediaDownloads(1);
      expect(claimed).toBeDefined();

      const outcome = await downloadQueuedMedia(
        claimed,
        { allowReupload: false },
        { fetchContent: () => collectMediaStream(() => baileysShapedStream({ failMidStream: undiciTerminated() })) }
      );
      expect(outcome.status).toBe("transient");
      // The maintainer's transient branch: back off and requeue.
      await repository.markMediaDownloadRetry(claimed.id!, outcome.error ?? "Media download failed.", Date.now() - 1);

      const [reclaimed] = await repository.claimDueMediaDownloads(1);
      expect(reclaimed?.messageKey).toBe(messageKey(CHAT, "MID2"));
      expect(reclaimed?.attempts).toBe(1);
      expect(reclaimed?.lastError).toBe("terminated (read ECONNRESET)");
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies survivable network teardowns without loosening unknown failures", () => {
    expect(isSurvivableStreamTeardown(undiciTerminated())).toBe(true);
    expect(isSurvivableStreamTeardown(new TypeError("terminated"))).toBe(true);
    expect(isSurvivableStreamTeardown(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(true);
    // Nested one level deeper than undici's shape still resolves.
    expect(
      isSurvivableStreamTeardown(
        new Error("wrapper", { cause: new Error("inner", { cause: Object.assign(new Error("reset"), { code: "ECONNABORTED" }) }) })
      )
    ).toBe(true);
    expect(isSurvivableStreamTeardown(new Error("terminated"))).toBe(false);
    expect(isSurvivableStreamTeardown(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isSurvivableStreamTeardown(new Error("archive corrupted"))).toBe(false);
    expect(isSurvivableStreamTeardown(null)).toBe(false);
  });

  it("logs and survives teardown exceptions at process level but stays fatal for everything else", () => {
    const log = vi.fn();
    const fatal = vi.fn();
    const guard = createUncaughtExceptionGuard({ log, fatal });

    guard(undiciTerminated(), "uncaughtException");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("terminated ← read ECONNRESET"));
    expect(fatal).not.toHaveBeenCalled();

    const corrupt = new Error("database disk image is malformed");
    guard(corrupt, "uncaughtException");
    expect(fatal).toHaveBeenCalledWith(corrupt);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

function mediaMessage(id: string, timestampMs: number) {
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
    direction: "incoming" as const,
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
