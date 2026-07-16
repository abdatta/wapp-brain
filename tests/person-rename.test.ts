import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";

const A = "919000000001@s.whatsapp.net";

async function withRepository<T>(
  kind: "memory" | "sqlite",
  run: (repository: ArchiveRepository) => Promise<T>
): Promise<T> {
  if (kind === "memory") {
    return run(new MemoryArchiveRepository());
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-rename-"));
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`user-set names (${kind})`, () => {
    it("outrank every enrichment source, propagate the stored winner to chats, and stay user-replaceable", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "rename-test" });
        await repository.upsertChats(runId, [{ sourceChatId: A, jid: A, chatType: "dm" }]);
        // User names the identity in-app.
        await repository.upsertContacts("user-rename", [
          { sourceJid: A, displayName: "Rohit (Landlord)", displayNameSource: "user", phoneNumber: A.split("@")[0] }
        ]);

        // A later wa.db-style import carries a different saved name: blocked.
        await repository.upsertContacts(runId, [{ sourceJid: A, displayName: "Rohit Sharma", phoneNumber: A.split("@")[0] }]);
        // Google enrichment carries yet another name: blocked (non-weak label).
        await repository.enrichContactsFromGoogle([{ phoneNumber: A.split("@")[0], displayName: "Rohit S." }]);

        const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
        expect(chats.find((chat) => chat.sourceChatId === A)?.displayName).toBe("Rohit (Landlord)");

        // Another user write replaces it.
        await repository.upsertContacts("user-rename", [
          { sourceJid: A, displayName: "Rohit Landlordji", displayNameSource: "user", phoneNumber: A.split("@")[0] }
        ]);
        const after = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
        expect(after.find((chat) => chat.sourceChatId === A)?.displayName).toBe("Rohit Landlordji");
      });
    });

    it("repairs episodes referring to the identity by number, with zero model calls", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "rename-test" });
        await repository.upsertChats(runId, [{ sourceChatId: A, jid: A, chatType: "dm" }]);
        await repository.upsertMessages([
          {
            sourceMessageId: "m-1",
            sourceMessageKey: messageKey(A, "m-1"),
            sourceTable: "message",
            sourceRowId: "1",
            chatSourceId: A,
            senderSourceJid: A,
            timestampMs: 1_710_000_000_000,
            sentAtIso: "2024-03-09T16:00:00.000Z",
            fromMe: false,
            direction: "incoming",
            messageType: "text",
            body: "I will pay the deposit tomorrow",
            caption: null,
            hasMedia: false,
            isDeleted: false,
            isForwarded: false,
            isStarred: false
          }
        ]);
        await repository.commitBrainEpisode({
          chatSourceId: A,
          startAtMs: 1_710_000_000_000,
          endAtMs: 1_710_000_000_000,
          messageCount: 1,
          participants: ["+919000000001"],
          summary: "+919000000001 promised to pay the deposit on 2024-03-10.",
          markdown: "",
          generator: "extractive",
          model: null,
          runId: null,
          extractionVersion: 4,
          unresolvedParticipants: [A],
          claims: [
            {
              kind: "commitment",
              text: "+919000000001 will pay the deposit on 2024-03-10.",
              citations: [messageKey(A, "m-1")],
              entities: [{ kind: "person", name: "+919000000001", jid: A }]
            }
          ]
        });

        await repository.upsertContacts("user-rename", [
          { sourceJid: A, displayName: "Rohit", displayNameSource: "user", phoneNumber: A.split("@")[0] }
        ]);

        const [episode] = await repository.listBrainEpisodes({ limit: 5 });
        expect(episode.summary).toContain("Rohit");
        expect(episode.summary).not.toContain("+919000000001");
        expect(episode.claims[0].text).toContain("Rohit");
        expect(episode.unresolvedParticipants).not.toContain(A);
      });
    });
  });
}

