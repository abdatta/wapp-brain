import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

// Local profile-photo cache for the People compare view. Photos are fetched
// server-side only when a live session can supply a URL, stored under the
// private workspace (never the archive database, never logged), and served
// cache-first with a bounded lifetime plus a negative cache so a missing
// photo doesn't trigger a fetch per open. Everything here is disposable.

const AVATAR_TTL_MS = 7 * 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;

interface AvatarMeta {
  fetchedAt: number;
  negative: boolean;
  mime?: string | null;
}

function avatarDir(): string {
  return path.join(path.dirname(config.archive.sqlitePath), "avatars");
}

function keyFor(jid: string): string {
  return crypto.createHash("sha256").update(jid).digest("hex").slice(0, 32);
}

function readMeta(metaPath: string): AvatarMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as AvatarMeta;
  } catch {
    return null;
  }
}

export interface CachedAvatar {
  filePath: string;
  mime: string;
}

// Cache-first avatar lookup. `fetchUrl` is optional: absent (no connected
// live session) means cache-or-nothing — a stale cached photo still serves
// (better a dated face than none), but nothing is fetched.
export async function getCachedAvatar(
  jid: string,
  fetchUrl?: (jid: string) => Promise<string | null>,
  options?: { dir?: string }
): Promise<CachedAvatar | null> {
  const dir = options?.dir ?? avatarDir();
  const key = keyFor(jid);
  const filePath = path.join(dir, `${key}.img`);
  const metaPath = path.join(dir, `${key}.json`);
  const meta = readMeta(metaPath);
  const fresh = meta != null && Date.now() - meta.fetchedAt < (meta.negative ? NEGATIVE_TTL_MS : AVATAR_TTL_MS);

  if (meta && fresh) {
    if (meta.negative) return null;
    if (fs.existsSync(filePath)) return { filePath, mime: meta.mime ?? "image/jpeg" };
  }
  if (!fetchUrl) {
    // No live session: serve whatever positive cache exists, even stale.
    if (meta && !meta.negative && fs.existsSync(filePath)) return { filePath, mime: meta.mime ?? "image/jpeg" };
    return null;
  }

  try {
    const url = await fetchUrl(jid);
    fs.mkdirSync(dir, { recursive: true });
    if (!url) {
      fs.writeFileSync(metaPath, JSON.stringify({ fetchedAt: Date.now(), negative: true } satisfies AvatarMeta));
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`avatar fetch ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      fs.writeFileSync(filePath, bytes);
      fs.writeFileSync(metaPath, JSON.stringify({ fetchedAt: Date.now(), negative: false, mime } satisfies AvatarMeta));
      return { filePath, mime };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fetch failed: keep any stale positive cache usable, else negative-cache
    // the failure so the dialog doesn't retry per open.
    if (fs.existsSync(filePath) && meta && !meta.negative) {
      return { filePath, mime: meta.mime ?? "image/jpeg" };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ fetchedAt: Date.now(), negative: true } satisfies AvatarMeta));
    } catch {
      // Cache write failures are silently non-fatal — this is disposable cache.
    }
    return null;
  }
}
