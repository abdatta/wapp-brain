// Zero-claim episodes: the no-durable-claims declaration. A window that holds
// nothing durable commits as a terminal claimless MODEL episode when (and only
// when) the model returns a literal empty claims array together with a stated
// reason. Empty without a reason, and every malformed claims payload — with or
// without a reason string — stays a retryable error, so a malformed response is
// never mistaken for a considered judgment.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { buildEvidencePacks, EXTRACTION_VERSION, generateEpisodeForPack } from "../src/server/brain/episodes";
import { enableBrainProvider } from "../src/server/brain/provider";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => {
    Object.assign(config.brain, previous);
  };
}

function makeMessage(
  over: Partial<MessageRecord> & { sourceMessageId: string; chatSourceId: string; senderSourceJid: string; timestampMs: number }
): MessageRecord {
  return {
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: over.sourceMessageId,
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: over.body ?? null,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...over
  };
}

// Two clusters four hours apart, so two disjoint window queries each yield one
// pack: an "empty" window (a lone reaction-ish message) and a substantive one.
async function seedTwoWindows(repository: ArchiveRepository, chat = "zc@g.us"): Promise<{ baseMs: number }> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [{ sourceJid: "1555@s.whatsapp.net", displayName: "Riya", phoneNumber: "+1555" }]);
  await repository.upsertChats(runId, [{ sourceChatId: chat, jid: chat, displayName: "ZC", chatType: "group" }]);
  const baseMs = Date.now() - 12 * HOUR_MS;
  await repository.upsertMessages([
    makeMessage({ sourceMessageId: "Z1", chatSourceId: chat, senderSourceJid: "1555@s.whatsapp.net", timestampMs: baseMs, body: "😂" }),
    makeMessage({
      sourceMessageId: "Z2",
      chatSourceId: chat,
      senderSourceJid: "1555@s.whatsapp.net",
      timestampMs: baseMs + 4 * HOUR_MS,
      body: "The Lisbon flights should be booked by Friday"
    }),
    makeMessage({
      sourceMessageId: "Z3",
      chatSourceId: chat,
      senderSourceJid: "1555@s.whatsapp.net",
      timestampMs: baseMs + 4 * HOUR_MS + MIN_MS,
      body: "Booking them tomorrow morning"
    })
  ]);
  return { baseMs };
}

// A stub claude CLI replying with a fixed payload; captures the last prompt.
async function writeStub(dir: string, name: string, payload: unknown, capturePath?: string): Promise<string> {
  const stub = path.join(dir, name);
  await writeFile(
    stub,
    `let data=""; process.stdin.on("data",(c)=>{data+=c;}); process.stdin.on("end",()=>{
      ${capturePath ? `require("fs").writeFileSync(${JSON.stringify(capturePath)}, data);` : ""}
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
        result: JSON.stringify(${JSON.stringify(payload)}),
        usage: { input_tokens: 10, output_tokens: 5 } }));
    });`,
    "utf8"
  );
  return stub;
}

const DECLARED_EMPTY = {
  summary: "Riya sent a single laughing reaction; nothing else happened.",
  topics: ["chit-chat"],
  claims: [],
  no_durable_claims: "single laughing reaction, no content"
};

