// Brain run console: owner self-identity precedence in evidence labeling,
// owner API normalization/validation, identity suggestions, and the per-run
// token budget's named stop. Repo-level scenarios run on BOTH repositories.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import { buildEvidencePacks, buildPackLabeler, renderEvidenceLines } from "../src/server/brain/episodes";
import { enableBrainProvider } from "../src/server/brain/provider";
import { startBrainRun, getBrainRunProgress } from "../src/server/brain/runJob";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MemoryEvidenceMessage, MessageRecord } from "../src/shared/types";

const SECOND_NUMBER = "919999888877";
const SECOND_JID = `${SECOND_NUMBER}@s.whatsapp.net`;

function evidenceMessage(over: Partial<MemoryEvidenceMessage>): MemoryEvidenceMessage {
  return {
    messageId: 1,
    sourceMessageKey: "k1",
    chatSourceId: "chat@g.us",
    chatDisplayName: "Chat",
    senderSourceJid: "1555@s.whatsapp.net",
    senderDisplayName: "Riya",
    senderNameIsPushName: false,
    timestampMs: Date.now(),
    direction: "incoming",
    messageType: "text",
    text: "hello",
    ...over
  } as MemoryEvidenceMessage;
}

describe("owner self-identity precedence (labeler)", () => {
  it("labels a self number as the owner even when saved under another name, and exempts it from stamps", () => {
    const messages = [
      evidenceMessage({
        messageId: 1,
        sourceMessageKey: "k1",
        senderSourceJid: SECOND_JID,
        // The archive thinks this number is someone called "Backup Phone".
        senderDisplayName: "Backup Phone",
        text: "message from my other number"
      }),
      evidenceMessage({ messageId: 2, sourceMessageKey: "k2", senderSourceJid: "1555@s.whatsapp.net", senderDisplayName: "Riya" })
    ];
    const withoutSelf = buildPackLabeler(messages, "Abhishek");
    expect(withoutSelf.sender(messages[0]!)).toBe("Backup Phone");
    const labeler = buildPackLabeler(messages, "Abhishek", new Set([SECOND_JID]));
    expect(labeler.sender(messages[0]!)).toBe("Abhishek (me)");
    expect(labeler.sender(messages[1]!)).toBe("Riya");
    expect(labeler.identity(SECOND_JID)).toBe("Abhishek (me)");
    // Self numbers are never "unresolved" or push-name debt.
    expect(labeler.numberTokenJids).not.toContain(SECOND_JID);
    expect(labeler.pushNameJids).not.toContain(SECOND_JID);
    // Entity anchoring: the owner's name variants anchor to the self JID.
    expect(labeler.jidByLabelVariant.get("abhishek (me)")).toBe(SECOND_JID);
  });

  it("gives quoted senders and reactors the same precedence", () => {
    const reply = evidenceMessage({
      messageId: 3,
      sourceMessageKey: "k3",
      senderSourceJid: "1555@s.whatsapp.net",
      senderDisplayName: "Riya",
      quotedSnapshot: {
        quotedSourceMessageId: "orig",
        quotedSourceChatId: null,
        quotedSenderSourceJid: SECOND_JID,
        quotedSenderDisplayName: "Backup Phone",
        quotedSenderNameIsPushName: false,
        quotedFromMe: false,
        timestampMs: null,
        messageType: "text",
        body: "original",
        caption: null,
        mentionedJids: []
      } as never
    });
    const labeler = buildPackLabeler([reply], "Abhishek", new Set([SECOND_JID]));
    expect(labeler.quotedSender(reply)).toBe("Abhishek (me)");
    expect(
      labeler.reactor({ reactorJid: SECOND_JID, reactorDisplayName: "Backup Phone", reactorNameIsPushName: false, emoji: "👍" } as never)
    ).toBe("Abhishek");
  });
});

type RepoKind = "sqlite" | "memory";

async function withRepos(test: (repository: ArchiveRepository, kind: RepoKind) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-console-"));
  const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await test(sqlite, "sqlite");
  } finally {
    await sqlite.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
  await test(new MemoryArchiveRepository(), "memory");
}

