import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../config";

// Content-addressed store for decrypted media blobs. Blobs live at a sharded
// path derived from sha256(plaintext), so identical forwarded/re-sent media is
// stored once and a stored path can never be guessed from chat metadata.
// Writes are atomic (temp file + rename): an interrupted write never registers
// as a stored asset. Blobs are effectively never deleted (retention across
// revoke is a requirement) — the single exception is WhatsApp Status excision,
// which reference-counts by sha256 before unlinking (see deleteBlob).

export interface StoredBlob {
  sha256: string;
  storagePath: string;
  byteSize: number;
}

export class MediaBlobStore {
  constructor(private readonly rootDir = config.media.rootDir) {}

  // Relative sharded path for a content hash: <ab>/<cd>/<sha256>.
  relativePathFor(sha256: string): string {
    return path.join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  absolutePath(storagePath: string): string {
    const resolved = path.resolve(this.rootDir, storagePath);
    const relative = path.relative(path.resolve(this.rootDir), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Media storage path escaped the media store root.");
    }
    return resolved;
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      await stat(this.absolutePath(this.relativePathFor(sha256)));
      return true;
    } catch {
      return false;
    }
  }

  async stat(storagePath: string): Promise<{ byteSize: number } | null> {
    try {
      const stats = await stat(this.absolutePath(storagePath));
      return stats.isFile() ? { byteSize: stats.size } : null;
    } catch {
      return null;
    }
  }

  openStream(storagePath: string, range?: { start: number; end: number }): fs.ReadStream {
    return fs.createReadStream(this.absolutePath(storagePath), range);
  }

  // Store decrypted bytes already in memory (live downloads).
  async putBytes(bytes: Uint8Array): Promise<StoredBlob> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storagePath = this.relativePathFor(sha256);
    const finalPath = this.absolutePath(storagePath);
    if (await this.exists(sha256)) {
      return { sha256, storagePath, byteSize: bytes.byteLength };
    }
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tempPath = `${finalPath}.tmp-${randomUUID()}`;
    try {
      await fs.promises.writeFile(tempPath, bytes);
      await renameIntoPlace(tempPath, finalPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    return { sha256, storagePath, byteSize: bytes.byteLength };
  }

  // Store an existing local file (import backfill): hash while copying so a
  // multi-GB folder is read once per file, then rename atomically.
  async putFile(sourcePath: string): Promise<StoredBlob> {
    const tempPath = path.join(this.rootDir, `.incoming-${randomUUID()}`);
    await mkdir(this.rootDir, { recursive: true });
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      const source = fs.createReadStream(sourcePath);
      source.on("data", (chunk) => {
        hash.update(chunk as Buffer);
        byteSize += (chunk as Buffer).length;
      });
      await pipeline(source, fs.createWriteStream(tempPath, { flags: "w" }));
      const sha256 = hash.digest("hex");
      const storagePath = this.relativePathFor(sha256);
      const finalPath = this.absolutePath(storagePath);
      if (await this.exists(sha256)) {
        return { sha256, storagePath, byteSize };
      }
      await mkdir(path.dirname(finalPath), { recursive: true });
      await renameIntoPlace(tempPath, finalPath);
      return { sha256, storagePath, byteSize };
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  // The one sanctioned exception to "blobs are never deleted": WhatsApp Status
  // excision. Because the store is content-addressed, the CALLER must prove no
  // surviving asset row references this hash — see exciseStatusBroadcast, which
  // computes the survivor set before deleting any row. Returns the bytes freed
  // (0 when the file was already gone, which keeps a re-run idempotent).
  async deleteBlob(storagePath: string): Promise<number> {
    const absolute = this.absolutePath(storagePath);
    const existing = await this.stat(storagePath);
    if (!existing) {
      return 0;
    }
    await rm(absolute, { force: true });
    return existing.byteSize;
  }
}

// Two writers can race on the same content hash; the loser's rename fails on
// Windows with the winner's identical bytes already in place — that is success.
async function renameIntoPlace(tempPath: string, finalPath: string): Promise<void> {
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    if (fs.existsSync(finalPath)) {
      return;
    }
    throw error;
  }
}

export const mediaBlobStore = new MediaBlobStore();
