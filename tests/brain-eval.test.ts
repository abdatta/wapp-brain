import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { generateEpisodeForPack, EXTRACTION_VERSION, type BrainEvidencePack } from "../src/server/brain/episodes";
import {
  computeEvalGate,
  loadGoldenSet,
  localServerListening,
  resolveEvalBaseline,
  runBrainEval,
  scaffoldGoldenSet
} from "../src/server/brain/eval";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { BrainEvalRunRecord, BrainGoldenSet, MemoryEvidenceMessage, MessageRecord } from "../src/shared/types";

const DAY_MS = 86_400_000;
const DM_CHAT = "15550001111@s.whatsapp.net";
const GROUP_CHAT = "flat@g.us";

function configureBrain(overrides: Partial<typeof config.brain>): () => void {
  const previous = { ...config.brain };
  Object.assign(config.brain, overrides);
  return () => {
    Object.assign(config.brain, previous);
  };
}

function message(id: string, chatSourceId: string, overrides: Partial<MessageRecord>): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: null,
    timestampMs: Date.now(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: null,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...overrides
  };
}

async function seedArchive(repository: ArchiveRepository): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [
    { sourceJid: "15550001111@s.whatsapp.net", displayName: "Riya Sharma", phoneNumber: "+15550001111" },
    { sourceJid: "15550002222@s.whatsapp.net", displayName: "Sam Iyer", phoneNumber: "+15550002222" }
  ]);
  await repository.upsertChats(runId, [
    { sourceChatId: DM_CHAT, jid: DM_CHAT, displayName: "Riya Sharma", chatType: "dm" },
    { sourceChatId: GROUP_CHAT, jid: GROUP_CHAT, displayName: "Flat Hunt", chatType: "group" }
  ]);
  await repository.upsertMessages([
    message("A1", DM_CHAT, {
      senderSourceJid: "15550001111@s.whatsapp.net",
      timestampMs: Date.now() - 30 * DAY_MS,
      body: "Found a great apartment near the park in Lisbon"
    }),
    message("A2", GROUP_CHAT, {
      senderSourceJid: "15550002222@s.whatsapp.net",
      timestampMs: Date.now() - 2 * DAY_MS,
      body: "did you see the rent numbers?"
    }),
    message("A3", GROUP_CHAT, {
      senderSourceJid: "15550002222@s.whatsapp.net",
      timestampMs: Date.now() - DAY_MS,
      body: "the deposit is due friday"
    }),
    message("A4", GROUP_CHAT, {
      senderSourceJid: "15550002222@s.whatsapp.net",
      timestampMs: Date.now() - DAY_MS / 2,
      body: "kal nahi aa raha hoon",
      isDeleted: true
    })
  ]);
}

async function writeGolden(dir: string, set: BrainGoldenSet): Promise<string> {
  const filePath = path.join(dir, "golden-queries.json");
  await writeFile(filePath, JSON.stringify(set, null, 2), "utf8");
  return filePath;
}

function goldenForSeed(): BrainGoldenSet {
  return {
    version: 1,
    queries: [
      { id: "q-para", class: "paraphrase", query: "apartment lisbon", expect: [messageKey(DM_CHAT, "A1")] },
      {
        id: "q-commit",
        class: "commitment",
        query: "deposit due",
        expect: [messageKey(GROUP_CHAT, "A3"), messageKey(GROUP_CHAT, "GONE")]
      },
      { id: "q-zero", class: "temporal", query: "zzzqxy hexagon", expect: [messageKey(GROUP_CHAT, "A2")] },
      { id: "q-skip", class: "person", query: "anything at all", expect: [messageKey(GROUP_CHAT, "NEVER-EXISTED")] }
    ]
  };
}

