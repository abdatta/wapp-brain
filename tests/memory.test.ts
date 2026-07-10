import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { queryMemory, resolveMemoryCitation, runMemoryConsolidation, validateMemoryStore } from "../src/server/memory/consolidation";
import { enableCodexProvider } from "../src/server/memory/provider";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { ChatRecord, ContactRecord, MessageRecord } from "../src/shared/types";

describe("second-brain memory", () => {
  it("commits Obsidian-friendly Markdown pages with exact citations", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-memory-"));
    let repository: SqliteArchiveRepository | null = null;
    const restoreConfig = configureMemoryRoot(path.join(tempDir, "memory"));
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const baseTime = Date.now() - 3 * 86_400_000;
      await seedMemoryChat(repository, "chat@s.whatsapp.net", "Project Chat", [
        { text: "We decided to keep the wiki local.", at: baseTime },
        { text: "The citations need exact WhatsApp messages.", at: baseTime + 60_000 }
      ]);

      const result = await runMemoryConsolidation(repository, {
        kind: "manual",
        endAtMs: baseTime + 120_000
      });
      const page = result.pages[0];
      const markdown = await readFile(path.join(config.memory.rootDir, page.path), "utf8");
      const sidecarPath = path.join(config.memory.citationsDir, `${page.id}.json`);

      await expect(stat(sidecarPath)).resolves.toBeTruthy();
      expect(result.ok).toBe(true);
      expect(result.run.citationCount).toBe(2);
      expect(markdown).toContain("tags:");
      expect(markdown).toContain("second-brain");
      expect(markdown).toContain("citation m1");
      expect(markdown).toContain("^claim-1");
    } finally {
      await repository?.close();
      restoreConfig();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports dry-run evidence previews without committing pages", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-memory-preview-"));
    const restoreConfig = configureMemoryRoot(path.join(tempDir, "memory"));
    try {
      const repository = new MemoryArchiveRepository();
      await seedMemoryChat(repository, "preview@s.whatsapp.net", "Preview", [
        { text: "FAKE_SECRET_DO_NOT_LOG stays only in private preview output.", at: Date.now() - 2 * 86_400_000 }
      ]);

      const result = await runMemoryConsolidation(repository, { kind: "manual", dryRun: true });
      const status = await repository.getMemoryStatus({
        provider: "local",
        remoteModelEnabled: false,
        codexPackageAvailable: false,
        codexSessionExists: false,
        message: "local"
      });

      expect(result.previewPath).toBeTruthy();
      expect(status.pageCount).toBe(0);
      expect(JSON.stringify(status)).not.toContain("FAKE_SECRET_DO_NOT_LOG");
      await expect(stat(result.previewPath!)).resolves.toBeTruthy();
    } finally {
      restoreConfig();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("consolidates extractively even when the codex session opt-in is enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-memory-provider-"));
    const restoreConfig = configureMemoryRoot(path.join(tempDir, "memory"));
    try {
      const repository = new MemoryArchiveRepository();
      await seedMemoryChat(repository, "codex@s.whatsapp.net", "Codex", [
        { text: "Pages come from evidence, never a remote model.", at: Date.now() - 2 * 86_400_000 }
      ]);
      // The codex opt-in only manages the brain's shared OAuth session; memory
      // pages must stay extractive (a codex attempt would throw here — the
      // OAuth client package is not installed in tests).
      await enableCodexProvider();

      const result = await runMemoryConsolidation(repository, { kind: "manual" });

      expect(result.ok).toBe(true);
      expect(result.run.status).toBe("completed");
      expect(result.pages.length).toBeGreaterThan(0);
    } finally {
      restoreConfig();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("queries committed memory and short-term current messages together", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-memory-query-"));
    const restoreConfig = configureMemoryRoot(path.join(tempDir, "memory"));
    try {
      const repository = new MemoryArchiveRepository();
      const oldTime = Date.now() - 3 * 86_400_000;
      const currentTime = Date.now();
      await seedMemoryChat(repository, "mixed@s.whatsapp.net", "Mixed Memory", [
        { text: "The long term plan mentions brunch notes.", at: oldTime },
        { text: "Today's short term chat adds brunch at noon.", at: currentTime }
      ]);

      await runMemoryConsolidation(repository, { kind: "manual", endAtMs: oldTime + 60_000 });
      const result = await queryMemory(repository, "brunch");

      expect(result.evidence.some((item) => item.layer === "long_term")).toBe(true);
      expect(result.evidence.some((item) => item.layer === "short_term")).toBe(true);
      expect(result.citations.length).toBeGreaterThanOrEqual(2);
    } finally {
      restoreConfig();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks memory stale when cited messages disappear", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-memory-stale-"));
    const restoreConfig = configureMemoryRoot(path.join(tempDir, "memory"));
    try {
      const repository = new MemoryArchiveRepository();
      const oldTime = Date.now() - 2 * 86_400_000;
      await seedMemoryChat(repository, "stale@s.whatsapp.net", "Stale", [{ text: "This citation will disappear.", at: oldTime }]);
      const result = await runMemoryConsolidation(repository, { kind: "manual", endAtMs: oldTime + 60_000 });

      await repository.clearArchiveData();
      const validation = await validateMemoryStore(repository);
      const resolution = await resolveMemoryCitation(repository, "m1");

      expect(validation.ok).toBe(false);
      expect(validation.staleCount).toBe(1);
      expect(resolution.ok).toBe(false);
    } finally {
      restoreConfig();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function configureMemoryRoot(rootDir: string): () => void {
  const previous = { ...config.memory };
  config.memory.rootDir = rootDir;
  config.memory.pagesDir = path.join(rootDir, "pages");
  config.memory.citationsDir = path.join(rootDir, "citations");
  config.memory.runsDir = path.join(rootDir, "runs");
  config.memory.providerConfigPath = path.join(rootDir, "provider.json");
  config.memory.codexSessionPath = path.join(rootDir, "codex-session.json");
  return () => {
    Object.assign(config.memory, previous);
  };
}

async function seedMemoryChat(repository: ArchiveRepository, sourceChatId: string, displayName: string, messages: Array<{ text: string; at: number }>) {
  const runId = await repository.startImportRun({ fixture: "memory" });
  const contacts: ContactRecord[] = [
    { sourceJid: "me@s.whatsapp.net", displayName: "Me" },
    { sourceJid: "friend@s.whatsapp.net", displayName: "Friend" }
  ];
  const chats: ChatRecord[] = [{ sourceChatId, jid: sourceChatId, displayName, chatType: "dm" }];
  const records: MessageRecord[] = messages.map((message, index) => ({
    sourceMessageId: `msg-${index + 1}`,
    sourceMessageKey: `fixture|${sourceChatId}|${index + 1}`,
    sourceTable: "messages",
    sourceRowId: String(index + 1),
    chatSourceId: sourceChatId,
    senderSourceJid: index % 2 === 0 ? "friend@s.whatsapp.net" : "me@s.whatsapp.net",
    timestampMs: message.at,
    sentAtIso: new Date(message.at).toISOString(),
    fromMe: index % 2 === 1,
    direction: index % 2 === 1 ? "outgoing" : "incoming",
    messageType: "text",
    body: message.text,
    caption: null,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  }));
  await repository.upsertContacts(runId, contacts);
  await repository.upsertChats(runId, chats);
  await repository.upsertMessages(records);
  await repository.refreshChatStats();
  await repository.completeImportRun(runId, { contacts: contacts.length, chats: 1, participants: 0, messages: records.length, skipped: 0, warnings: 0 }, 0);
  await mkdir(config.memory.rootDir, { recursive: true });
}
