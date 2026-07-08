import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImportProgressEvent, ImportWarning } from "../../shared/types";
import type { ArchiveRepository } from "../db/repository";
import type { MediaBlobStore } from "../media/blobStore";
import { messageKey } from "../identity/keys";
import { PublicError } from "../privacy";
import type { ImportMediaRef } from "./parser";

// Import-side media ingestion: walk the user's WhatsApp media folder directly
// on disk (never through a browser upload), match each media message's sidecar
// ref to a file — content hash first, then recorded path, then unique name —
// copy matches into the content-addressed store, and link media_assets rows
// with import provenance. Missing/unreadable/ambiguous files warn (privacy-
// safe, counts only) and mark the message import_missing by absence; message
// import NEVER aborts because of media.

const PROGRESS_EVERY_REFS = 100;
const MAX_HASH_CANDIDATES_PER_REF = 4;

// Directory names ignored during the walk: caches and hidden state that no
// message mapping points into. Direct path resolution still reaches inside
// them when a mapping explicitly does.
const SKIPPED_DIRECTORY_PREFIXES = ["."];

export interface MediaBackfillSummary {
  processedRefs: number;
  matchedRefs: number;
  copiedAssets: number;
  missingRefs: number;
  ambiguousRefs: number;
  unreadableFiles: number;
  warningCount: number;
}

export interface MediaBackfillOptions {
  repository: ArchiveRepository;
  store: MediaBlobStore;
  mediaRoot: string;
  refs: Iterable<ImportMediaRef>;
  totalRefs?: number | null;
  onProgress?: (event: ImportProgressEvent) => void;
  signal?: AbortSignal;
  resolveChatSourceId?: (jid: string) => Promise<string>;
}

interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  normalizedRelative: string;
  size: number;
}

interface FolderIndex {
  byNormalizedRelative: Map<string, WalkedFile>;
  byBasename: Map<string, WalkedFile[]>;
  fileCount: number;
}

