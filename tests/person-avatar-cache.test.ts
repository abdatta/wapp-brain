import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCachedAvatar } from "../src/server/persons/avatarCache";

const JID = "919000000001@s.whatsapp.net";
// 1x1 transparent PNG; node's fetch resolves data: URLs locally — no network.
const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-avatar-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("avatar cache", () => {
  it("fetches once, then serves from cache without calling the fetcher again", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return DATA_URL;
    };
    const first = await getCachedAvatar(JID, fetcher, { dir });
    expect(first?.mime).toBe("image/png");
    expect(fs.existsSync(first!.filePath)).toBe(true);
    const second = await getCachedAvatar(JID, fetcher, { dir });
    expect(second?.filePath).toBe(first?.filePath);
    expect(calls).toBe(1);
  });

  it("negative-caches a missing photo so repeated opens don't refetch", async () => {
    let calls = 0;
    const nullFetcher = async () => {
      calls += 1;
      return null;
    };
    expect(await getCachedAvatar(JID, nullFetcher, { dir })).toBeNull();
    // Within the negative TTL, even a now-working fetcher is not consulted.
    expect(await getCachedAvatar(JID, async () => DATA_URL, { dir })).toBeNull();
    expect(calls).toBe(1);
  });

  it("expired TTL refetches; without a fetcher a stale photo still serves and a miss is an immediate null", async () => {
    await getCachedAvatar(JID, async () => DATA_URL, { dir });
    // Age the meta far past the TTL.
    const metaPath = fs.readdirSync(dir).find((file) => file.endsWith(".json"))!;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, metaPath), "utf8"));
    fs.writeFileSync(path.join(dir, metaPath), JSON.stringify({ ...meta, fetchedAt: Date.now() - 30 * 24 * 60 * 60_000 }));

    // No live session: the stale photo still serves, nothing fetched.
    const stale = await getCachedAvatar(JID, undefined, { dir });
    expect(stale).not.toBeNull();

    // Live session: the stale entry refetches.
    let calls = 0;
    await getCachedAvatar(
      JID,
      async () => {
        calls += 1;
        return DATA_URL;
      },
      { dir }
    );
    expect(calls).toBe(1);

    // Unknown identity with no fetcher: immediate miss, no files written.
    expect(await getCachedAvatar("other@s.whatsapp.net", undefined, { dir })).toBeNull();
  });

  it("a failing fetch falls back to the stale photo instead of erasing it", async () => {
    await getCachedAvatar(JID, async () => DATA_URL, { dir });
    const metaPath = fs.readdirSync(dir).find((file) => file.endsWith(".json"))!;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, metaPath), "utf8"));
    fs.writeFileSync(path.join(dir, metaPath), JSON.stringify({ ...meta, fetchedAt: Date.now() - 30 * 24 * 60 * 60_000 }));
    const result = await getCachedAvatar(
      JID,
      async () => {
        throw new Error("socket busy");
      },
      { dir }
    );
    expect(result).not.toBeNull();
  });
});
