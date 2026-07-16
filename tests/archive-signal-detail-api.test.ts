import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";

describe("focused archive signal detail API", () => {
  it("keeps rich values off the list route and returns them only from local detail/download routes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-detail-api-"));
    const archivePath = path.join(directory, "archive.sqlite");
    const workDir = path.join(directory, "work");
    const repository = new SqliteArchiveRepository(archivePath);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const runId = await repository.startImportRun({ source: "detail-api" });
      const chatSourceId = "detail-api@g.us";
      const sourceMessageId = "detail-api-message";
      const sourceMessageKey = messageKey(chatSourceId, sourceMessageId);
      await repository.upsertChats(runId, [{ sourceChatId: chatSourceId, jid: chatSourceId, displayName: "Detail API", chatType: "group" }]);
      await repository.upsertMessages([{
        sourceMessageId, sourceMessageKey, sourceTable: "test", sourceRowId: "1", chatSourceId, senderSourceJid: "15550000001@s.whatsapp.net",
        timestampMs: 1_711_000_000_000, fromMe: false, direction: "incoming", messageType: "text", body: "message", caption: null,
        hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false
      }]);
      const rawVcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:API Card\r\nX-LOCAL-TEST:retained\r\nEND:VCARD\r\n";
      await repository.upsertArchiveSignals({
        locations: [{ sourceMessageKey, latitude: 37.77, longitude: -122.42, name: "Detail place", address: null, isLive: false, accuracyMeters: 2, source: "backup", sourceEventKey: "backup:detail-api", observedAtMs: 1_711_000_001_000, captureVersion: 1 }],
        vcards: [{ sourceMessageKey, cardIndex: 0, displayName: "API Card", vcard: rawVcard, resolvedJid: null, downloadKind: "source", source: "backup", sourceEventKey: "backup:detail-api", observedAtMs: 1_711_000_001_000, captureVersion: 1 }],
        mediaInterpretations: [{ sourceMessageKey, kind: "transcription", segmentIndex: 0, text: "detail-only transcript", startMs: null, endMs: null, source: "backup", sourceEventKey: "backup:detail-api", observedAtMs: 1_711_000_001_000, captureVersion: 1 }]
      });
      await repository.refreshChatStats();
      await repository.close();

      const port = 6500 + Math.floor(Math.random() * 500);
      child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, APP_HOST: "127.0.0.1", APP_PORT: String(port), ARCHIVE_DB_PATH: archivePath, WAPP_WORK_DIR: workDir, LIVE_AUTO_RESUME: "0" },
        stdio: "ignore"
      });
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/api/status`);
      const chats = await fetchJson<Array<{ id: number }>>(`${base}/api/chats?limit=10&offset=0&includeEventOnly=true`);
      const messages = await fetchJson<Array<{ id: number }>>(`${base}/api/chats/${chats[0]!.id}/messages?limit=10&offset=0`);
      const listResponse = await fetch(`${base}/api/chats/${chats[0]!.id}/messages?limit=10&offset=0`);
      const listText = await listResponse.text();
      const detail = await fetchJson<{ locations: Array<{ latitude: number; longitude: number }>; mediaInterpretations: Array<{ text: string }> }>(`${base}/api/messages/${messages[0]!.id}/detail`);
      const download = await fetch(`${base}/api/messages/${messages[0]!.id}/vcards/0/download`);

      expect(listText).not.toContain("37.77");
      expect(listText).not.toContain("detail-only transcript");
      expect(listText).not.toContain("BEGIN:VCARD");
      expect(detail.locations[0]).toMatchObject({ latitude: 37.77, longitude: -122.42 });
      expect(detail.mediaInterpretations[0]?.text).toBe("detail-only transcript");
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("text/vcard; charset=utf-8");
      expect(download.headers.get("cache-control")).toContain("private");
      expect(download.headers.get("content-disposition")).toContain('filename="API Card.vcf"');
      expect(await download.text()).toBe(rawVcard);
    } finally {
      if (child) {
        child.kill();
        await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      }
      await repository.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The loopback TypeScript server may take a few seconds to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