async function withStub(
  payload: unknown,
  test: (repository: MemoryArchiveRepository, tempDir: string, capturePath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-zero-claim-"));
  const capturePath = path.join(tempDir, "prompt.txt");
  const stub = await writeStub(tempDir, "stub.cjs", payload, capturePath);
  const restore = configureBrain({
    rootDir: tempDir,
    providerConfigPath: path.join(tempDir, "provider.json"),
    provider: "claude-cli",
    claudeCommand: `node ${stub}`
  });
  const repository = new MemoryArchiveRepository();
  try {
    enableBrainProvider("claude-cli");
    await test(repository, tempDir, capturePath);
  } finally {
    restore();
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("zero-claim episodes: declared-empty acceptance", () => {
  it("commits a declared-empty window as a terminal claimless model episode (SQLite end to end)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-zero-claim-sql-"));
    const capturePath = path.join(tempDir, "prompt.txt");
    const stub = await writeStub(tempDir, "stub.cjs", DECLARED_EMPTY, capturePath);
    const restore = configureBrain({
      rootDir: tempDir,
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${stub}`
    });
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      enableBrainProvider("claude-cli");
      const { baseMs } = await seedTwoWindows(repository);
      const packs = await buildEvidencePacks(repository, { chatSourceId: "zc@g.us", startAtMs: 0, endAtMs: baseMs + HOUR_MS });
      expect(packs).toHaveLength(1);
      const result = await generateEpisodeForPack(repository, packs[0], { generator: "model", model: "haiku" });

      // A correct answer, not a failure: model episode, no fallback, no retry.
      expect(result.fellBackToExtractive).toBe(false);
      expect(result.episode.generator).toBe("model");
      expect(result.episode.claims).toHaveLength(0);
      expect(result.episode.noDurableClaimsReason).toBe("single laughing reaction, no content");
      expect(result.episode.fallbackReason).toBeNull();
      const prompt = await readFile(capturePath, "utf8");
      expect(prompt).not.toContain("rejected for ALL of these reasons");
      // The prompt licenses the empty answer and carries the contract field.
      expect(prompt).toContain('"no_durable_claims"');
      expect(prompt).toContain("NEVER invent a claim");

      // Round-trips through the SQLite row (column, insert, mapping).
      const stored = (await repository.listBrainEpisodes({ chatSourceId: "zc@g.us", limit: 5 }))[0];
      expect(stored.noDurableClaimsReason).toBe("single laughing reaction, no content");
      expect(stored.claims).toHaveLength(0);

      // The projection renders the assertion where the claims would be.
      expect(stored.markdown).toContain("No durable claims — single laughing reaction, no content");

      // Terminal: excluded from sweep selection and the extractive backlog.
      expect(await repository.countRegenerableBrainEpisodes(EXTRACTION_VERSION)).toBe(0);
      const sweepable = await repository.listRegenerableBrainEpisodes({ currentVersion: EXTRACTION_VERSION, limit: 10 });
      expect(sweepable).toHaveLength(0);
      const backlog = await repository.listRegenerableBrainEpisodes({ currentVersion: EXTRACTION_VERSION, onlyExtractive: true, limit: 10 });
      expect(backlog).toHaveLength(0);

      // No validation issues: nothing failed.
      const issues = await repository.listBrainValidationIssues({ episodeId: result.episode.id });
      expect(issues.filter((issue) => issue.code === "validation_failed")).toHaveLength(0);

      // Aggregates on the SQLite path — also exercises the INDEXED BY plans,
      // which throw loudly here if an index is ever renamed or dropped.
      const aggregates = await repository.getBrainModelQualityAggregates();
      const haiku = aggregates.find((aggregate) => aggregate.model === "haiku" && aggregate.extractionVersion === EXTRACTION_VERSION)!;
      expect(haiku.declaredEmptyEpisodes).toBe(1);
      expect(haiku.declaredEmptyRate).toBe(1);
    } finally {
      await repository.close?.();
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the claims and drops the declaration when both arrive, with a warning", async () => {
    await withStub(
      {
        summary: "Flights get booked.",
        claims: [{ kind: "decision", text: "The Lisbon flights will be booked by Friday.", cites: ["m2"] }],
        no_durable_claims: "nothing here"
      },
      async (repository) => {
        const { baseMs } = await seedTwoWindows(repository);
        const packs = await buildEvidencePacks(repository, { chatSourceId: "zc@g.us", startAtMs: baseMs + HOUR_MS, endAtMs: Date.now() });
        const result = await generateEpisodeForPack(repository, packs[0], { generator: "model", model: "haiku" });
        expect(result.fellBackToExtractive).toBe(false);
        expect(result.episode.claims).toHaveLength(1);
        expect(result.episode.noDurableClaimsReason).toBeNull();
        const issues = await repository.listBrainValidationIssues({ episodeId: result.episode.id });
        expect(issues.some((issue) => issue.code === "declaration_with_claims" && issue.severity === "warning")).toBe(true);
      }
    );
  });
});

describe("zero-claim episodes: malformed payloads never become declarations", () => {
  // Task 2.3: every malformation path stays a retryable error — even when a
  // reason string is present — and the teaching message names the escape hatch.
  const CASES: Array<{ name: string; payload: unknown; expectDetail: string }> = [
    {
      name: "missing claims field with a reason",
      payload: { summary: "s", no_durable_claims: "nothing here" },
      expectDetail: "literal empty array"
    },
    {
      name: "claims: null with a reason",
      payload: { summary: "s", claims: null, no_durable_claims: "nothing here" },
      expectDetail: "literal empty array"
    },
    {
      name: 'claims: "text" with a reason',
      payload: { summary: "s", claims: "no claims found", no_durable_claims: "nothing here" },
      expectDetail: "literal empty array"
    },
    {
      name: 'claims: ["text"] (entries filtered away) with a reason',
      payload: { summary: "s", claims: ["there are no claims"], no_durable_claims: "nothing here" },
      expectDetail: "literal empty array"
    },
    {
      name: "empty claims without a declaration",
      payload: { summary: "s", claims: [] },
      expectDetail: "no_durable_claims"
    },
    {
      name: "boolean true is not a declaration",
      payload: { summary: "s", claims: [], no_durable_claims: true },
      expectDetail: "no_durable_claims"
    },
    {
      name: "a blank reason is no reason",
      payload: { summary: "s", claims: [], no_durable_claims: "   " },
      expectDetail: "no_durable_claims"
    }
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} → retryable error → extractive fallback`, async () => {
      await withStub(testCase.payload, async (repository) => {
        const { baseMs } = await seedTwoWindows(repository);
        const packs = await buildEvidencePacks(repository, { chatSourceId: "zc@g.us", startAtMs: 0, endAtMs: baseMs + HOUR_MS });
        const result = await generateEpisodeForPack(repository, packs[0], { generator: "model", model: "haiku" });
        expect(result.fellBackToExtractive).toBe(true);
        expect(result.episode.generator).toBe("extractive");
        expect(result.episode.noDurableClaimsReason).toBeNull();
        expect(result.episode.fallbackReason).toContain(testCase.expectDetail);
      });
    });
  }
});

describe("zero-claim episodes: scoped regeneration selection", () => {
  // The migration decision: regenerate the thin-pack population first and let
  // the groundedness census decide about the rest. maxMessageCount is the
  // selection scope that makes that a one-button operation.
  it("maxMessageCount narrows the stale selection to packs of at most N messages", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-zero-claim-scope-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      for (const [id, messageCount] of [
        ["tiny", 3],
        ["boundary", 5],
        ["above", 6],
        ["large", 40]
      ] as const) {
        await repository.commitBrainEpisode({
          chatSourceId: `${id}@g.us`,
          startAtMs: 1_000,
          endAtMs: 2_000,
          messageCount,
          participants: [],
          summary: `${id} window`,
          markdown: "",
          generator: "model",
          model: "haiku",
          runId: null,
          extractionVersion: EXTRACTION_VERSION - 1,
          claims: []
        });
      }
      const scoped = await repository.listRegenerableBrainEpisodes({
        currentVersion: EXTRACTION_VERSION,
        maxMessageCount: 5,
        limit: 10
      });
      expect(scoped.map((episode) => episode.summary).sort()).toEqual(["boundary window", "tiny window"]);
      // Unscoped still selects everything stale.
      const all = await repository.listRegenerableBrainEpisodes({ currentVersion: EXTRACTION_VERSION, limit: 10 });
      expect(all).toHaveLength(4);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("zero-claim episodes: downstream", () => {
  it("a claimless episode stays continuity context and is measured in the per-model aggregates", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-zero-claim-dn-"));
    const capturePath = path.join(tempDir, "prompt.txt");
    const emptyStub = await writeStub(tempDir, "empty.cjs", DECLARED_EMPTY);
    const claimStub = await writeStub(
      tempDir,
      "claims.cjs",
      {
        summary: "Flights get booked.",
        claims: [{ kind: "decision", text: "The Lisbon flights will be booked by Friday.", cites: ["m1"] }]
      },
      capturePath
    );
    const restore = configureBrain({
      rootDir: tempDir,
      providerConfigPath: path.join(tempDir, "provider.json"),
      provider: "claude-cli",
      claudeCommand: `node ${emptyStub}`
    });
    const repository = new MemoryArchiveRepository();
    try {
      enableBrainProvider("claude-cli");
      const { baseMs } = await seedTwoWindows(repository);
      const emptyPacks = await buildEvidencePacks(repository, { chatSourceId: "zc@g.us", startAtMs: 0, endAtMs: baseMs + HOUR_MS });
      const declared = await generateEpisodeForPack(repository, emptyPacks[0], { generator: "model", model: "haiku" });
      expect(declared.episode.noDurableClaimsReason).not.toBeNull();

      // The next window's prompt carries the claimless episode's summary as
      // prior context — a claimless model episode is ordinary, not invisible.
      Object.assign(config.brain, { claudeCommand: `node ${claimStub}` });
      const laterPacks = await buildEvidencePacks(repository, { chatSourceId: "zc@g.us", startAtMs: baseMs + HOUR_MS, endAtMs: Date.now() });
      const later = await generateEpisodeForPack(repository, laterPacks[0], { generator: "model", model: "haiku" });
      expect(later.fellBackToExtractive).toBe(false);
      const prompt = await readFile(capturePath, "utf8");
      expect(prompt).toContain("BEGIN PRIOR EPISODE SUMMARY");
      expect(prompt).toContain("Riya sent a single laughing reaction");

      // Aggregates: the escape hatch is a visible number with its denominator.
      const aggregates = await repository.getBrainModelQualityAggregates();
      const haiku = aggregates.find((aggregate) => aggregate.model === "haiku" && aggregate.extractionVersion === EXTRACTION_VERSION)!;
      expect(haiku.modelEpisodes).toBe(2);
      expect(haiku.declaredEmptyEpisodes).toBe(1);
      expect(haiku.declaredEmptyRate).toBeCloseTo(0.5, 5);
      expect(haiku.claims).toBe(1);
      expect(haiku.fallbackEpisodes).toBe(0);
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
