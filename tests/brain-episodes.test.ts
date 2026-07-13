import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { buildEvidencePacks, generateEpisodeForPack } from "../src/server/brain/episodes";
import { enableBrainProvider } from "../src/server/brain/provider";
import { startBrainRun, getBrainRunProgress } from "../src/server/brain/runJob";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";

const MIN_MS = 60_000;

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => {
    Object.assign(config.brain, previous);
  };
}

async function seed(repository: ArchiveRepository, count = 6, gapAt?: number): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [{ sourceJid: "1555@s.whatsapp.net", displayName: "Riya", phoneNumber: "+1555" }]);
  await repository.upsertChats(runId, [{ sourceChatId: "ep@g.us", jid: "ep@g.us", displayName: "Trip Plan", chatType: "group" }]);
  const base = Date.now() - 12 * 3_600_000;
  const messages: MessageRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const gap = gapAt != null && index >= gapAt ? 3 * 3_600_000 : 0;
    messages.push({
      sourceMessageId: `E${index}`,
      sourceMessageKey: "",
      sourceTable: "test",
      sourceRowId: `E${index}`,
      chatSourceId: "ep@g.us",
      senderSourceJid: "1555@s.whatsapp.net",
      timestampMs: base + index * MIN_MS + gap,
      fromMe: false,
      direction: "incoming",
      messageType: "text",
      body: `We agreed on detail number ${index} for the Lisbon trip in May`,
      hasMedia: false,
      isDeleted: false,
      isForwarded: false,
      isStarred: false
    });
  }
  await repository.upsertMessages(messages);
}