export async function runImportMediaBackfill(options: MediaBackfillOptions): Promise<MediaBackfillSummary> {
  const summary: MediaBackfillSummary = {
    processedRefs: 0,
    matchedRefs: 0,
    copiedAssets: 0,
    missingRefs: 0,
    ambiguousRefs: 0,
    unreadableFiles: 0,
    warningCount: 0
  };
  const index = walkMediaFolder(options.mediaRoot, summary);
  const hashCache = new Map<string, string | null>();
  const emitProgress = () => {
    options.onProgress?.({
      type: "media-progress",
      processedRefs: summary.processedRefs,
      matchedRefs: summary.matchedRefs,
      copiedAssets: summary.copiedAssets,
      missingRefs: summary.missingRefs,
      warningCount: summary.warningCount,
      totalRefs: options.totalRefs ?? null
    });
  };
  emitProgress();
  for (const ref of options.refs) {
    throwIfAborted(options.signal);
    summary.processedRefs += 1;
    const match = matchRefToFile(ref, index, hashCache, summary);
    if (!match) {
      summary.missingRefs += 1;
    } else {
      try {
        const blob = await options.store.putFile(match.absolutePath);
        const chatSourceId = options.resolveChatSourceId ? await options.resolveChatSourceId(ref.chatSourceId) : ref.chatSourceId;
        await options.repository.linkMediaAsset({
          messageKey: messageKey(chatSourceId, ref.sourceMessageId),
          chatSourceId,
          sha256: blob.sha256,
          storagePath: blob.storagePath,
          mimeType: ref.mimeType,
          byteSize: blob.byteSize,
          width: ref.width,
          height: ref.height,
          durationMs: ref.durationMs,
          thumbnail: ref.thumbnail,
          source: "import-folder",
          isViewOnce: ref.isViewOnce
        });
        summary.matchedRefs += 1;
        summary.copiedAssets += 1;
      } catch {
        // Unreadable at copy time (permissions, vanished file, cloud-synced
        // placeholder): the message stays import_missing, never an abort.
        summary.unreadableFiles += 1;
        summary.missingRefs += 1;
      }
    }
    if (summary.processedRefs % PROGRESS_EVERY_REFS === 0) {
      emitProgress();
      // Long walks over slow disks must not starve the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  summary.warningCount = summary.missingRefs > 0 || summary.ambiguousRefs > 0 || summary.unreadableFiles > 0 ? 1 : 0;
  emitProgress();
  return summary;
}

// Privacy-safe summary warning for the import run (counts only, no paths).
export function mediaBackfillWarning(summary: MediaBackfillSummary): ImportWarning {
  return {
    severity: summary.missingRefs > 0 ? "warning" : "info",
    code: "MEDIA_INGEST_SUMMARY",
    entityType: "message",
    message:
      `Media ingestion: ${summary.matchedRefs.toLocaleString()} of ${summary.processedRefs.toLocaleString()} media messages matched and archived` +
      `${summary.missingRefs ? `, ${summary.missingRefs.toLocaleString()} missing from the folder` : ""}` +
      `${summary.ambiguousRefs ? ` (${summary.ambiguousRefs.toLocaleString()} ambiguous)` : ""}` +
      `${summary.unreadableFiles ? `, ${summary.unreadableFiles.toLocaleString()} unreadable` : ""}.`,
    context: { ...summary }
  };
}

// Hash-first matching: when the backup recorded a content hash, any file with
// that hash IS the media. Fall back to the recorded relative path, then to a
// unique basename (size-filtered). Multiple surviving candidates are
// ambiguous — warn, never guess.
function matchRefToFile(
  ref: ImportMediaRef,
  index: FolderIndex,
  hashCache: Map<string, string | null>,
  summary: MediaBackfillSummary
): WalkedFile | null {
  const wantedHashHex = ref.fileHashB64 ? base64ToHex(ref.fileHashB64) : null;
  const candidates: WalkedFile[] = [];
  const pathCandidate = ref.filePath ? resolveByRecordedPath(ref.filePath, index) : null;
  if (pathCandidate) {
    candidates.push(pathCandidate);
  }
  const basename = ref.filePath ? path.basename(normalizeSeparators(ref.filePath)) : ref.mediaName;
  if (basename) {
    for (const candidate of index.byBasename.get(basename.toLowerCase()) ?? []) {
      if (!candidates.some((existing) => existing.absolutePath === candidate.absolutePath)) {
        candidates.push(candidate);
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  // Verify by hash when the backup recorded one and the candidate set is
  // small enough to hash; a hash match ends the search immediately.
  if (wantedHashHex && candidates.length <= MAX_HASH_CANDIDATES_PER_REF) {
    for (const candidate of candidates) {
      const hash = hashFileCached(candidate.absolutePath, hashCache, summary);
      if (hash === wantedHashHex) {
        return candidate;
      }
    }
  }
  // No hash verdict: prefer the recorded-path candidate, then size agreement.
  if (pathCandidate) {
    return pathCandidate;
  }
  const sized = ref.fileSize != null ? candidates.filter((candidate) => candidate.size === ref.fileSize) : candidates;
  const pool = sized.length > 0 ? sized : candidates;
  if (pool.length === 1) {
    return pool[0];
  }
  summary.ambiguousRefs += 1;
  return null;
}

// Recorded paths look like "Media/WhatsApp Images/IMG-x.jpg"; the selected
// root may be the phone root, the WhatsApp folder, the Media folder, or a
// single subfolder. Match by longest relative-path suffix.
function resolveByRecordedPath(recordedPath: string, index: FolderIndex): WalkedFile | null {
  const normalized = normalizeSeparators(recordedPath).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    const suffix = segments.slice(start).join("/");
    const hit = index.byNormalizedRelative.get(suffix);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function walkMediaFolder(root: string, summary: MediaBackfillSummary): FolderIndex {
  const index: FolderIndex = { byNormalizedRelative: new Map(), byBasename: new Map(), fileCount: 0 };
  const resolvedRoot = path.resolve(root);
  const pending: string[] = [resolvedRoot];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      summary.unreadableFiles += 1;
      continue;
    }
    for (const entry of entries) {
      // Never follow symlinks: a link pointing outside the selected root must
      // not pull unrelated files into the archive.
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
          continue;
        }
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(absolutePath).size;
      } catch {
        summary.unreadableFiles += 1;
        continue;
      }
      const relativePath = path.relative(resolvedRoot, absolutePath);
      const file: WalkedFile = {
        absolutePath,
        relativePath,
        normalizedRelative: normalizeSeparators(relativePath).toLowerCase(),
        size
      };
      index.byNormalizedRelative.set(file.normalizedRelative, file);
      const basename = entry.name.toLowerCase();
      index.byBasename.set(basename, [...(index.byBasename.get(basename) ?? []), file]);
      index.fileCount += 1;
    }
  }
  return index;
}

function hashFileCached(absolutePath: string, cache: Map<string, string | null>, summary: MediaBackfillSummary): string | null {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const hash = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    cache.set(absolutePath, hash);
    return hash;
  } catch {
    summary.unreadableFiles += 1;
    cache.set(absolutePath, null);
    return null;
  }
}

function base64ToHex(value: string): string | null {
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 ? bytes.toString("hex") : null;
  } catch {
    return null;
  }
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PublicError("IMPORT_CANCELLED", "Import stopped by user request.");
  }
}
