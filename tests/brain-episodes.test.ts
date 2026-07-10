import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { buildEvidencePacks, generateEpisodeForPack } from "../src/server/brain/episodes";
import { enableBrainProvider } from "../src/server/brain/provider";
import { startBrainRun, getBrainRunProgress } from "../src/server/brain/runJob";
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

  it("splits packs at silence gaps beyond the minimum segment size", async () => {
    const repository = new MemoryArchiveRepository();
    await seed(repository, 30, 15);
    const packs = await buildEvidencePacks(repository, { chatSourceId: "ep@g.us", startAtMs: 0, endAtMs: Date.now(), maxMessages: 20 });
    expect(packs.length).toBe(2);
    expect(packs[0].messages.length + packs[1].messages.length).toBe(30);
  });
});