// A minimal synthetic evidence pack over seeded messages — enough for
// generateEpisodeForPack's extractive/fallback paths and commit stamps.
function packFor(
  chatSourceId: string,
  entries: Array<{ id: string; body: string; senderJid: string; atMs: number }>
): BrainEvidencePack {
  const messages: MemoryEvidenceMessage[] = entries.map((entry, index) => ({
    citationLabel: `m${index + 1}`,
    messageId: index + 1,
    sourceMessageKey: messageKey(chatSourceId, entry.id),
    sourceMessageId: entry.id,
    sourceChatId: chatSourceId,
    chatId: 1,
    chatDisplayName: "Flat Hunt",
    senderSourceJid: entry.senderJid,
    senderDisplayName: "Sam Iyer",
    timestampMs: entry.atMs,
    sentAt: null,
    direction: "incoming",
    messageType: "text",
    interpretation: null,
    text: entry.body,
    linkPreview: null,
    isForwarded: false,
    quotedSourceMessageId: null,
    quotedSnapshot: null,
    structuredSignals: null,
    reactions: [],
    senderNameIsPushName: false
  }));
  return {
    chatSourceId,
    chatDisplayName: "Flat Hunt",
    startAtMs: Math.min(...entries.map((entry) => entry.atMs)),
    endAtMs: Math.max(...entries.map((entry) => entry.atMs)),
    participants: [...new Set(entries.map((entry) => entry.senderJid))],
    messages
  };
}

async function commitModelEpisode(
  repository: ArchiveRepository,
  chatSourceId: string,
  model: string,
  claims: Array<{ text: string; cites: string[] }>,
  options: { supersedes?: string | null } = {}
): Promise<string> {
  const committed = await repository.commitBrainEpisode({
    chatSourceId,
    startAtMs: Date.now() - DAY_MS,
    endAtMs: Date.now(),
    messageCount: claims.length,
    participants: ["15550002222@s.whatsapp.net"],
    summary: `Summary for ${model}`,
    markdown: "",
    generator: "model",
    model,
    runId: null,
    extractionVersion: EXTRACTION_VERSION,
    supersedesEpisodeId: options.supersedes ?? null,
    claims: claims.map((claim) => ({ kind: "fact" as const, text: claim.text, citations: claim.cites }))
  });
  return committed.id;
}

function syntheticRun(overrides: Partial<BrainEvalRunRecord>): BrainEvalRunRecord {
  return {
    id: crypto.randomUUID(),
    ranAtMs: Date.now(),
    target: "archive-search",
    goldenVersion: 1,
    goldenHash: "hash-a",
    kValues: [5],
    queryCount: 2,
    skippedQueryIds: [],
    perClass: [
      { class: "paraphrase", queries: 1, recallAtK: { "5": 1 } },
      { class: "person", queries: 1, recallAtK: { "5": 1 } }
    ],
    perQuery: [
      { queryId: "p1", class: "paraphrase", query: "x", validExpected: ["k1"], invalidExpected: [], ranks: { k1: 1 }, recallAtK: { "5": 1 } },
      { queryId: "n1", class: "person", query: "y", validExpected: ["k2"], invalidExpected: [], ranks: { k2: 1 }, recallAtK: { "5": 1 } }
    ],
    totals: { queries: 2, recallAtK: { "5": 1 }, zeroHitQueries: 0 },
    notes: null,
    ...overrides
  };
}