describe("brain episodes", () => {
  it("builds packs, commits an extractive episode with citations, and advances the watermark", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-ep-"));
    const restore = configureBrain({ rootDir: tempDir, provider: "extractive" });
    const repository = new MemoryArchiveRepository();
    try {
      await seed(repository);
      const packs = await buildEvidencePacks(repository, { chatSourceId: "ep@g.us", startAtMs: 0, endAtMs: Date.now() });
      expect(packs).toHaveLength(1);
      expect(packs[0].messages).toHaveLength(6);

      const result = await generateEpisodeForPack(repository, packs[0], { generator: "extractive" });
      expect(result.episode.generator).toBe("extractive");
      expect(result.episode.claims.length).toBeGreaterThan(0);
      expect(result.episode.claims[0].citations[0].sourceMessageKey).toContain("ep@g.us");
      expect(result.episode.markdown).toContain("## Claims");

      // Coverage advanced: no backlog remains for the chat.
      expect(await repository.getBrainChatBacklog({ limit: 5 })).toHaveLength(0);
      // Obsidian projection landed.
      const files = await readdir(path.join(tempDir, "episodes"));
      expect(files.some((file) => file.endsWith(".md"))).toBe(true);
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the model when valid, falls back on hallucinated citations, and drains via the run job", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-ep-model-"));
    const goodStub = path.join(tempDir, "good.cjs");
    const badStub = path.join(tempDir, "bad.cjs");
    await writeFile(
      goodStub,
      `process.stdin.resume(); process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ summary: "Trip planning converged on Lisbon in May.",
            claims: [{ kind: "decision", text: "The group chose Lisbon for May.", cites: ["m1", "m2"] }] }),
          usage: { input_tokens: 100, output_tokens: 30 } }));
      });`,
      "utf8"
    );
    await writeFile(
      badStub,
      `process.stdin.resume(); process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ summary: "s", claims: [{ kind: "fact", text: "t", cites: ["m999"] }] }),
          usage: { input_tokens: 1, output_tokens: 1 } }));
      });`,
      "utf8"
    );
    const restore = configureBrain({
      rootDir: tempDir,
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${goodStub}`
    });
    const repository = new MemoryArchiveRepository();
    try {
      enableBrainProvider("claude-cli");
      await seed(repository);
      const packs = await buildEvidencePacks(repository, { chatSourceId: "ep@g.us", startAtMs: 0, endAtMs: Date.now() });
      const good = await generateEpisodeForPack(repository, packs[0], { generator: "model", model: "haiku" });
      expect(good.episode.generator).toBe("model");
      expect(good.episode.model).toBe("haiku");
      expect(good.episode.claims[0].kind).toBe("decision");
      // Aliases resolved to real message keys.
      expect(good.episode.claims[0].citations.map((citation) => citation.sourceMessageKey)).toHaveLength(2);
      expect(good.usage?.inputTokens).toBe(100);

      // Hallucinated citations → retry → extractive fallback, never a block.
      const repository2 = new MemoryArchiveRepository();
      await seed(repository2);
      Object.assign(config.brain, { claudeCommand: `node ${badStub}` });
      const packs2 = await buildEvidencePacks(repository2, { chatSourceId: "ep@g.us", startAtMs: 0, endAtMs: Date.now() });
      const fallback = await generateEpisodeForPack(repository2, packs2[0], { generator: "model", model: "haiku" });
      expect(fallback.fellBackToExtractive).toBe(true);
      expect(fallback.episode.generator).toBe("extractive");

      // Run job: drains backlog end-to-end with progress and ledger entries.
      const repository3 = new MemoryArchiveRepository();
      await seed(repository3);
      Object.assign(config.brain, { claudeCommand: `node ${goodStub}` });
      const started = startBrainRun(repository3, { mode: "model", model: "haiku", maxChats: 5 });
      expect(started.started).toBe(true);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (getBrainRunProgress().state !== "running") {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      const finished = getBrainRunProgress();
      expect(finished.state).toBe("completed");
      expect(finished.episodesCommitted).toBeGreaterThan(0);
      expect((await repository3.getBrainLlmUsage({ sinceMs: Date.now() - 60_000 })).calls).toBeGreaterThan(0);
      expect((await repository3.getBrainStatus()).coveragePercent).toBe(100);
      expect((await repository3.listBrainEpisodes({ limit: 10 }))[0].summary).toContain("Lisbon");
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("labels the owner's messages by name instead of the 'Me' sentinel", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-owner-"));
    const restore = configureBrain({ rootDir: tempDir, provider: "extractive" });
    const { SqliteArchiveRepository } = await import("../src/server/db/sqliteRepository");
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await repository.setArchiveOwnerName("Abhishek");
      expect(await repository.getArchiveOwnerName()).toBe("Abhishek");
      const runId = await repository.startImportRun({ test: true });
      // The importer's own-number sentinel materializes a contact named "Me".
      await repository.upsertContacts(runId, [{ sourceJid: "me", displayName: "Me" }]);
      await repository.upsertChats(runId, [{ sourceChatId: "own@g.us", jid: "own@g.us", displayName: "Own", chatType: "group" }]);
      await repository.upsertMessages([
        {
          sourceMessageId: "O1",
          sourceMessageKey: "",
          sourceTable: "test",
          sourceRowId: "O1",
          chatSourceId: "own@g.us",
          senderSourceJid: "me",
          timestampMs: Date.now() - 3_600_000,
          fromMe: true,
          direction: "outgoing",
          messageType: "text",
          body: "I will bring the projector cable tomorrow",
          hasMedia: false,
          isDeleted: false,
          isForwarded: false,
          isStarred: false
        }
      ]);
      const packs = await buildEvidencePacks(repository, { chatSourceId: "own@g.us", startAtMs: 0, endAtMs: Date.now() });
      expect(packs[0].participants).toContain("Abhishek (me)");
      expect(packs[0].participants).not.toContain("Me");
      const episode = await generateEpisodeForPack(repository, packs[0], { generator: "extractive" });
      expect(episode.episode.claims[0].text).toContain("Abhishek wrote:");
      // Search indexes the owner's messages under their name, not "Me".
      const byName = await repository.searchMessages({ query: "abhishek projector", limit: 5, offset: 0 });
      expect(byName.results.map((hit) => hit.sourceMessageId)).toContain("O1");
    } finally {
      await repository.close?.();
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("splits packs at silence gaps beyond the minimum segment size", async () => {
    const repository = new MemoryArchiveRepository();
    await seed(repository, 30, 15);
    const packs = await buildEvidencePacks(repository, { chatSourceId: "ep@g.us", startAtMs: 0, endAtMs: Date.now(), maxMessages: 20 });
    expect(packs.length).toBe(2);
    expect(packs[0].messages.length + packs[1].messages.length).toBe(30);
  });

  it("surfaces reactions, quoted replies, forwards, and number labels in the model prompt", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-fidelity-"));
    const capturePath = path.join(tempDir, "prompt.txt");
    const stub = path.join(tempDir, "capture.cjs");
    await writeFile(
      stub,
      `let data=""; process.stdin.on("data",(c)=>{data+=c;}); process.stdin.on("end",()=>{
        require("fs").writeFileSync(${JSON.stringify(capturePath)}, data);
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
          result: JSON.stringify({ summary: "The group moved to book Lisbon flights.",
            claims: [{ kind: "commitment", text: "Riya's booking question was acknowledged.", cites: ["m1"] }] }),
          usage: { input_tokens: 10, output_tokens: 5 } }));
      });`,
      "utf8"
    );
    const restore = configureBrain({
      rootDir: tempDir,
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${stub}`
    });
    const repository = new MemoryArchiveRepository();
    try {
      enableBrainProvider("claude-cli");
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertContacts(runId, [
        { sourceJid: "1555@s.whatsapp.net", displayName: "Riya", phoneNumber: "+1555" },
        { sourceJid: "1777@s.whatsapp.net", displayName: "Rohit", phoneNumber: "+1777" }
      ]);
      await repository.upsertChats(runId, [{ sourceChatId: "rich@g.us", jid: "rich@g.us", displayName: "Rich", chatType: "group" }]);
      const base = Date.now() - 6 * 3_600_000;
      const message = (over: Partial<MessageRecord> & { sourceMessageId: string; senderSourceJid: string; timestampMs: number; body: string }): MessageRecord => ({
        sourceMessageKey: "",
        sourceTable: "test",
        sourceRowId: over.sourceMessageId,
        chatSourceId: "rich@g.us",
        fromMe: false,
        direction: "incoming",
        messageType: "text",
        hasMedia: false,
        isDeleted: false,
        isForwarded: false,
        isStarred: false,
        ...over
      });
      await repository.upsertMessages([
        message({ sourceMessageId: "OLD1", senderSourceJid: "1555@s.whatsapp.net", timestampMs: base, body: "the original plan is Lisbon" }),
        message({ sourceMessageId: "R1", senderSourceJid: "1555@s.whatsapp.net", timestampMs: base + 2 * 60_000, body: "Shall we book the Lisbon flights?" }),
        message({ sourceMessageId: "R2", senderSourceJid: "99123@lid", timestampMs: base + 3 * 60_000, body: "yes lets do it" }),
        message({ sourceMessageId: "R3", senderSourceJid: "1777@s.whatsapp.net", timestampMs: base + 4 * 60_000, body: "great flight deals here", isForwarded: true }),
        message({ sourceMessageId: "R4", senderSourceJid: "1777@s.whatsapp.net", timestampMs: base + 5 * 60_000, body: "booking now", quotedSourceMessageId: "R1" }),
        message({ sourceMessageId: "R5", senderSourceJid: "1555@s.whatsapp.net", timestampMs: base + 6 * 60_000, body: "back to the original plan", quotedSourceMessageId: "OLD1" }),
        message({ sourceMessageId: "R6", senderSourceJid: "1555@s.whatsapp.net", timestampMs: base + 7 * 60_000, body: "and that other thing", quotedSourceMessageId: "GHOST" })
      ]);
      // A reaction on R1 (Riya's booking question) — the acknowledgment signal.
      await repository.applyLiveMessageUpdates([
        {
          eventKey: "react-1",
          chatSourceId: "rich@g.us",
          sourceMessageKey: messageKey("rich@g.us", "R1"),
          updateType: "reaction",
          occurredAtMs: base + 2 * 60_000 + 10_000,
          metadata: { emoji: "👍", reactorJid: "1777@s.whatsapp.net" }
        }
      ]);

      // Window starts after OLD1 so it is out of the pack but still archived.
      const packs = await buildEvidencePacks(repository, { chatSourceId: "rich@g.us", startAtMs: base + 60_000, endAtMs: Date.now() });
      expect(packs).toHaveLength(1);
      expect(packs[0].messages.map((m) => m.sourceMessageId)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
      // The reaction was attached to its target, not turned into a pack message.
      expect(packs[0].messages[0].reactions).toEqual([
        { emoji: "👍", reactorJid: "1777@s.whatsapp.net", reactorDisplayName: "Rohit", reactorNameIsPushName: false }
      ]);

      const result = await generateEpisodeForPack(repository, packs[0], { generator: "model", model: "haiku" });
      // The claim cited m1 (the reacted message) and validated — reactions are
      // cited THROUGH their target, never as their own alias.
      expect(result.episode.generator).toBe("model");

      const prompt = await import("node:fs/promises").then((fs) => fs.readFile(capturePath, "utf8"));
      // Reaction annotation on its target line, reactor resolved.
      expect(prompt).toContain("[👍 Rohit]");
      // Forwarded label.
      expect(prompt).toContain("(forwarded)");
      // Unresolved LID sender rendered by number token, never "Unknown".
      expect(prompt).toContain("lid:99123");
      expect(prompt).not.toContain("Unknown");
      // In-pack quoted reply resolves to the referent alias (R1 == m1).
      expect(prompt).toContain("↳ replying to m1 (Riya):");
      // Out-of-pack but archived reply → non-citable snippet (no alias).
      expect(prompt).toContain('↳ replying to (Riya): "the original plan is Lisbon"');
      // Out-of-pack and unarchived reply → honest, non-citable fallback.
      expect(prompt).toContain("↳ replying to an earlier message");
      // Prompt rules present.
      expect(prompt.toLowerCase()).toContain("forwarded");
      expect(prompt).toContain("verbatim");
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("number-labels unresolved senders and disambiguates same-name participants", async () => {
    const repository = new MemoryArchiveRepository();
    const runId = await repository.startImportRun({ test: true });
    // Two different people both named "Rohit" (collision), plus an unresolved LID.
    await repository.upsertContacts(runId, [
      { sourceJid: "919811100001@s.whatsapp.net", displayName: "Rohit", phoneNumber: "+919811100001" },
      { sourceJid: "919822200002@s.whatsapp.net", displayName: "Rohit", phoneNumber: "+919822200002" }
    ]);
    await repository.upsertChats(runId, [{ sourceChatId: "dis@g.us", jid: "dis@g.us", displayName: "Dis", chatType: "group" }]);
    const base = Date.now() - 3_600_000;
    await repository.upsertMessages([
      { sourceMessageId: "D1", sourceMessageKey: "", sourceTable: "test", sourceRowId: "D1", chatSourceId: "dis@g.us", senderSourceJid: "919811100001@s.whatsapp.net", timestampMs: base, fromMe: false, direction: "incoming", messageType: "text", body: "I'll handle the venue", hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false },
      { sourceMessageId: "D2", sourceMessageKey: "", sourceTable: "test", sourceRowId: "D2", chatSourceId: "dis@g.us", senderSourceJid: "919822200002@s.whatsapp.net", timestampMs: base + 60_000, fromMe: false, direction: "incoming", messageType: "text", body: "I'll bring snacks", hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false },
      { sourceMessageId: "D3", sourceMessageKey: "", sourceTable: "test", sourceRowId: "D3", chatSourceId: "dis@g.us", senderSourceJid: "55999@lid", timestampMs: base + 120_000, fromMe: false, direction: "incoming", messageType: "text", body: "count me in", hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false }
    ]);
    const packs = await buildEvidencePacks(repository, { chatSourceId: "dis@g.us", startAtMs: 0, endAtMs: Date.now() });
    expect(packs).toHaveLength(1);
    const participants = packs[0].participants;
    // Same-name collision: both are "Rohit (…tail)" and distinct.
    const rohits = participants.filter((p) => p.startsWith("Rohit (")).sort();
    expect(rohits).toHaveLength(2);
    expect(rohits[0]).not.toEqual(rohits[1]);
    // Unresolved LID rendered as a number token, never "Unknown".
    expect(participants).toContain("lid:55999");
    expect(participants).not.toContain("Unknown");
  });

  it("bounds a quiet chat's episode span independent of silence gaps", async () => {
    const DAY = 24 * 3_600_000;
    const repository = new MemoryArchiveRepository();
    const runId = await repository.startImportRun({ test: true });
    await repository.upsertContacts(runId, [{ sourceJid: "1555@s.whatsapp.net", displayName: "Riya", phoneNumber: "+1555" }]);
    await repository.upsertChats(runId, [{ sourceChatId: "quiet@g.us", jid: "quiet@g.us", displayName: "Quiet", chatType: "group" }]);
    const base = Date.now() - 40 * DAY;
    // Seven sparse messages one day apart (a 6-day span) — fewer than the
    // silence-split minimum, so ONLY the span cap can break this up.
    const messages: MessageRecord[] = [];
    for (let index = 0; index < 7; index += 1) {
      messages.push({
        sourceMessageId: `Q${index}`,
        sourceMessageKey: "",
        sourceTable: "test",
        sourceRowId: `Q${index}`,
        chatSourceId: "quiet@g.us",
        senderSourceJid: "1555@s.whatsapp.net",
        timestampMs: base + index * DAY,
        fromMe: false,
        direction: "incoming",
        messageType: "text",
        body: `quiet update number ${index}`,
        hasMedia: false,
        isDeleted: false,
        isForwarded: false,
        isStarred: false
      });
    }
    await repository.upsertMessages(messages);

    // Without a span cap (large) the sparse backlog is a single episode.
    const restoreWide = configureBrain({ maxEpisodeSpanMs: 3650 * DAY });
    const wide = await buildEvidencePacks(repository, { chatSourceId: "quiet@g.us", startAtMs: 0, endAtMs: Date.now() });
    restoreWide();
    expect(wide).toHaveLength(1);

    // With a 3-day cap the same backlog is split into week-bounded packs.
    const restoreCap = configureBrain({ maxEpisodeSpanMs: 3 * DAY });
    const capped = await buildEvidencePacks(repository, { chatSourceId: "quiet@g.us", startAtMs: 0, endAtMs: Date.now() });
    restoreCap();
    expect(capped.length).toBeGreaterThan(1);
    for (const pack of capped) {
      expect(pack.endAtMs - pack.startAtMs).toBeLessThan(3 * DAY);
    }
    expect(capped.reduce((sum, pack) => sum + pack.messages.length, 0)).toBe(7);
  });
});