function message(id: string, chat: string, over: Partial<MessageRecord> & { timestampMs: number }): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(chat, id),
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId: chat,
    senderSourceJid: null,
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `body ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...over
  };
}

describe("owner self-identity API", () => {
  it("normalizes, dedupes, validates, and reports the number's current name", async () => {
    await withRepos(async (repository, kind) => {
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: SECOND_JID, displayName: "Backup Phone", phoneNumber: `+${SECOND_NUMBER}` }]);
      await repository.upsertChats(runId, [{ sourceChatId: "c@g.us", jid: "c@g.us", displayName: "C", chatType: "group" }]);
      await repository.upsertMessages([message("M1", "c@g.us", { timestampMs: Date.now(), senderSourceJid: SECOND_JID })]);

      // Digits, formatted, and JID inputs all normalize to one canonical entry.
      const saved = await repository.setArchiveOwnerSelfJids([`+${SECOND_NUMBER}`, SECOND_NUMBER, SECOND_JID]);
      expect(saved.length, kind).toBe(1);
      expect(saved[0]!.jid, kind).toBe(SECOND_JID);
      expect(saved[0]!.currentLabel, `${kind}: shows the OTHER name to prevent mis-picks`).toBe("Backup Phone");
      expect(saved[0]!.messageCount, kind).toBe(1);
      expect((await repository.getArchiveOwnerSelfIdentities()).map((identity) => identity.jid), kind).toEqual([SECOND_JID]);

      // Invalid input is rejected with a naming error; the list is unchanged.
      await expect(repository.setArchiveOwnerSelfJids(["not-a-number"]), kind).rejects.toThrow(/not a valid number/);
      expect((await repository.getArchiveOwnerSelfIdentities()).length, kind).toBe(1);

      // Suggestions: substring over digits and names, with the current label.
      const byDigits = await repository.listOwnerIdentitySuggestions("99888");
      expect(byDigits.some((suggestion) => suggestion.jid === SECOND_JID), kind).toBe(true);
      const byName = await repository.listOwnerIdentitySuggestions("backup");
      expect(byName[0]?.label, kind).toBe("Backup Phone");
      expect(byName[0]?.isSelf, kind).toBe(true);
      expect(await repository.listOwnerIdentitySuggestions("x"), `${kind}: sub-2-char queries return nothing`).toEqual([]);

      // Clearing works.
      await repository.setArchiveOwnerSelfJids([]);
      expect((await repository.getArchiveOwnerSelfIdentities()).length, kind).toBe(0);
    });
  });

  it("renders a self sender as the owner end-to-end through pack building", async () => {
    await withRepos(async (repository, kind) => {
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [{ sourceJid: SECOND_JID, displayName: "Backup Phone", phoneNumber: `+${SECOND_NUMBER}` }]);
      await repository.upsertChats(runId, [{ sourceChatId: "c@g.us", jid: "c@g.us", displayName: "C", chatType: "group" }]);
      const base = Date.now() - 3_600_000;
      await repository.upsertMessages([
        message("M1", "c@g.us", { timestampMs: base, senderSourceJid: SECOND_JID, body: "from my second number" }),
        message("M2", "c@g.us", { timestampMs: base + 60_000, senderSourceJid: "1555@s.whatsapp.net", body: "hi" })
      ]);
      await repository.setArchiveOwnerName("Abhishek");
      await repository.setArchiveOwnerSelfJids([SECOND_NUMBER]);
      const packs = await buildEvidencePacks(repository, { chatSourceId: "c@g.us", startAtMs: 0, endAtMs: Date.now() });
      expect(packs.length, kind).toBe(1);
      expect(packs[0]!.participants, `${kind}: participant list uses the owner label`).toContain("Abhishek (me)");
      expect(packs[0]!.participants.join(" "), kind).not.toContain("Backup Phone");
      const lines = renderEvidenceLines(packs[0]!, "Abhishek", new Set([SECOND_JID])).join("\n");
      expect(lines, kind).toContain("Abhishek (me)");
      expect(lines, kind).not.toContain("Backup Phone");
    });
  });
});

describe("token budget (named stop)", () => {
  it("stops before the next call once accumulated tokens reach the budget and names tokens in the run record", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-token-budget-"));
    const stub = path.join(tempDir, "stub.cjs");
    await writeFile(
      stub,
      `let data=""; process.stdin.on("data",(c)=>{data+=c;}); process.stdin.on("end",()=>{
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ summary: "Stub episode.", topics: ["t"],
            claims: [{ kind: "fact", text: "Stub fact.", cites: [1], confidence: "stated" }] }),
          usage: { input_tokens: 600, output_tokens: 100 } }));
      });`,
      "utf8"
    );
    const previous = { ...config.brain };
    Object.assign(config.brain, {
      rootDir: tempDir,
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${stub}`
    });
    const repository = new MemoryArchiveRepository();
    try {
      enableBrainProvider("claude-cli");
      await repository.setArchiveOwnerName("Abhishek");
      const runId = await repository.startImportRun({ test: true });
      const base = Date.now() - 6 * 3_600_000;
      // Two chats → two packs → two would-be calls; the budget allows one.
      for (const chat of ["a@g.us", "b@g.us"]) {
        await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: chat, chatType: "group" }]);
        await repository.upsertMessages([
          message("M1", chat, { timestampMs: base, senderSourceJid: "1555@s.whatsapp.net", body: `plan for ${chat}` })
        ]);
      }
      const started = startBrainRun(repository, { mode: "model", model: "stub-model", maxChats: 10, maxTokens: 500 });
      expect(started.started).toBe(true);
      while (getBrainRunProgress().state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const final = getBrainRunProgress();
      expect(final.state).toBe("budget_exceeded");
      expect(final.modelCalls).toBe(1);
      expect(final.tokensUsed).toBe(700);
      expect(final.episodesCommitted).toBe(1);
      const run = await repository.getBrainRun(final.runId!);
      expect(run?.status).toBe("budget_exceeded");
      expect(run?.errorMessage ?? "").toContain("Token budget");
      expect(run?.errorMessage ?? "").toContain("500");
    } finally {
      Object.assign(config.brain, previous);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