describe("brain eval harness", () => {
  it("golden set: scaffold refuses to measure, real content loads with a stable hash that moves on edit", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-eval-golden-"));
    try {
      const filePath = path.join(tempDir, "golden-queries.json");
      expect(() => loadGoldenSet(filePath)).toThrowError(/No golden set/);
      const info = scaffoldGoldenSet(filePath);
      expect(info.queryCount).toBe(1);
      // The unreplaced scaffold placeholder must never read as a measurement.
      expect(() => loadGoldenSet(filePath)).toThrowError(/placeholder/);
      expect(() => scaffoldGoldenSet(filePath)).toThrowError(/already exists/);

      await writeGolden(tempDir, goldenForSeed());
      const first = loadGoldenSet(filePath);
      expect(first.info.queryCount).toBe(4);
      expect(first.info.classes).toEqual(["commitment", "paraphrase", "person", "temporal"]);
      const again = loadGoldenSet(filePath);
      expect(again.info.hash).toBe(first.info.hash);

      const edited = goldenForSeed();
      edited.version = 2;
      edited.queries[0]!.query = "flat viewing lisbon";
      await writeGolden(tempDir, edited);
      const reloaded = loadGoldenSet(filePath);
      expect(reloaded.info.version).toBe(2);
      expect(reloaded.info.hash).not.toBe(first.info.hash);

      // Shape violations are named, not swallowed.
      await writeFile(filePath, JSON.stringify({ version: 1, queries: [{ id: "a", class: "x", query: "q", expect: [] }] }), "utf8");
      expect(() => loadGoldenSet(filePath)).toThrowError(/expect/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  for (const backend of ["sqlite", "memory"] as const) {
    it(`runner (${backend}): recall math, invalid-expectation quarantine, and determinism`, async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), `wapp-eval-run-${backend}-`));
      const repository: ArchiveRepository =
        backend === "sqlite" ? new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite")) : new MemoryArchiveRepository();
      try {
        await seedArchive(repository);
        const goldenPath = await writeGolden(tempDir, goldenForSeed());
        const run = await runBrainEval(repository, { goldenPath });

        expect(run.queryCount).toBe(4);
        expect(run.totals.queries).toBe(3); // q-skip is quarantined entirely
        expect(run.skippedQueryIds).toEqual(["q-skip"]);
        const byId = new Map(run.perQuery.map((entry) => [entry.queryId, entry]));
        // Exact hit at rank 1: full recall at every K.
        expect(byId.get("q-para")!.ranks[messageKey(DM_CHAT, "A1")]).toBe(1);
        expect(byId.get("q-para")!.recallAtK["5"]).toBe(1);
        // One valid + one stale expected key: the stale key is quarantined,
        // recall is computed over the valid one only — never a retrieval miss.
        expect(byId.get("q-commit")!.invalidExpected).toEqual([messageKey(GROUP_CHAT, "GONE")]);
        expect(byId.get("q-commit")!.recallAtK["5"]).toBe(1);
        // A query whose expected message never matches is an honest zero.
        expect(byId.get("q-zero")!.recallAtK["20"]).toBe(0);
        expect(run.totals.zeroHitQueries).toBe(1);
        const paraphrase = run.perClass.find((stat) => stat.class === "paraphrase")!;
        expect(paraphrase.recallAtK["5"]).toBe(1);
        expect(run.totals.recallAtK["5"]).toBeCloseTo(2 / 3, 4);

        // Persisted and comparable.
        const stored = await repository.getBrainEvalRun(run.id);
        expect(stored?.totals.recallAtK["5"]).toBeCloseTo(2 / 3, 4);

        // Determinism: same archive, same golden content, same results.
        const second = await runBrainEval(repository, { goldenPath });
        expect(second.perClass).toEqual(run.perClass);
        expect(second.perQuery).toEqual(run.perQuery);
        expect(second.goldenHash).toBe(run.goldenHash);

        // The second run resolves the first as its baseline (same hash).
        const baseline = await resolveEvalBaseline(repository, second, null);
        expect(baseline?.id).toBe(run.id);
        expect(computeEvalGate(second, baseline).verdict).toBe("pass");
      } finally {
        await repository.close?.();
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }

  it("gate: regressions name the class and offending queries; cross-hash is labelled; explicit baseline must exist", async () => {
    const repository = new MemoryArchiveRepository();
    const baseline = syntheticRun({ ranAtMs: Date.now() - 1000 });
    const regressed = syntheticRun({
      ranAtMs: Date.now(),
      perClass: [
        { class: "paraphrase", queries: 1, recallAtK: { "5": 0.5 } },
        { class: "person", queries: 1, recallAtK: { "5": 1 } }
      ],
      perQuery: [
        { queryId: "p1", class: "paraphrase", query: "x", validExpected: ["k1"], invalidExpected: [], ranks: { k1: null }, recallAtK: { "5": 0.5 } },
        { queryId: "n1", class: "person", query: "y", validExpected: ["k2"], invalidExpected: [], ranks: { k2: 1 }, recallAtK: { "5": 1 } }
      ]
    });
    await repository.insertBrainEvalRun(baseline);
    await repository.insertBrainEvalRun(regressed);

    const gate = computeEvalGate(regressed, baseline);
    expect(gate.verdict).toBe("fail");
    expect(gate.regressions).toHaveLength(1);
    expect(gate.regressions[0]!.class).toBe("paraphrase");
    expect(gate.regressions[0]!.offendingQueryIds).toEqual(["p1"]);

    expect(computeEvalGate(baseline, null).verdict).toBe("no-baseline");
    const crossHash = computeEvalGate(syntheticRun({ goldenHash: "hash-b" }), baseline);
    expect(crossHash.sameGolden).toBe(false);

    // resolveEvalBaseline: latest same-hash prior run wins; a foreign-hash run
    // in between is invisible to the default baseline.
    const later = syntheticRun({ ranAtMs: Date.now() + 1000 });
    await repository.insertBrainEvalRun(syntheticRun({ goldenHash: "hash-b", ranAtMs: Date.now() + 500 }));
    await repository.insertBrainEvalRun(later);
    const resolved = await resolveEvalBaseline(repository, later, null);
    expect(resolved?.goldenHash).toBe("hash-a");
    expect(resolved?.id).toBe(regressed.id);
    await expect(resolveEvalBaseline(repository, later, "missing-run-id")).rejects.toThrowError(/baseline/i);
  });

  for (const backend of ["sqlite", "memory"] as const) {
    it(`grading (${backend}): deterministic ungraded-first sample, denormalized grades that survive supersession and reset`, async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), `wapp-eval-grade-${backend}-`));
      const repository: ArchiveRepository =
        backend === "sqlite" ? new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite")) : new MemoryArchiveRepository();
      try {
        await seedArchive(repository);
        const a3 = messageKey(GROUP_CHAT, "A3");
        const a4 = messageKey(GROUP_CHAT, "A4");
        await commitModelEpisode(repository, GROUP_CHAT, "terra", [
          { text: "The deposit is due on Friday.", cites: [a3] },
          { text: "Someone is not coming tomorrow.", cites: [a4, messageKey(GROUP_CHAT, "GONE")] }
        ]);
        await commitModelEpisode(repository, DM_CHAT, "sonnet", [
          { text: "Riya found an apartment in Lisbon.", cites: [messageKey(DM_CHAT, "A1")] }
        ]);
        // A superseded episode's claims must never enter the sample.
        const oldEpisode = await commitModelEpisode(repository, GROUP_CHAT, "terra", [{ text: "Old superseded claim.", cites: [a3] }]);
        await repository.markBrainEpisodeSuperseded(oldEpisode);
        // Extractive episodes are honest placeholders, not gradeable output.
        await repository.commitBrainEpisode({
          chatSourceId: GROUP_CHAT,
          startAtMs: Date.now() - DAY_MS,
          endAtMs: Date.now(),
          messageCount: 1,
          participants: [],
          summary: "extractive",
          markdown: "",
          generator: "extractive",
          model: null,
          runId: null,
          extractionVersion: EXTRACTION_VERSION,
          claims: [{ kind: "fact", text: "Extractive claim.", citations: [a3] }]
        });

        const sample = await repository.listClaimsForGrading({ perModel: 10 });
        expect(sample.models.map((model) => model.model)).toEqual(["sonnet", "terra"]);
        const terra = sample.models.find((model) => model.model === "terra")!;
        expect(terra.eligibleClaims).toBe(2);
        expect(terra.claims).toHaveLength(2);
        // Citations resolve message text server-side; missing originals are
        // tombstoned, deleted ones flagged.
        const flaggedClaim = terra.claims.find((claim) => claim.text.includes("not coming"))!;
        const gone = flaggedClaim.citations.find((citation) => !citation.present)!;
        expect(gone.text).toBeNull();
        const deleted = flaggedClaim.citations.find((citation) => citation.sourceMessageKey === a4)!;
        expect(deleted.deleted).toBe(true);
        expect(deleted.text).toContain("nahi");

        // Deterministic: the same state yields the same sample.
        const sampleAgain = await repository.listClaimsForGrading({ perModel: 10 });
        expect(sampleAgain.models).toEqual(sample.models);

        // Grade → denormalized stamps; regrade overwrites; ungraded-first.
        const gradedClaim = terra.claims[0]!;
        const grade = await repository.upsertBrainClaimGrade(gradedClaim.claimId, "supported");
        expect(grade.model).toBe("terra");
        expect(grade.extractionVersion).toBe(EXTRACTION_VERSION);
        expect(grade.claimText).toBe(gradedClaim.text);
        await repository.upsertBrainClaimGrade(gradedClaim.claimId, "partial");
        const afterGrade = await repository.listClaimsForGrading({ perModel: 10 });
        const terraAfter = afterGrade.models.find((model) => model.model === "terra")!;
        expect(terraAfter.gradedClaims).toBe(1);
        expect(terraAfter.claims.some((claim) => claim.claimId === gradedClaim.claimId)).toBe(false);
        const withGraded = await repository.listClaimsForGrading({ perModel: 10, includeGraded: true });
        const terraWith = withGraded.models.find((model) => model.model === "terra")!;
        // Ungraded first, then the graded one, grade attached.
        expect(terraWith.claims[terraWith.claims.length - 1]!.claimId).toBe(gradedClaim.claimId);
        expect(terraWith.claims[terraWith.claims.length - 1]!.grade).toBe("partial");

        await expect(repository.upsertBrainClaimGrade("no-such-claim", "supported")).rejects.toThrowError(/claim/i);

        // Ground truth outlives derived data: a full reset keeps runs + grades.
        await repository.insertBrainEvalRun(syntheticRun({}));
        await repository.resetBrainDerivedData();
        expect((await repository.listBrainEvalRuns({})).length).toBe(1);
        const aggregatesAfterReset = await repository.getBrainModelQualityAggregates();
        const terraAggregate = aggregatesAfterReset.find((aggregate) => aggregate.model === "terra")!;
        expect(terraAggregate.grades.partial).toBe(1);
        expect(terraAggregate.modelEpisodes).toBe(0); // episodes wiped, grades kept
      } finally {
        await repository.close?.();
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }

  it("aggregates: fallback attribution via attempted_model with an unknown bucket, strict precision excludes unclear", async () => {
    const repository = new MemoryArchiveRepository();
    await seedArchive(repository);
    const a3 = messageKey(GROUP_CHAT, "A3");
    await commitModelEpisode(repository, GROUP_CHAT, "terra", [
      { text: "Claim one.", cites: [a3] },
      { text: "Claim two.", cites: [a3] },
      { text: "Claim three.", cites: [a3] }
    ]);
    // A model attempt that fell back, attributed to terra.
    await repository.commitBrainEpisode({
      chatSourceId: GROUP_CHAT,
      startAtMs: Date.now() - DAY_MS,
      endAtMs: Date.now(),
      messageCount: 1,
      participants: [],
      summary: "fallback",
      markdown: "",
      generator: "extractive",
      model: null,
      runId: null,
      fallbackReason: "validation failed twice",
      attemptedModel: "terra",
      extractionVersion: EXTRACTION_VERSION,
      claims: [{ kind: "fact", text: "Fallback claim.", citations: [a3] }]
    });
    // A legacy fallback that predates the stamp lands in 'unknown'.
    await repository.commitBrainEpisode({
      chatSourceId: GROUP_CHAT,
      startAtMs: Date.now() - DAY_MS,
      endAtMs: Date.now(),
      messageCount: 1,
      participants: [],
      summary: "legacy fallback",
      markdown: "",
      generator: "extractive",
      model: null,
      runId: null,
      fallbackReason: "old row",
      extractionVersion: EXTRACTION_VERSION,
      claims: [{ kind: "fact", text: "Legacy fallback claim.", citations: [a3] }]
    });
    // No-provider extractive rows (fallbackReason null) measure configuration,
    // not model quality — excluded from every bucket.
    await repository.commitBrainEpisode({
      chatSourceId: GROUP_CHAT,
      startAtMs: Date.now() - DAY_MS,
      endAtMs: Date.now(),
      messageCount: 1,
      participants: [],
      summary: "plain extractive",
      markdown: "",
      generator: "extractive",
      model: null,
      runId: null,
      extractionVersion: EXTRACTION_VERSION,
      claims: []
    });

    const sample = await repository.listClaimsForGrading({ perModel: 10 });
    const terraClaims = sample.models.find((model) => model.model === "terra")!.claims;
    await repository.upsertBrainClaimGrade(terraClaims[0]!.claimId, "supported");
    await repository.upsertBrainClaimGrade(terraClaims[1]!.claimId, "unsupported");
    await repository.upsertBrainClaimGrade(terraClaims[2]!.claimId, "unclear");

    const aggregates = await repository.getBrainModelQualityAggregates();
    const terra = aggregates.find((aggregate) => aggregate.model === "terra")!;
    expect(terra.modelEpisodes).toBe(1);
    expect(terra.fallbackEpisodes).toBe(1);
    expect(terra.attempted).toBe(2);
    expect(terra.fallbackRate).toBeCloseTo(0.5, 5);
    expect(terra.claims).toBe(3);
    expect(terra.gradedTotal).toBe(3);
    // unclear is excluded from the precision denominator.
    expect(terra.strictPrecision).toBeCloseTo(0.5, 5);
    const unknown = aggregates.find((aggregate) => aggregate.model === "unknown")!;
    expect(unknown.fallbackEpisodes).toBe(1);
    expect(unknown.modelEpisodes).toBe(0);
    expect(aggregates.some((aggregate) => aggregate.model === "extractive")).toBe(false);
  });

  it("fallback path stamps attempted_model on the committed episode (model requested, provider unavailable)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-eval-fallback-"));
    // Isolate provider state: a temp provider.json with no opt-in means the
    // model attempt fails locally (no network) and falls back to extractive.
    const restore = configureBrain({ providerConfigPath: path.join(tempDir, "provider.json"), provider: "extractive" });
    const repository = new MemoryArchiveRepository();
    try {
      await seedArchive(repository);
      const pack = packFor(GROUP_CHAT, [
        { id: "A3", body: "the deposit is due friday", senderJid: "15550002222@s.whatsapp.net", atMs: Date.now() - DAY_MS }
      ]);
      const result = await generateEpisodeForPack(repository, pack, { generator: "model", model: "test-model-x" });
      expect(result.fellBackToExtractive).toBe(true);
      expect(result.episode.generator).toBe("extractive");
      expect(result.episode.fallbackReason).toBeTruthy();
      expect(result.episode.attemptedModel).toBe("test-model-x");

      // A deliberate extractive run is not an attempt at anything.
      const extractive = await generateEpisodeForPack(
        repository,
        packFor(GROUP_CHAT, [
          { id: "A2", body: "did you see the rent numbers?", senderJid: "15550002222@s.whatsapp.net", atMs: Date.now() - 2 * DAY_MS }
        ]),
        { generator: "extractive" }
      );
      expect(extractive.episode.attemptedModel).toBeNull();
      expect(extractive.episode.fallbackReason).toBeNull();
    } finally {
      restore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("eval tables survive the contract-shape rebuild that drops every derived brain table (sqlite)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-eval-rebuild-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    // Point the vault at the temp dir BEFORE opening the repository: the
    // rebuild guard deletes projected episode files from config.brain.rootDir,
    // and the default is the user's real workdir.
    const restoreVault = configureBrain({ rootDir: tempDir });
    let repository: SqliteArchiveRepository | null = new SqliteArchiveRepository(dbPath);
    try {
      await repository.insertBrainEvalRun(syntheticRun({}));
      await repository.close?.();
      repository = null;
      // Regress brain_episodes to its pre-contract-v2 shape so the rebuild
      // guard fires on next open and drops the whole derived brain set.
      // The guard also deletes every .md under config.brain.rootDir/episodes —
      // WITHOUT the isolation below that is the user's real Obsidian vault,
      // and `npm test` silently wipes their projected episodes every run.
      const raw = new Database(dbPath);
      raw.exec(`DROP TABLE IF EXISTS brain_media_gaps; DROP TABLE IF EXISTS brain_episode_signal_anchors;
        DROP TABLE IF EXISTS brain_validation_issues; DROP TABLE IF EXISTS brain_episode_topics; DROP TABLE IF EXISTS brain_topics;
        DROP TABLE IF EXISTS brain_claim_entities; DROP TABLE IF EXISTS brain_citations; DROP TABLE IF EXISTS brain_claims;
        DROP TABLE IF EXISTS brain_episodes;
        CREATE TABLE brain_episodes (id TEXT PRIMARY KEY, chat_source_id TEXT NOT NULL);`);
      raw.close();
      repository = new SqliteArchiveRepository(dbPath);
      const runs = await repository.listBrainEvalRuns({});
      expect(runs).toHaveLength(1);
      // And the derived set was rebuilt to the current shape.
      expect(await repository.countRegenerableBrainEpisodes(EXTRACTION_VERSION)).toBe(0);
    } finally {
      await repository?.close?.();
      restoreVault();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("CLI probe: delegates only when something is listening", async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/search/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ index: { state: "ready", totalMessages: 0 } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      expect(await localServerListening(`http://127.0.0.1:${port}`)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await localServerListening(`http://127.0.0.1:${port}`)).toBe(false);
  });

  it("eval API routes: golden lifecycle, run, grading round-trip with server-side stamps, aggregates", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wapp-eval-api-"));
    const archivePath = path.join(temp, "archive.sqlite");
    const workDir = path.join(temp, "work");
    const repository = new SqliteArchiveRepository(archivePath);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      await seedArchive(repository);
      const a3 = messageKey(GROUP_CHAT, "A3");
      await commitModelEpisode(repository, GROUP_CHAT, "terra", [{ text: "The deposit is due on Friday.", cites: [a3] }]);
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

      // Golden lifecycle over HTTP: absent → scaffold → placeholder refuses.
      const golden = await fetchJson<{ exists: boolean; info: unknown }>(`${base}/api/brain/eval/golden`);
      expect(golden.exists).toBe(false);
      await fetchJson(`${base}/api/brain/eval/golden/scaffold`, { method: "POST", body: "{}" });
      const placeholderRun = await fetch(`${base}/api/brain/eval/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(placeholderRun.status).toBe(400);
      expect(((await placeholderRun.json()) as { error: string }).error).toContain("placeholder");

      // Real golden content → a run with a no-baseline gate, then a pass.
      await writeGolden(path.join(workDir, "eval"), goldenForSeed());
      const firstRun = await fetchJson<{ run: BrainEvalRunRecord; gate: { verdict: string } }>(`${base}/api/brain/eval/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(firstRun.run.totals.queries).toBe(3);
      expect(firstRun.gate.verdict).toBe("no-baseline");
      const secondRun = await fetchJson<{ gate: { verdict: string; baselineRunId: string | null } }>(`${base}/api/brain/eval/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(secondRun.gate.verdict).toBe("pass");
      expect(secondRun.gate.baselineRunId).toBe(firstRun.run.id);
      expect(await fetchJson<unknown[]>(`${base}/api/brain/eval/runs?limit=10`)).toHaveLength(2);

      // Grading round-trip: the server stamps from the episode; client-sent
      // stamp fields are ignored entirely.
      const sample = await fetchJson<{ models: Array<{ model: string; claims: Array<{ claimId: string; citations: Array<{ text: string | null }> }> }> }>(
        `${base}/api/brain/eval/grading-sample?perModel=5`
      );
      expect(sample.models[0]!.model).toBe("terra");
      const claim = sample.models[0]!.claims[0]!;
      expect(claim.citations[0]!.text).toContain("deposit");
      const graded = await fetchJson<{ grade: { model: string; extractionVersion: number } }>(`${base}/api/brain/eval/grades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId: claim.claimId, grade: "supported", model: "HACKED", extractionVersion: 999 })
      });
      expect(graded.grade.model).toBe("terra");
      expect(graded.grade.extractionVersion).toBe(EXTRACTION_VERSION);
      const badGrade = await fetch(`${base}/api/brain/eval/grades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId: claim.claimId, grade: "amazing" })
      });
      expect(badGrade.status).toBe(400);

      const aggregates = await fetchJson<Array<{ model: string; grades: { supported: number } }>>(`${base}/api/brain/eval/aggregates`);
      expect(aggregates.find((aggregate) => aggregate.model === "terra")!.grades.supported).toBe(1);
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
