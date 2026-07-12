import type { MediaDownloadDescriptor, MediaDownloadQueueRecord } from "../../shared/types";
import type { MediaDownloadOutcome } from "../live/types";

// Media download for queued descriptors. The primary path is strictly passive:
// an HTTPS fetch of the encrypted blob from WhatsApp's media CDN plus a local
// AES decrypt with the captured media key — nothing is sent to anyone, and no
// read/played receipt or presence signal is ever produced, so view-once state
// on the phone is untouched. When the CDN link has expired, the ONE sanctioned
// outbound is a media re-upload request (updateMediaMessage), which asks
// WhatsApp to re-provide the encrypted file; it carries no content and is not
// a receipt. Callers bound and rate-limit re-upload attempts.

type FetchContent = (
  downloadable: { mediaKey: Buffer; directPath?: string; url?: string },
  mediaType: MediaDownloadDescriptor["mediaType"]
) => Promise<Buffer>;

export interface MediaDownloadDependencies {
  fetchContent?: FetchContent;
  // The live socket's updateMediaMessage, injected so tests can stub it and so
  // the read-only guard allowance stays the only path to it.
  requestReupload?: ((message: Record<string, unknown>) => Promise<Record<string, unknown>>) | null;
}

// Socket-facing awaits must be bounded: a CDN fetch can stall mid-stream, and
// a re-upload request waits on the ORIGINAL SENDER's phone, which may never
// answer. An unbounded await here wedges the media pass permanently (workers
// never return, mediaPassRunning never clears) — observed in the field
// 2026-07-12 with 8 workers stuck on updateMediaMessage for 10+ minutes.
const FETCH_TIMEOUT_MS = 120_000;
const REUPLOAD_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function downloadQueuedMedia(
  task: MediaDownloadQueueRecord,
  options: { allowReupload: boolean },
  dependencies: MediaDownloadDependencies = {}
): Promise<MediaDownloadOutcome> {
  const fetchContent = dependencies.fetchContent ?? fetchContentFromWhatsApp;
  const descriptor = task.descriptor;
  const downloadable = {
    mediaKey: Buffer.from(descriptor.mediaKey, "base64"),
    directPath: descriptor.directPath ?? undefined,
    url: descriptor.url ?? undefined
  };
  try {
    const bytes = await withTimeout(fetchContent(downloadable, descriptor.mediaType), FETCH_TIMEOUT_MS, "Media download");
    if (bytes.length === 0) {
      return { status: "transient", usedReupload: false, error: "Media download returned no bytes." };
    }
    return { status: "stored", bytes, usedReupload: false };
  } catch (error) {
    if (!isExpiredMediaError(error)) {
      return { status: "transient", usedReupload: false, error: shortError(error) };
    }
    if (!options.allowReupload || !dependencies.requestReupload) {
      return { status: "expired", usedReupload: false, error: shortError(error) };
    }
  }
  // Expired link: send the scoped media re-upload request, then fetch the
  // refreshed direct path. updateMediaMessage mutates the passed content in
  // place with the re-provided location.
  const retryMessage = buildMediaRetryMessage(task);
  if (!retryMessage) {
    return { status: "expired", usedReupload: false, error: "Media link expired and no retry key was captured." };
  }
  try {
    const updated = await withTimeout(dependencies.requestReupload(retryMessage), REUPLOAD_TIMEOUT_MS, "Media re-upload request");
    const refreshed = mediaContentOf(updated ?? retryMessage);
    const refreshedDownloadable = {
      mediaKey: Buffer.from(descriptor.mediaKey, "base64"),
      directPath: nonEmpty(refreshed?.directPath) ?? descriptor.directPath ?? undefined,
      url: nonEmpty(refreshed?.url) ?? undefined
    };
    const bytes = await withTimeout(fetchContent(refreshedDownloadable, descriptor.mediaType), FETCH_TIMEOUT_MS, "Re-uploaded media download");
    if (bytes.length === 0) {
      return { status: "expired", usedReupload: true, error: "Re-uploaded media download returned no bytes." };
    }
    return { status: "stored", bytes, usedReupload: true };
  } catch (retryError) {
    return { status: "expired", usedReupload: true, error: shortError(retryError) };
  }
}

async function fetchContentFromWhatsApp(
  downloadable: { mediaKey: Buffer; directPath?: string; url?: string },
  mediaType: MediaDownloadDescriptor["mediaType"]
): Promise<Buffer> {
  const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
  const stream = await downloadContentFromMessage(downloadable, mediaType as never, {});
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// Minimal WebMessageInfo shape updateMediaMessage needs: the exact platform
// key of the original delivery plus a media content carrying the media key.
export function buildMediaRetryMessage(task: MediaDownloadQueueRecord): Record<string, unknown> | null {
  const descriptor = task.descriptor;
  const retryKey = descriptor.retryKey;
  if (!retryKey?.remoteJid || !retryKey.id) {
    return null;
  }
  const contentKey = MEDIA_CONTENT_KEY[descriptor.mediaType];
  return {
    key: {
      remoteJid: retryKey.remoteJid,
      id: retryKey.id,
      fromMe: retryKey.fromMe ?? false,
      ...(retryKey.participant ? { participant: retryKey.participant } : {})
    },
    message: {
      [contentKey]: {
        mediaKey: Buffer.from(descriptor.mediaKey, "base64"),
        ...(descriptor.directPath ? { directPath: descriptor.directPath } : {}),
        ...(descriptor.url ? { url: descriptor.url } : {}),
        ...(descriptor.fileEncSha256 ? { fileEncSha256: Buffer.from(descriptor.fileEncSha256, "base64") } : {}),
        ...(descriptor.fileSha256 ? { fileSha256: Buffer.from(descriptor.fileSha256, "base64") } : {}),
        ...(descriptor.mimeType ? { mimetype: descriptor.mimeType } : {}),
        ...(descriptor.mediaKeyTimestamp != null ? { mediaKeyTimestamp: descriptor.mediaKeyTimestamp } : {})
      }
    }
  };
}

const MEDIA_CONTENT_KEY: Record<MediaDownloadDescriptor["mediaType"], string> = {
  image: "imageMessage",
  video: "videoMessage",
  audio: "audioMessage",
  document: "documentMessage",
  sticker: "stickerMessage",
  ptv: "ptvMessage"
};

function mediaContentOf(message: Record<string, unknown>): { directPath?: unknown; url?: unknown } | null {
  const content = message.message as Record<string, unknown> | undefined;
  if (!content) {
    return null;
  }
  for (const key of Object.values(MEDIA_CONTENT_KEY)) {
    const media = content[key];
    if (media && typeof media === "object") {
      return media as { directPath?: unknown; url?: unknown };
    }
  }
  return null;
}

// CDN links expire with 404/410 (and occasionally 403); everything else is
// treated as transient and retried with backoff.
export function isExpiredMediaError(error: unknown): boolean {
  const statusCode =
    (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode ??
    (error as { response?: { status?: number } } | undefined)?.response?.status ??
    (error as { status?: number } | undefined)?.status;
  if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("404") || message.includes("410") || message.includes("not found") || message.includes("gone");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Media download failed.";
}
