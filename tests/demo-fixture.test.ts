// The curated demo dataset must import through the REAL importer and land the
// content demo mode promises: named contacts, two 1:1 and two group chats,
// reactions, a quoted reply, a link preview, an edited message, and media
// placeholders — deterministically, so a re-generated fixture produces the
// same archive.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { createDemoFixture } from "../src/server/import/fixtures";
import { runImport } from "../src/server/import/importer";

describe("demo fixture", () => {
  it("imports the curated demo scenario with reactions, quotes, links, edits, and media", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-demo-fixture-"));
    try {
      const fixture = await createDemoFixture(path.join(tempDir, "fixture"));
      const repository = new MemoryArchiveRepository();
      const summary = await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });

      expect(summary.chats).toBe(4);
      expect(summary.messages).toBeGreaterThanOrEqual(50);

      const chats = await repository.listChats({ limit: 20, offset: 0 });
      const names = chats.map((chat) => chat.displayName);
      expect(names).toContain("Avery Patel");
      expect(names).toContain("Grace Okafor");
      expect(names).toContain("Saturday Hike Crew");
      expect(names).toContain("Lakeside Trip Planning");
      const groups = chats.filter((chat) => chat.chatType === "group");
      expect(groups).toHaveLength(2);

      // A quoted reply resolves to a snapshot in the thread projection.
      const avery = chats.find((chat) => chat.displayName === "Avery Patel");
      expect(avery).toBeTruthy();
      const averyMessages = await repository.listMessages(avery!.id, { limit: 100, offset: 0, order: "asc" });
      const reply = averyMessages.find((message) => message.body === "Perfect. 12:30?");
      expect(reply?.quotedSnapshot?.body).toContain("noodle place");

      // The lunch-time correction is visibly an edit.
      const edited = averyMessages.find((message) => message.body?.includes("1pm"));
      expect(edited).toBeTruthy();
      expect(edited!.isEdited || edited!.structuredSignals?.edit != null).toBe(true);

      // The shared article carries its sender-embedded link preview.
      const linked = averyMessages.find((message) => message.body?.includes("slow travel"));
      expect(linked?.linkPreview?.canonicalUrl).toBe("https://example.test/slow-travel");

      // Media placeholders: the recipe photo and the transcribed voice note.
      const grace = chats.find((chat) => chat.displayName === "Grace Okafor");
      const graceMessages = await repository.listMessages(grace!.id, { limit: 100, offset: 0, order: "asc" });
      expect(graceMessages.some((message) => message.hasMedia && message.mediaMimeType === "image/jpeg")).toBe(true);
      expect(graceMessages.some((message) => message.hasMedia && (message.mediaMimeType ?? "").startsWith("audio/"))).toBe(true);

      // Reactions land as applied live-style updates and attach to evidence.
      const evidence = await repository.listMemoryEvidenceMessages({ limit: 500 });
      const reacted = evidence.filter((message) => message.reactions.length > 0);
      expect(reacted.length).toBeGreaterThanOrEqual(3);
      const emojis = reacted.flatMap((message) => message.reactions.map((reaction) => reaction.emoji));
      expect(emojis).toContain("🎉");

      // Determinism: regenerating the fixture yields an identical import.
      const fixtureAgain = await createDemoFixture(path.join(tempDir, "fixture-again"));
      const repositoryAgain = new MemoryArchiveRepository();
      const summaryAgain = await runImport(repositoryAgain, {
        msgstorePath: fixtureAgain.msgstorePath,
        waPath: fixtureAgain.waPath
      });
      expect(summaryAgain.messages).toBe(summary.messages);
      const chatsAgain = await repositoryAgain.listChats({ limit: 20, offset: 0 });
      expect(chatsAgain.map((chat) => [chat.displayName, chat.messageCount])).toEqual(
        chats.map((chat) => [chat.displayName, chat.messageCount])
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);
});
