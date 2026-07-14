import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";

describe("quoted snapshot local API", () => {
  it("projects a local snapshot and serves only its embedded thumbnail", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-quote-api-"));
    const archivePath = path.join(temp, "archive.sqlite");
    const workDir = path.join(temp, "work");
    const repository = new SqliteArchiveRepository(archivePath);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const run = await repository.startImportRun({ test: true });
      await repository.upsertContacts(run, [{ sourceJid: "quoted@s.whatsapp.net", displayName: "Saved quoted sender" }]);
      await repository.upsertChats(run, [{ sourceChatId: "quote-api@g.us", jid: "quote-api@g.us", displayName: "Quote API", chatType: "group" }]);
      await repository.upsertMessages([
        {
          sourceMessageId: "reply", sourceMessageKey: "", sourceTable: "test", sourceRowId: "reply",
          chatSourceId: "quote-api@g.us", senderSourceJid: "sender@s.whatsapp.net", timestampMs: 1,
          fromMe: false, direction: "incoming", messageType: "text", body: "reply", hasMedia: false,
          quotedSourceMessageId: "quoted", isDeleted: false, isForwarded: false, isStarred: false,
          quotedSnapshot: {
            quotedSourceMessageId: "quoted", quotedSourceChatId: "quote-api@g.us", quotedSenderSourceJid: "quoted@s.whatsapp.net",
            quotedFromMe: false, timestampMs: null, messageType: "image", body: null, caption: "captured caption",
            thumbnail: new Uint8Array([1, 2, 3]), mediaMimeType: "image/jpeg", mediaName: null,
            location: null, vcard: null, mentionedJids: []
          }
        },
        {
          sourceMessageId: "plain", sourceMessageKey: "", sourceTable: "test", sourceRowId: "plain",
          chatSourceId: "quote-api@g.us", senderSourceJid: "sender@s.whatsapp.net", timestampMs: 2,
          fromMe: false, direction: "incoming", messageType: "text", body: "plain", hasMedia: false,
          quotedSourceMessageId: null, quotedSnapshot: null, isDeleted: false, isForwarded: false, isStarred: false
        }
      ]);
      await repository.refreshChatStats();
      await repository.completeImportRun(run, { contacts: 1, chats: 1, participants: 0, messages: 2, skipped: 0, warnings: 0 }, 0);
      await repository.close();

      const port = 6400 + Math.floor(Math.random() * 1000);
      child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          APP_HOST: "127.0.0.1",
          APP_PORT: String(port),
          ARCHIVE_DB_PATH: archivePath,
          WAPP_WORK_DIR: workDir,
          LIVE_AUTO_RESUME: "0"
        },
        stdio: "ignore"
      });
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/api/status`);
      const chats = await fetchJson<Array<{ id: number }>>(`${base}/api/chats?limit=10&offset=0&includeEventOnly=true`);
      const messages = await fetchJson<Array<{ id: number; sourceMessageId: string; quotedSnapshot: Record<string, unknown> | null }>>(
        `${base}/api/chats/${chats[0]!.id}/messages?limit=10&offset=0`
      );
      const reply = messages.find((message) => message.sourceMessageId === "reply")!;
      const plain = messages.find((message) => message.sourceMessageId === "plain")!;

      expect(reply.quotedSnapshot).toMatchObject({
        quotedSenderDisplayName: "Saved quoted sender", caption: "captured caption", hasThumbnail: true
      });
      const thumbnail = await fetch(`${base}/api/messages/${reply.id}/quoted-thumbnail`);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
      expect(thumbnail.headers.get("cache-control")).toContain("private");
      expect([...new Uint8Array(await thumbnail.arrayBuffer())]).toEqual([1, 2, 3]);
      const missing = await fetch(`${base}/api/messages/${plain.id}/quoted-thumbnail`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toContain("No quoted-message thumbnail");
    } finally {
      if (child) {
        child.kill();
        await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      }
      await repository.close().catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  }, 90_000);
});

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Server cold-start can take a few seconds under tsx.
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
