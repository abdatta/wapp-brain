import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { buildEvidencePacks, generateEpisodeForPack } from "../src/server/brain/episodes";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";

const MIN_MS = 60_000;

// The provider is mocked at the module boundary; pack building, validation,
// commit, and the fallback path below it are all real.
vi.mock("../src/server/brain/provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/brain/provider")>();
  return {
    ...original,
    getBrainProviderStatus: vi.fn(() => ({
      provider: "codex",
      modelBacked: true,
      enabled: true,
      sessionMissing: false,
      degraded: false,
      model: "test-model",
      reasoningEffort: "medium",
      models: { "claude-cli": [], codex: ["test-model"] },
      tokenUsage: "exact",
      health: { consecutiveFailures: 0, degradedSince: null, lastError: null, lastOkAt: null },
      message: "mocked"
    })),
    generateStructured: vi.fn()
  };
});

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => {
    Object.assign(config.brain, previous);
  };
}

async function seed(repository: ArchiveRepository): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [{ sourceJid: "1555@s.whatsapp.net", displayName: "Riya", phoneNumber: "+1555" }]);
  await repository.upsertChats(runId, [{ sourceChatId: "rej@g.us", jid: "rej@g.us", displayName: "Trip Plan", chatType: "group" }]);
  const base = Date.now() - 12 * 3_600_000;
  const messages: MessageRecord[] = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      sourceMessageId: `R${index}`,
      sourceMessageKey: "",
      sourceTable: "test",
      sourceRowId: `R${index}`,
      chatSourceId: "rej@g.us",
      senderSourceJid: "1555@s.whatsapp.net",
      timestampMs: base + index * MIN_MS,
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

describe("provider failure classification", () => {
  it("treats payload-level rejections as deterministic", async () => {
    const { classifyProviderFailure, isDeterministicRejection } = await import("../src/server/brain/provider");
    for (const status of [400, 413, 422]) {
      const classified = classifyProviderFailure(status, new Error(`API Error ${status}: nope`), "nope");
      expect(isDeterministicRejection(classified)).toBe(true);
      expect((classified as { httpStatus: number }).httpStatus).toBe(status);
    }
  });

  it("leaves auth, rate-limit, server, and unknown failures transient", async () => {
    const { classifyProviderFailure, isDeterministicRejection } = await import("../src/server/brain/provider");
    // 401/403 = the provider is refusing US, not this payload. 429 = the same
    // payload succeeds later. 5xx = an outage. All must still reach the
    // degradation guard, which is what stops a run when the provider is gone.
    for (const status of [401, 403, 429, 500, 503, null]) {
      const original = new Error(`API Error ${status ?? "???"}: nope`);
      const classified = classifyProviderFailure(status, original, "nope");
      expect(isDeterministicRejection(classified)).toBe(false);
      expect(classified).toBe(original);
    }
  });
});

describe("deterministic rejection handling in episode generation", () => {
  let restore: () => void;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-rej-"));
    restore = configureBrain({ rootDir: tempDir, provider: "codex" });
    return async () => {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    };
  });

  it("does not retry a deterministic rejection on byte-identical input", async () => {
    const provider = await import("../src/server/brain/provider");
    const repository = new MemoryArchiveRepository();
    await seed(repository);
    const generate = vi.mocked(provider.generateStructured);
    generate.mockReset();
    generate.mockRejectedValue(new provider.BrainProviderRejection(400, "rejected: bad request"));

    const [pack] = await buildEvidencePacks(repository, { chatSourceId: "rej@g.us", startAtMs: 0, endAtMs: Date.now() });
    const result = await generateEpisodeForPack(repository, pack, { generator: "model", advanceWatermark: false });

    // The regression this guards: two attempts per poisoned pack is what turned
    // five bad packs into ten consecutive failures and tripped the guard.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.providerRejection).toContain("rejected");
    expect(result.fellBackToExtractive).toBe(true);
    expect(result.episode.generator).toBe("extractive");
  });

  it("still retries once for an ordinary generation failure", async () => {
    const provider = await import("../src/server/brain/provider");
    const repository = new MemoryArchiveRepository();
    await seed(repository);
    const generate = vi.mocked(provider.generateStructured);
    generate.mockReset();
    generate.mockRejectedValue(new Error("model returned nonsense"));

    const [pack] = await buildEvidencePacks(repository, { chatSourceId: "rej@g.us", startAtMs: 0, endAtMs: Date.now() });
    const result = await generateEpisodeForPack(repository, pack, { generator: "model", advanceWatermark: false });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.providerRejection).toBeNull();
    expect(result.fellBackToExtractive).toBe(true);
  });

  it("reports no rejection when generation succeeds", async () => {
    const provider = await import("../src/server/brain/provider");
    const repository = new MemoryArchiveRepository();
    await seed(repository);
    const generate = vi.mocked(provider.generateStructured);
    generate.mockReset();
    const [pack] = await buildEvidencePacks(repository, { chatSourceId: "rej@g.us", startAtMs: 0, endAtMs: Date.now() });
    generate.mockResolvedValue({
      json: {
        summary: "The group settled the Lisbon trip details for May.",
        topics: ["lisbon trip"],
        claims: [
          {
            kind: "decision",
            text: "The group agreed on the Lisbon trip details for May.",
            cites: ["m1"],
            entities: [{ kind: "place", name: "Lisbon" }],
            confidence: "stated"
          }
        ]
      },
      usage: { inputTokens: 10, outputTokens: 10 }
    });

    const result = await generateEpisodeForPack(repository, pack, { generator: "model", advanceWatermark: false });
    expect(result.providerRejection).toBeNull();
    expect(result.fellBackToExtractive).toBe(false);
    expect(result.episode.generator).toBe("model");
  });
});
