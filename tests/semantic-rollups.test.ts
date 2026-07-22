// Semantic rollups (semantic-rollups): the structured-statements contract, the
// exact regression guard (declared supersession vs unexplained shrinkage),
// deterministic input selection with persisted audit, conflict recall +
// post-write verification (never prompt hints), embedded lifecycle resolutions
// through the ONE writer, rollback, projection determinism, and identity
// repair reaching statement prose. Repository scenarios run against BOTH
// backends (SQLite and the in-memory mirror) — parity by execution.

import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import {
  buildRollupPrompt,
  detectConflictPairs,
  parseRollupResponse,
  renderDocMarkdown,
  renderOverviewMarkdown,
  runRollupGuard,
  selectRollupClaims,
  type ConflictClaimFacts,
  type DocRenderContext
} from "../src/server/brain/rollups";
import { projectBrainDocs, projectBrainEpisodes, projectBrainOverview, rebuildBrainProjection } from "../src/server/brain/projection";
import {
  chatFallbackLabel,
  docFileBase,
  docFileMatchesSlug,
  episodeFileBase,
  episodeFileMatchesId,
  sanitizeVaultLabel
} from "../src/server/brain/vaultNames";
import type { ArchiveRepository } from "../src/server/db/repository";
import type {
  BrainClaimInput,
  BrainDocSection,
  BrainEpisodeInput,
  BrainRollupInputClaim,
  BrainRollupRevisionInput,
  MessageRecord
} from "../src/shared/types";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const CHAT = "rollup@g.us";
const RIYA = "1555@s.whatsapp.net";

afterEach(() => {
  delete process.env.WAPP_BRAIN_ROLLUP_INPUT_TOKENS;
  delete process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS;
  delete process.env.WAPP_BRAIN_ROLLUP_DUE_NEW_CLAIMS;
  delete process.env.WAPP_BRAIN_ROLLUP_STALE_DROP_SHARE;
});

// Vault isolation for the WHOLE file: identity repair and revision commits
// re-project pages/episodes through config.brain.rootDir, which defaults to
// the real workdir — without this, tests scatter fixture .md files into the
// user's actual Obsidian vault. Belt-and-braces so any future test here is
// covered too; the projection test nests its own override on top.
let vaultDir: string;
const brainConfigBeforeFile = { ...config.brain };

beforeAll(async () => {
  vaultDir = await mkdtemp(path.join(os.tmpdir(), "wapp-rollups-vault-"));
  Object.assign(config.brain, { rootDir: vaultDir });
});

afterAll(async () => {
  Object.assign(config.brain, brainConfigBeforeFile);
  await rm(vaultDir, { recursive: true, force: true });
});

// --- Shared fixtures ---------------------------------------------------------

function message(id: string, chatSourceId: string, overrides: Partial<MessageRecord> & { timestampMs: number }): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: RIYA,
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `body of ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...overrides
  };
}

async function seedChat(repository: ArchiveRepository, chatSourceId: string, messages: MessageRecord[]): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [{ sourceJid: RIYA, displayName: "Riya", phoneNumber: "+1555" }]);
  await repository.upsertChats(runId, [
    { sourceChatId: chatSourceId, jid: chatSourceId, displayName: `Chat ${chatSourceId}`, chatType: "group" }
  ]);
  await repository.upsertMessages(messages);
}

function episodeInput(
  chatSourceId: string,
  window: { startAtMs: number; endAtMs: number },
  claims: BrainClaimInput[],
  overrides: Partial<BrainEpisodeInput> = {}
): BrainEpisodeInput {
  return {
    chatSourceId,
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    messageCount: claims.length,
    participants: ["Riya"],
    summary: "Test episode summary.",
    markdown: "",
    generator: "model",
    model: "test-model",
    runId: null,
    extractionVersion: 99,
    topics: ["planning"],
    claims,
    ...overrides
  };
}

type RepoKind = "sqlite" | "memory";

async function withRepos(test: (repository: ArchiveRepository, kind: RepoKind) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-rollups-"));
  const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await test(sqlite, "sqlite");
  } finally {
    await sqlite.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
  await test(new MemoryArchiveRepository(), "memory");
}

function inputClaim(overrides: Partial<BrainRollupInputClaim> & { claimId: string }): BrainRollupInputClaim {
  return {
    kind: "fact",
    text: `fact about ${overrides.claimId}`,
    confidence: "stated",
    eventAtMs: null,
    validUntilMs: null,
    episodeId: "ep-1",
    episodeStartAtMs: NOW - 30 * DAY_MS,
    episodeEndAtMs: NOW - 30 * DAY_MS,
    chatSourceId: CHAT,
    chatDisplayName: "Chat",
    citations: [{ sourceMessageKey: `${overrides.claimId}-key`, timestampMs: NOW - 30 * DAY_MS, senderJid: RIYA }],
    lifecycleStatus: null,
    lifecycleDueMs: null,
    ...overrides
  };
}

// Convenience: commit an episode and return its claims keyed by their text.
async function commitEpisode(
  repository: ArchiveRepository,
  input: BrainEpisodeInput
): Promise<{ id: string; claims: Map<string, { id: string; text: string }> }> {
  const record = await repository.commitBrainEpisode(input);
  return { id: record.id, claims: new Map(record.claims.map((claim) => [claim.text, { id: claim.id, text: claim.text }])) };
}

// Pick the Riya ENTITY candidate/doc explicitly — the chat and topic nodes are
// page-eligible too, so items[0] is not deterministic across kinds.
async function entityTarget(repository: ArchiveRepository): Promise<{ docId: string; kind: "entity" | "topic" | "chat"; nodeId: string; slug: string }> {
  const docs = await repository.listBrainDocs({ kind: "entity" });
  const item = docs.items.find((entry) => entry.title === "Riya") ?? docs.items[0];
  if (!item) {
    throw new Error("no entity candidate found");
  }
  const input = await repository.getBrainRollupInput({ nodeId: item.nodeId });
  if (!input) {
    throw new Error("entity candidate resolved to no rollup input");
  }
  return { docId: input.docId, kind: input.kind, nodeId: input.nodeId, slug: input.slug };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function revisionInput(
  base: { docId: string; kind: "entity" | "topic" | "chat"; nodeId: string; slug: string },
  sections: BrainDocSection[],
  fedClaimIds: string[],
  overrides: Partial<BrainRollupRevisionInput> = {}
): BrainRollupRevisionInput {
  return {
    ...base,
    sections,
    drops: [],
    resolutions: [],
    allowedCitesByClaim: new Map(),
    fedClaimIds,
    inputStats: { claimCount: fedClaimIds.length, tokenEstimate: 100, overflow: false, tiersEngaged: [] },
    model: "test-model",
    effort: "high",
    runId: null,
    promptVersion: 1,
    ...overrides
  };
}

// --- Pure core: selection ----------------------------------------------------

describe("selectRollupClaims", () => {
  it("feeds everything under budget, oldest first, no tiers engaged", () => {
    const claims = [
      inputClaim({ claimId: "b", episodeStartAtMs: NOW - 10 * DAY_MS }),
      inputClaim({ claimId: "a", episodeStartAtMs: NOW - 90 * DAY_MS })
    ];
    const selection = selectRollupClaims(claims, [], [], 50_000);
    expect(selection.fed.map((claim) => claim.claimId)).toEqual(["a", "b"]);
    expect(selection.stats.overflow).toBe(false);
    expect(selection.stats.tiersEngaged).toEqual([]);
  });

  it("on overflow: lifecycle items, prior refs, and both conflict-pair members survive", () => {
    const claims: BrainRollupInputClaim[] = [];
    for (let index = 0; index < 40; index += 1) {
      claims.push(inputClaim({ claimId: `c${index}`, episodeStartAtMs: NOW - (40 - index) * DAY_MS }));
    }
    claims.push(inputClaim({ claimId: "open1", kind: "commitment", lifecycleStatus: "open", episodeStartAtMs: NOW - 200 * DAY_MS }));
    const pairs = [{ claimIdA: "c0", claimIdB: "c1", claimKind: "fact" as const, via: "riya" }];
    // A budget too small for everything but comfortably above the priority tiers.
    const selection = selectRollupClaims(claims, pairs, ["c5"], 400);
    expect(selection.stats.overflow).toBe(true);
    const fedIds = new Set(selection.fed.map((claim) => claim.claimId));
    expect(fedIds.has("open1")).toBe(true); // tier 1: open lifecycle item
    expect(fedIds.has("c5")).toBe(true); // tier 2: prior ref
    expect(fedIds.has("c0") && fedIds.has("c1")).toBe(true); // tier 3: both pair members
    expect(selection.stats.tiersEngaged).toContain("lifecycle");
    expect(selection.stats.tiersEngaged).toContain("prior_refs");
    expect(selection.stats.tiersEngaged).toContain("conflict_pairs");
  });
});

// --- Pure core: prompt -------------------------------------------------------

describe("buildRollupPrompt", () => {
  it("renders dated fenced claims with [OPEN] markers and NO conflict labels", () => {
    const open = inputClaim({ claimId: "k1", kind: "commitment", lifecycleStatus: "open", lifecycleDueMs: NOW - DAY_MS });
    const fact = inputClaim({ claimId: "k2", eventAtMs: NOW - 5 * DAY_MS });
    const prompt = buildRollupPrompt({ kind: "entity", title: "Riya", prior: null }, [open, fact], NOW);
    expect(prompt.user).toContain("BEGIN CLAIMS");
    expect(prompt.user).toContain("[OPEN, due passed]");
    expect(prompt.user).toContain("event:");
    // The anchoring principle: the detector's pairs never surface as hints.
    expect(prompt.user.toLowerCase()).not.toContain("conflict");
    expect(prompt.user.toLowerCase()).not.toContain("contradic");
    expect(prompt.claimByAlias.get("c1")?.claimId).toBe("k1");
    expect(prompt.openLifecycleClaimIds.has("k1")).toBe(true);
  });

  it("names the prior revision's claims so drops are declarable", () => {
    const a = inputClaim({ claimId: "a" });
    const b = inputClaim({ claimId: "b" });
    const prompt = buildRollupPrompt(
      { kind: "entity", title: "Riya", prior: { revisionId: 1, revision: 1, referencedClaimIds: ["a"] } },
      [a, b],
      NOW
    );
    expect(prompt.user).toContain("revision 1");
    expect(prompt.user).toContain("MUST appear in drops");
  });
});

// --- Pure core: response parsing --------------------------------------------

describe("parseRollupResponse", () => {
  const claims = [
    inputClaim({ claimId: "k1", kind: "commitment", lifecycleStatus: "open" }),
    inputClaim({ claimId: "k2", episodeEndAtMs: NOW - 2 * DAY_MS, citations: [{ sourceMessageKey: "k2-key", timestampMs: NOW - 2 * DAY_MS, senderJid: RIYA }] }),
    inputClaim({ claimId: "k3", episodeStartAtMs: NOW - 60 * DAY_MS, episodeEndAtMs: NOW - 60 * DAY_MS })
  ];
  const prompt = buildRollupPrompt({ kind: "entity", title: "Riya", prior: null }, claims, NOW);

  it("salvages routine deviations and resolves aliases to ids", () => {
    const parsed = parseRollupResponse(
      {
        sections: { title: "Notes", statements: { text: "One grounded fact.", claims: "c2, c3" } },
        drops: [],
        resolutions: []
      },
      prompt
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.sections[0]?.statements[0]?.claimIds).toEqual(["k2", "k3"]);
  });

  it("collects unknown aliases, empty statements, and bad drops", () => {
    const parsed = parseRollupResponse(
      {
        sections: [{ title: "Notes", statements: [{ text: "Ghost.", claims: ["c9"] }, { text: "", claims: ["c1"] }] }],
        drops: [{ claim: "c3", reason: "superseded" }, { claim: "c3", reason: "banana" }]
      },
      prompt
    );
    expect(parsed.errors.some((error) => error.includes("unknown claim alias"))).toBe(true);
    expect(parsed.errors.some((error) => error.includes("empty text"))).toBe(true);
    expect(parsed.errors.some((error) => error.includes("names no valid replacement"))).toBe(true);
  });

  it("rejects a superseding replacement older than the dropped claim", () => {
    const parsed = parseRollupResponse(
      { sections: [{ title: "N", statements: [{ text: "ok", claims: ["c2"] }] }], drops: [{ claim: "c2", reason: "superseded", by: "c3" }] },
      prompt
    );
    expect(parsed.errors.some((error) => error.includes("older than the dropped claim"))).toBe(true);
  });

  it("expands resolution cites from claim aliases to that claim's message keys", () => {
    const parsed = parseRollupResponse(
      {
        sections: [{ title: "N", statements: [{ text: "ok", claims: ["c2"] }] }],
        resolutions: [{ item: "c1", status: "fulfilled", cites: ["c2"] }]
      },
      prompt
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.resolutions[0]?.claimId).toBe("k1");
    expect(parsed.resolutions[0]?.cites).toEqual(["k2-key"]);
    expect(parsed.allowedCitesByClaim.get("k1")?.[0]?.claimId).toBe("k2");
  });

  it("filters resolution evidence to keys that POSTDATE the item's own messages", () => {
    // k3's citations (NOW-30d, same as k1's own) do not postdate k1 — the
    // selection-time rule (§L2) rejects with a message the retry can act on.
    const parsed = parseRollupResponse(
      {
        sections: [{ title: "N", statements: [{ text: "ok", claims: ["c2"] }] }],
        resolutions: [{ item: "c1", status: "fulfilled", cites: ["c3"] }]
      },
      prompt
    );
    expect(parsed.errors.some((error) => error.includes("NEWER than the item's own messages"))).toBe(true);
  });

  it("refuses a resolution targeting a non-open item or citing itself", () => {
    const parsed = parseRollupResponse(
      {
        sections: [{ title: "N", statements: [{ text: "ok", claims: ["c2"] }] }],
        resolutions: [
          { item: "c2", status: "fulfilled", cites: ["c3"] },
          { item: "c1", status: "fulfilled", cites: ["c1"] }
        ]
      },
      prompt
    );
    expect(parsed.errors.some((error) => error.includes("not an open commitment"))).toBe(true);
    expect(parsed.errors.some((error) => error.includes("cites the item itself"))).toBe(true);
  });
});

// --- Pure core: the exact guard ---------------------------------------------

describe("runRollupGuard", () => {
  it("refuses undeclared drops exactly (no thresholds)", () => {
    const result = runRollupGuard({
      priorReferencedClaimIds: ["a", "b", "c"],
      newReferencedClaimIds: ["a"],
      currentClaimIds: new Set(["a", "b", "c"]),
      declaredDrops: [{ claimId: "b", reason: "stale", byClaimId: null }],
      fedClaimIds: new Set(["a", "b", "c"])
    });
    expect(result.undeclared).toEqual(["c"]);
    expect(result.errors.some((error) => error.includes("dropped without declaration"))).toBe(true);
  });

  it("auto-annotates upstream-deleted claims and excuses not-fed prior refs", () => {
    const result = runRollupGuard({
      priorReferencedClaimIds: ["dead", "unfed", "kept"],
      newReferencedClaimIds: ["kept"],
      currentClaimIds: new Set(["unfed", "kept"]),
      declaredDrops: [],
      fedClaimIds: new Set(["kept"])
    });
    expect(result.errors).toEqual([]);
    expect(result.effectiveDrops).toEqual([{ claimId: "dead", reason: "claim_deleted", byClaimId: null }]);
    expect(result.notFed).toEqual(["unfed"]);
  });

  it("flags a claim both referenced and declared dropped", () => {
    const result = runRollupGuard({
      priorReferencedClaimIds: ["a"],
      newReferencedClaimIds: ["a"],
      currentClaimIds: new Set(["a"]),
      declaredDrops: [{ claimId: "a", reason: "stale", byClaimId: null }],
      fedClaimIds: new Set(["a"])
    });
    expect(result.errors.some((error) => error.includes("both referenced and declared dropped"))).toBe(true);
  });
});

// --- Pure core: conflict detector -------------------------------------------

describe("detectConflictPairs", () => {
  const fact = (claimId: string, episodeId: string, endMs: number, keys: string[]): ConflictClaimFacts => ({
    claimId,
    kind: "fact",
    episodeId,
    episodeEndAtMs: endMs,
    entityKeys: keys,
    supersededBy: null
  });

  it("pairs same-kind same-entity claims from different episodes; skips same-episode", () => {
    const pairs = detectConflictPairs([
      fact("a", "ep1", NOW - 10 * DAY_MS, ["riya"]),
      fact("b", "ep2", NOW - 5 * DAY_MS, ["riya"]),
      fact("c", "ep2", NOW - 5 * DAY_MS, ["riya"])
    ]);
    expect(pairs.some((pair) => (pair.claimIdA === "a" && pair.claimIdB === "b") || (pair.claimIdA === "b" && pair.claimIdB === "a"))).toBe(true);
    expect(pairs.some((pair) => pair.claimIdA === "b" && pair.claimIdB === "c")).toBe(false);
  });

  it("skips superseded claims and lifecycle kinds; honors the cap", () => {
    const many: ConflictClaimFacts[] = [];
    for (let index = 0; index < 60; index += 1) {
      many.push(fact(`m${index}`, `ep${index}`, NOW - index * DAY_MS, ["riya"]));
    }
    expect(detectConflictPairs(many, 5)).toHaveLength(5);
    expect(
      detectConflictPairs([
        { ...fact("x", "ep1", NOW, ["r"]), supersededBy: "y" },
        fact("y", "ep2", NOW, ["r"])
      ])
    ).toHaveLength(0);
    expect(
      detectConflictPairs([
        { ...fact("p", "ep1", NOW, ["r"]), kind: "commitment" },
        { ...fact("q", "ep2", NOW, ["r"]), kind: "commitment" }
      ])
    ).toHaveLength(0);
  });
});

// --- Pure core: deterministic renderers -------------------------------------

describe("renderDocMarkdown / renderOverviewMarkdown", () => {
  const context: DocRenderContext = {
    docId: "entity:person-riya",
    kind: "entity",
    slug: "person-riya",
    nodeId: "n1",
    title: "Riya",
    revision: 2,
    updatedAtMs: NOW,
    aliases: ["Riya S"],
    memberLabels: [],
    claimMeta: new Map([
      ["k1", { exists: true, episodeId: "ep1", episodeFile: "2026-01-01-chat-abc12345", episodeClaimIndex: 1, citationKeys: ["m-key-1"] }],
      ["k2", { exists: false, episodeId: null, episodeFile: null, episodeClaimIndex: null, citationKeys: [] }]
    ]),
    related: [{ kind: "topic", slug: "topic-visa", title: "visa" }],
    mergedIntoDoc: null
  };
  const sections: BrainDocSection[] = [
    { title: "Facts", statements: [{ text: "Riya lives in Pune.", claimIds: ["k1"] }, { text: "Old thing.", claimIds: ["k2"] }] }
  ];

  it("is deterministic (two renders byte-identical) with structural links and anchors", () => {
    const first = renderDocMarkdown(context, sections);
    const second = renderDocMarkdown(context, sections);
    expect(first).toBe(second);
    expect(first).toContain("slug: person-riya");
    expect(first).toContain("[[episodes/2026-01-01-chat-abc12345#^claim-1]]");
    expect(first).toContain("`m-key-1`");
    expect(first).toContain("^stmt-");
    expect(first).toContain("(claim removed)");
    expect(first).toContain("[[topics/topic-visa|visa]]");
  });

  it("renders a merged doc as a one-line redirect stub", () => {
    const stub = renderDocMarkdown({ ...context, mergedIntoDoc: { slug: "person-riya-s", kind: "entity", title: "Riya S" } }, sections);
    expect(stub).toContain("Merged into [[entities/person-riya-s|Riya S]]");
    expect(stub).not.toContain("Facts");
  });

  it("overview renders counts with zero model input", () => {
    const overview = renderOverviewMarkdown({
      generatedAtMs: NOW,
      coveragePercent: 42.5,
      totalVisibleMessages: 1000,
      assimilatedVisibleMessages: 425,
      docsTotal: 3,
      docsDue: 1,
      docCandidates: 2,
      openItems: 4,
      overdueItems: 1,
      staleItems: 0,
      soonestDue: [{ text: "send the report", dueMs: NOW + DAY_MS, chatLabel: "Work" }],
      topEntities: [{ title: "Riya", kind: "entity", slug: "person-riya", salience: 3, hasDoc: true }],
      issueCount: 0,
      orphanedResolutions: 0,
      lastRunLine: "rollup completed",
      providerLine: null
    });
    expect(overview).toContain("generator: deterministic");
    expect(overview).toContain("3 (1 due for a rollup, 2 eligible without a page yet)");
    expect(overview).toContain("[[entities/person-riya|Riya]]");
  });
});

// --- Repository scenarios (both backends) -----------------------------------

describe("doc revisions: commit, guard, supersession, rollback", () => {
  it("commits a first revision, records refs, and reports the doc not due", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("M1", CHAT, { timestampMs: base }), message("M2", CHAT, { timestampMs: base + 1 })]);
      const key1 = messageKey(CHAT, "M1");
      const key2 = messageKey(CHAT, "M2");
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya lives in Pune.", citations: [key1], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya works at Acme.", citations: [key2], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const claimIds = [...episode.claims.values()].map((claim) => claim.id);
      // The person node is a page candidate (never_rolled).
      const before = await repository.listBrainDocs({});
      const candidate = before.items.find((item) => item.kind === "entity" && item.title === "Riya");
      expect(candidate).toBeDefined();
      expect(candidate!.due).toBe(true);
      expect(candidate!.dueReasons).toContain("never_rolled");
      const input = await repository.getBrainRollupInput({ nodeId: candidate!.nodeId });
      expect(input).not.toBeNull();
      expect(input!.claims.map((claim) => claim.claimId).sort()).toEqual([...claimIds].sort());
      const commit = await repository.commitBrainDocRevision(
        revisionInput(
          { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug },
          [{ title: "Facts", statements: [{ text: "Riya lives in Pune and works at Acme.", claimIds }] }],
          claimIds
        )
      );
      expect(commit.record.revision).toBe(1);
      expect(commit.record.status).toBe("current");
      const detail = await repository.getBrainDoc(input!.docId);
      expect(detail?.current?.revision).toBe(1);
      expect(detail?.markdown).toContain("Riya lives in Pune");
      expect(detail?.due).toBe(false);
      expect(detail?.history).toHaveLength(1);
    });
  });

  it("refuses undeclared shrinkage (the checkpoint scenario) and keeps the prior revision current", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      const messages = ["M1", "M2", "M3", "M4"].map((id, index) => message(id, CHAT, { timestampMs: base + index }));
      await seedChat(repository, CHAT, messages);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, ["M1", "M2", "M3", "M4"].map((id, index) => ({
          kind: "fact" as const,
          text: `Fact number ${index} about Riya.`,
          citations: [messageKey(CHAT, id)],
          entities: [{ kind: "person" as const, name: "Riya", jid: RIYA }]
        })))
      );
      const claimIds = [...episode.claims.values()].map((claim) => claim.id);
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "All four facts.", claimIds }] }], claimIds)
      );
      // A stub model drops half its claims WITHOUT declaring supersession.
      const half = claimIds.slice(0, 2);
      await expect(
        repository.commitBrainDocRevision(revisionInput(target, [{ title: "Facts", statements: [{ text: "Only half.", claimIds: half }] }], claimIds))
      ).rejects.toThrow(/dropped without declaration/);
      // The prior revision stays current; the rejected attempt is retained.
      await repository.rejectBrainDocRevision({
        ...target,
        errors: ["2 claim(s) the prior revision represented were dropped without declaration"],
        fedClaimIds: claimIds,
        inputStats: { claimCount: claimIds.length, tokenEstimate: 100, overflow: false, tiersEngaged: [] },
        model: "stub",
        effort: "high",
        runId: null,
        promptVersion: 1
      });
      const detail = await repository.getBrainDoc(target.docId);
      expect(detail?.current?.revision).toBe(1);
      expect(detail?.history.some((revision) => revision.status === "rejected" && revision.errors != null)).toBe(true);
      expect(detail?.issues.some((issue) => issue.code === "rollup_rejected" && issue.severity === "error")).toBe(true);
      // Regression (found live): a later valid commit must number PAST the
      // rejected revision (UNIQUE(doc_id, revision)) — rejected rows occupy
      // numbers even though they were never current.
      const again = await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "All four facts again.", claimIds }] }], claimIds)
      );
      expect(again.record.revision).toBe(3);
      expect((await repository.getBrainDoc(target.docId))?.current?.revision).toBe(3);
    });
  });

  it("accepts declared supersession, projects the column, excludes superseded claims from input, and rolls back mechanically", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      const older = message("OLD", CHAT, { timestampMs: base });
      const newer = message("NEW", CHAT, { timestampMs: base + 10 * DAY_MS });
      await seedChat(repository, CHAT, [older, newer]);
      const episode1 = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya lives in Pune.", citations: [messageKey(CHAT, "OLD")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya likes tea.", citations: [messageKey(CHAT, "OLD")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const oldClaim = episode1.claims.get("Riya lives in Pune.")!;
      const keepClaim = episode1.claims.get("Riya likes tea.")!;
      const input1 = await repository.getBrainRollupInput({ nodeId: (await repository.listBrainDocs({})).items[0]!.nodeId });
      const target = { docId: input1!.docId, kind: input1!.kind, nodeId: input1!.nodeId, slug: input1!.slug };
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "Pune; tea.", claimIds: [oldClaim.id, keepClaim.id] }] }], [oldClaim.id, keepClaim.id])
      );
      // A newer episode contradicts the location; revision 2 declares it.
      const episode2 = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base + 9 * DAY_MS, endAtMs: base + 11 * DAY_MS }, [
          { kind: "fact", text: "Riya moved to Mumbai.", citations: [messageKey(CHAT, "NEW")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const newClaim = episode2.claims.get("Riya moved to Mumbai.")!;
      const fed = [oldClaim.id, keepClaim.id, newClaim.id];
      const commit2 = await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "Mumbai now; tea.", claimIds: [newClaim.id, keepClaim.id] }] }], fed, {
          drops: [{ claimId: oldClaim.id, reason: "superseded", byClaimId: newClaim.id }]
        })
      );
      expect(commit2.record.revision).toBe(2);
      expect(commit2.record.drops).toEqual([{ claimId: oldClaim.id, reason: "superseded", byClaimId: newClaim.id }]);
      // Superseded claims leave future input.
      const input2 = await repository.getBrainRollupInput({ nodeId: target.nodeId });
      expect(input2!.claims.some((claim) => claim.claimId === oldClaim.id)).toBe(false);
      // Mechanical rollback restores revision 1 and re-derives the projection.
      const restored = await repository.rollbackBrainDoc(target.docId, null);
      expect(restored?.current?.revision).toBe(1);
      const input3 = await repository.getBrainRollupInput({ nodeId: target.nodeId });
      expect(input3!.claims.some((claim) => claim.claimId === oldClaim.id)).toBe(true);
      expect(restored?.issues.some((issue) => issue.code === "rollup_rollback")).toBe(true);
    });
  });
});

describe("unroll (rollback to revision 0)", () => {
  it("returns the doc to never-rolled, clears supersession, keeps every revision restorable", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("A", CHAT, { timestampMs: base }), message("B", CHAT, { timestampMs: base + 10 * DAY_MS })]);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya lives in Pune.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya likes tea.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya moved to Mumbai.", citations: [messageKey(CHAT, "B")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const pune = episode.claims.get("Riya lives in Pune.")!;
      const tea = episode.claims.get("Riya likes tea.")!;
      const mumbai = episode.claims.get("Riya moved to Mumbai.")!;
      const target = await entityTarget(repository);
      const fed = [pune.id, tea.id, mumbai.id];
      // Rev 1 represents everything; rev 2 declares the supersession (a drop
      // is only legal against a prior revision that represented the claim).
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "Pune; tea; Mumbai.", claimIds: fed }] }], fed)
      );
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "Mumbai; tea.", claimIds: [mumbai.id, tea.id] }] }], fed, {
          drops: [{ claimId: pune.id, reason: "superseded", byClaimId: mumbai.id }]
        })
      );
      // Supersession is projected, so the dropped claim leaves rollup input.
      expect((await repository.getBrainRollupInput({ nodeId: target.nodeId }))!.claims.some((c) => c.claimId === pune.id)).toBe(false);

      const unrolled = await repository.rollbackBrainDoc(target.docId, 0);
      expect(unrolled?.current).toBeNull();
      expect(unrolled?.doc.currentRevisionId).toBeNull();
      // Back to a fresh candidate: due as never_rolled, and the next rollup
      // sees NO prior accounting, so it generates from scratch.
      expect(unrolled?.dueReasons).toContain("never_rolled");
      const freshInput = await repository.getBrainRollupInput({ nodeId: target.nodeId });
      expect(freshInput!.prior).toBeNull();
      // Supersession cleared: the superseded claim is eligible input again.
      expect(freshInput!.claims.some((c) => c.claimId === pune.id)).toBe(true);
      // Nothing destroyed — every revision is retained and restorable.
      expect(unrolled?.history.map((h) => h.revision)).toEqual([2, 1]);
      const restored = await repository.rollbackBrainDoc(target.docId, 2);
      expect(restored?.current?.revision).toBe(2);
      expect((await repository.getBrainRollupInput({ nodeId: target.nodeId }))!.claims.some((c) => c.claimId === pune.id)).toBe(false);
      // The docs list stops counting an unrolled doc as a page.
      await repository.rollbackBrainDoc(target.docId, 0);
      const list = await repository.listBrainDocs({});
      expect(list.counts.docs).toBe(0);
      expect(list.items.find((item) => item.docId === target.docId)?.revision ?? null).toBeNull();
    });
  });
});

describe("embedded lifecycle resolutions (the ONE writer)", () => {
  it("applies a resolution atomically with the revision; out-of-input cites refuse everything", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 30 * DAY_MS;
      await seedChat(repository, CHAT, [
        message("P", CHAT, { timestampMs: base }),
        message("D", CHAT, { timestampMs: base + 5 * DAY_MS })
      ]);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + 6 * DAY_MS }, [
          { kind: "commitment", text: "Riya will send the report.", citations: [messageKey(CHAT, "P")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya sent the report on Friday.", citations: [messageKey(CHAT, "D")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const promise = episode.claims.get("Riya will send the report.")!;
      const done = episode.claims.get("Riya sent the report on Friday.")!;
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      const openClaim = input!.claims.find((claim) => claim.claimId === promise.id);
      expect(openClaim?.lifecycleStatus).toBe("open");
      const doneKey = messageKey(CHAT, "D");
      const commit = await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Status", statements: [{ text: "Report delivered.", claimIds: [promise.id, done.id] }] }], [promise.id, done.id], {
          resolutions: [{ claimId: promise.id, toStatus: "fulfilled", cites: [doneKey], note: null }],
          allowedCitesByClaim: new Map([
            [promise.id, [{ kind: "claim", sourceMessageKey: doneKey, timestampMs: base + 5 * DAY_MS, senderJid: RIYA, senderLabel: null, text: done.text, claimId: done.id }]]
          ])
        })
      );
      expect(commit.record.resolutionEventIds).toHaveLength(1);
      const items = await repository.listBrainLifecycleItems({ status: "fulfilled" });
      expect(items.items.some((item) => item.claimId === promise.id)).toBe(true);

      // Out-of-input cite: the writer's closed world refuses; NOTHING applies.
      const episode2 = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base + 7 * DAY_MS, endAtMs: base + 8 * DAY_MS }, [
          { kind: "commitment", text: "Riya will book flights.", citations: [messageKey(CHAT, "D")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const promise2 = episode2.claims.get("Riya will book flights.")!;
      await expect(
        repository.commitBrainDocRevision(
          revisionInput(target, [{ title: "Status", statements: [{ text: "All done.", claimIds: [promise2.id] }] }], [promise.id, done.id, promise2.id], {
            drops: [
              { claimId: promise.id, reason: "stale", byClaimId: null },
              { claimId: done.id, reason: "stale", byClaimId: null }
            ],
            resolutions: [{ claimId: promise2.id, toStatus: "fulfilled", cites: ["not-a-real-key"], note: null }],
            allowedCitesByClaim: new Map([[promise2.id, []]])
          })
        )
      ).rejects.toThrow(/not offered|BRAIN_LIFECYCLE/i);
      const open = await repository.listBrainLifecycleItems({ status: "open" });
      expect(open.items.some((item) => item.claimId === promise2.id)).toBe(true);
      // The refused commit applied nothing: the doc still shows revision 1.
      const detail = await repository.getBrainDoc(target.docId);
      expect(detail?.current?.revision).toBe(1);
    });
  });
});

describe("vault file naming", () => {
  // Names are user text; every hostile case below is drawn from the real
  // archive. A name that Windows silently rewrites is a file we can never
  // find again, and a collision is two chats overwriting each other.
  it("keeps names readable while making them path-safe", () => {
    expect(sanitizeVaultLabel("Milan / Millie (Chopta Trek)", "x")).toBe("Milan Millie (Chopta Trek)");
    expect(sanitizeVaultLabel("Aajke kotay group call?", "x")).toBe("Aajke kotay group call");
    expect(sanitizeVaultLabel("Sanjib Kr Mollick-1 Tax File A-8/429", "x")).toBe("Sanjib Kr Mollick-1 Tax File A-8 429");
    // Non-ASCII is legal and IS the readability — never strip it.
    expect(sanitizeVaultLabel("永遠の友達", "x")).toBe("永遠の友達");
    expect(sanitizeVaultLabel("Rocket League Bõís", "x")).toBe("Rocket League Bõís");
    // Windows drops trailing dots/spaces silently; do it ourselves so the name
    // written is the name found again.
    expect(sanitizeVaultLabel("Office aaoge? ", "x")).toBe("Office aaoge");
    expect(sanitizeVaultLabel("DLRG.....forever?", "x")).toBe("DLRG.....forever");
    // Reserved device names cannot be files at all.
    expect(sanitizeVaultLabel("CON", "x")).toBe("_CON");
    // 127 chats with episodes have no name; the address is the honest label.
    expect(sanitizeVaultLabel(null, chatFallbackLabel("919088460418@s.whatsapp.net"))).toBe("919088460418");
    expect(sanitizeVaultLabel("   ", chatFallbackLabel("@"))).toBe("unknown chat");
  });

  it("composes episode and page names with a stable id", () => {
    const episode = { id: "2796c25e-b6d3-44b0-a6f3-3937f23015ae", startAtMs: Date.UTC(2014, 6, 21, 14, 35), chatSourceId: "x@g.us", chatDisplayName: "A03 BATCH FIITJEE" };
    expect(episodeFileBase(episode)).toBe("A03 BATCH FIITJEE 2014-07-21 2796c25e");
    // The label leads so a flat folder groups a chat's episodes; the date sorts
    // them within that group. Both properties are the point of the ordering.
    const series = [
      { ...episode, id: "aaaaaaaa-0000-0000-0000-000000000000", startAtMs: Date.UTC(2015, 0, 2) },
      { ...episode, id: "bbbbbbbb-0000-0000-0000-000000000000", startAtMs: Date.UTC(2014, 6, 21), chatDisplayName: "Zebra Chat" },
      { ...episode, id: "cccccccc-0000-0000-0000-000000000000", startAtMs: Date.UTC(2014, 6, 21) }
    ].map(episodeFileBase);
    expect([...series].sort()).toEqual([
      "A03 BATCH FIITJEE 2014-07-21 cccccccc",
      "A03 BATCH FIITJEE 2015-01-02 aaaaaaaa",
      "Zebra Chat 2014-07-21 bbbbbbbb"
    ]);
    // "Supratik" names 7 different chats in the real archive, so the slug is
    // not decoration — it is what makes the name unique.
    expect(docFileBase("Supratik", "person-919088460418")).toBe("Supratik (person-919088460418)");
    expect(docFileBase("", "person-919088460418")).toBe("person-919088460418 (person-919088460418)");
    // A stale copy is identified by its id, whatever label it was written under.
    expect(episodeFileMatchesId("2014-07-21-919831899481-2796c25e.md", episode.id)).toBe(true);
    expect(episodeFileMatchesId("2014-07-21 Old Name 2796c25e.md", episode.id)).toBe(true);
    expect(episodeFileMatchesId("2014-07-21 Other 99999999.md", episode.id)).toBe(false);
    expect(docFileMatchesSlug("Old Name (person-919088460418).md", "person-919088460418")).toBe(true);
    expect(docFileMatchesSlug("X (person-919088460418-2).md", "person-919088460418")).toBe(false);
  });
});

describe("run audit", () => {
  // A run is asked for ONE artifact but can change others alongside it. The
  // audit exists so those side effects are attributable rather than folded
  // into a counter — and a page must be able to ask "which runs touched me?".
  it("attributes page, closure, and supersession effects to the run, and scopes history to one page", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 30 * DAY_MS;
      await seedChat(repository, CHAT, [
        message("P", CHAT, { timestampMs: base }),
        message("OLD", CHAT, { timestampMs: base + DAY_MS }),
        message("D", CHAT, { timestampMs: base + 5 * DAY_MS })
      ]);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + 6 * DAY_MS }, [
          { kind: "commitment", text: "Riya will send the report.", citations: [messageKey(CHAT, "P")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya works from Pune.", citations: [messageKey(CHAT, "OLD")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya sent the report on Friday.", citations: [messageKey(CHAT, "D")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const promise = episode.claims.get("Riya will send the report.")!;
      const stale = episode.claims.get("Riya works from Pune.")!;
      const done = episode.claims.get("Riya sent the report on Friday.")!;
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };

      // An unrelated run first: it must never appear in this page's history.
      const otherRunId = await repository.startBrainRun("nightly");
      await repository.completeBrainRun(otherRunId, { episodes: 1 });

      // Revision 1 (run-less) represents all three claims, so revision 2 has a
      // prior to declare its supersession against — the guard's closed world.
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Status", statements: [{ text: "Everything so far.", claimIds: [promise.id, stale.id, done.id] }] }], [
          promise.id,
          stale.id,
          done.id
        ])
      );

      const runId = await repository.startBrainRun("rollup");
      const doneKey = messageKey(CHAT, "D");
      await repository.commitBrainDocRevision(
        revisionInput(
          target,
          [{ title: "Status", statements: [{ text: "Report delivered.", claimIds: [promise.id, done.id] }] }],
          [promise.id, stale.id, done.id],
          {
            runId,
            drops: [{ claimId: stale.id, reason: "superseded", byClaimId: done.id }],
            resolutions: [{ claimId: promise.id, toStatus: "fulfilled", cites: [doneKey], note: "delivered Friday" }],
            allowedCitesByClaim: new Map([
              [promise.id, [{ kind: "claim", sourceMessageKey: doneKey, timestampMs: base + 5 * DAY_MS, senderJid: RIYA, senderLabel: null, text: done.text, claimId: done.id }]]
            ])
          }
        )
      );
      await repository.completeBrainRun(runId, { docsCommitted: 1 });

      // Unscoped history carries effect counts on every row — the side effect
      // (a closed commitment) is readable WITHOUT opening the run.
      const all = await repository.listBrainRuns({ limit: 50 });
      const rollupRow = all.find((entry) => entry.run.id === runId)!;
      expect(rollupRow.effects).toMatchObject({ pagesWritten: 1, pagesRefused: 0, lifecycleChanges: 1, claimsSuperseded: 1 });
      expect(rollupRow.docEffect).toBeNull();
      expect(all.find((entry) => entry.run.id === otherRunId)!.effects.pagesWritten).toBe(0);

      // Scoped to the page: only runs that touched it, with what they did to it.
      const scoped = await repository.listBrainRuns({ docId: target.docId, limit: 50 });
      expect(scoped.map((entry) => entry.run.id)).toEqual([runId]);
      expect(scoped[0]!.docEffect).toMatchObject({ revision: 2, status: "current", isCurrent: true, statementCount: 1 });
      expect(scoped[0]!.effects.lifecycleChanges).toBe(1);

      // The full audit resolves the closure to its item, evidence, and status now.
      const effects = await repository.getBrainRunEffects(runId);
      expect(effects!.lifecycle).toHaveLength(1);
      expect(effects!.lifecycle[0]).toMatchObject({
        claimId: promise.id,
        itemText: "Riya will send the report.",
        // The audit offers to open the item only while it still exists —
        // regeneration can remove one out from under a past run's event.
        itemExists: true,
        toStatus: "fulfilled",
        currentStatus: "fulfilled",
        note: "delivered Friday"
      });
      expect(effects!.lifecycle[0]!.cites.map((cite) => cite.sourceMessageKey)).toEqual([doneKey]);
      expect(effects!.revisions).toHaveLength(1);
      expect(effects!.revisions[0]).toMatchObject({ docId: target.docId, revision: 2, isCurrent: true });
      expect(effects!.supersessionCount).toBe(1);
      expect(await repository.getBrainRunEffects("no-such-run")).toBeNull();
    });
  });

  it("keeps a refused consolidation in the page's own history", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 20 * DAY_MS;
      const messages = ["R1", "R2"].map((id, index) => message(id, CHAT, { timestampMs: base + index }));
      await seedChat(repository, CHAT, messages);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, ["R1", "R2"].map((id, index) => ({
          kind: "fact" as const,
          text: `Fact ${index} about Riya.`,
          citations: [messageKey(CHAT, id)],
          entities: [{ kind: "person" as const, name: "Riya", jid: RIYA }]
        })))
      );
      const claimIds = [...episode.claims.values()].map((claim) => claim.id);
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      const runId = await repository.startBrainRun("rollup");
      await repository.rejectBrainDocRevision({
        ...target,
        errors: ["1 claim(s) the prior revision represented were dropped without declaration"],
        fedClaimIds: claimIds,
        inputStats: { claimCount: claimIds.length, tokenEstimate: 100, overflow: false, tiersEngaged: [] },
        model: "stub",
        effort: "high",
        runId,
        promptVersion: 1
      });
      // A refusal is part of the page's history, not an absence from it.
      const scoped = await repository.listBrainRuns({ docId: target.docId, limit: 50 });
      expect(scoped.map((entry) => entry.run.id)).toEqual([runId]);
      expect(scoped[0]!.effects).toMatchObject({ pagesWritten: 0, pagesRefused: 1 });
      expect(scoped[0]!.docEffect).toMatchObject({ status: "rejected", isCurrent: false });
      expect(scoped[0]!.docEffect!.errors?.[0]).toMatch(/without declaration/);
      expect(scoped[0]!.effects.issues).toBeGreaterThan(0);
    });
  });
});

describe("post-write verification and dueness", () => {
  it("flags residual same-entity contradictions as warning issues (never a prompt hint)", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("A", CHAT, { timestampMs: base }), message("B", CHAT, { timestampMs: base + 10 * DAY_MS })]);
      const episode1 = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya lives in Pune.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Riya has a cat.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const episode2 = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base + 9 * DAY_MS, endAtMs: base + 11 * DAY_MS }, [
          { kind: "fact", text: "Riya lives in Mumbai.", citations: [messageKey(CHAT, "B")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const pune = episode1.claims.get("Riya lives in Pune.")!;
      const cat = episode1.claims.get("Riya has a cat.")!;
      const mumbai = episode2.claims.get("Riya lives in Mumbai.")!;
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      // The detector saw the pair; the prompt never labels it.
      expect(input!.conflictPairs.length).toBeGreaterThan(0);
      const commit = await repository.commitBrainDocRevision(
        revisionInput(
          { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug },
          [{ title: "Facts", statements: [{ text: "Pune AND Mumbai, plus a cat.", claimIds: [pune.id, mumbai.id, cat.id] }] }],
          [pune.id, mumbai.id, cat.id]
        )
      );
      expect(commit.contradictions.length).toBeGreaterThan(0);
      const detail = await repository.getBrainDoc(input!.docId);
      expect(detail?.issues.some((issue) => issue.code === "rollup_contradiction" && issue.severity === "warning")).toBe(true);
    });
  });

  it("computes dueness deterministically: new claims, deleted refs, lifecycle churn", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "2";
    process.env.WAPP_BRAIN_ROLLUP_DUE_NEW_CLAIMS = "2";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("A", CHAT, { timestampMs: base }), message("B", CHAT, { timestampMs: base + 10 * DAY_MS })]);
      const episode1 = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Fact one about Riya.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Fact two about Riya.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const claimIds = [...episode1.claims.values()].map((claim) => claim.id);
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "Facts", statements: [{ text: "Both facts.", claimIds }] }], claimIds)
      );
      expect((await repository.getBrainDoc(target.docId))?.due).toBe(false);
      // Two new claims cross the due threshold. Real time must pass so the new
      // episode's created_at postdates the rollup stamp. Kept comfortably above
      // clock granularity — a 15ms gap flaked once under full-suite load.
      await sleep(60);
      await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base + 9 * DAY_MS, endAtMs: base + 11 * DAY_MS }, [
          { kind: "fact", text: "Fresh fact A about Riya.", citations: [messageKey(CHAT, "B")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          { kind: "fact", text: "Fresh fact B about Riya.", citations: [messageKey(CHAT, "B")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const afterNew = await repository.getBrainDoc(target.docId);
      expect(afterNew?.due).toBe(true);
      expect(afterNew?.dueReasons).toContain("new_claims");
      // Upstream deletion of a referenced claim makes the doc due honestly.
      await repository.markBrainEpisodeSuperseded(episode1.id);
      const afterDelete = await repository.getBrainDoc(target.docId);
      expect(afterDelete?.dueReasons).toContain("claims_deleted");
    });
  });
});

describe("reset, repair, and projection", () => {
  it("full reset wipes docs; a chat-scoped reset leaves them standing", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "1";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("A", CHAT, { timestampMs: base })]);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya fact.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const claimIds = [...episode.claims.values()].map((claim) => claim.id);
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      await repository.commitBrainDocRevision(revisionInput(target, [{ title: "F", statements: [{ text: "ok", claimIds }] }], claimIds));
      // Scoped reset: the doc survives (its refs die → dueness, honestly).
      await repository.resetBrainDerivedData({ chatSourceId: CHAT });
      expect((await repository.listBrainDocs({})).counts.docs).toBe(1);
      // Full reset: docs go with the rest of the derived state.
      await repository.resetBrainDerivedData();
      expect((await repository.listBrainDocs({})).counts.docs).toBe(0);
    });
  });

  it("identity repair reaches statement prose with zero model calls", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "1";
    await withRepos(async (repository) => {
      const base = NOW - 40 * DAY_MS;
      const unresolvedJid = "917700900086@s.whatsapp.net";
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertChats(runId, [{ sourceChatId: CHAT, jid: CHAT, displayName: "Chat", chatType: "group" }]);
      await repository.upsertMessages([message("A", CHAT, { timestampMs: base, senderSourceJid: unresolvedJid })]);
      const episode = await commitEpisode(
        repository,
        episodeInput(
          CHAT,
          { startAtMs: base, endAtMs: base + DAY_MS },
          [
            {
              kind: "fact",
              text: "+917700900086 promised the docs.",
              citations: [messageKey(CHAT, "A")],
              entities: [{ kind: "person", name: "+917700900086", jid: unresolvedJid }]
            }
          ],
          // The unresolved-participant stamp is what makes prose repairable.
          { unresolvedParticipants: [unresolvedJid] }
        )
      );
      const claimIds = [...episode.claims.values()].map((claim) => claim.id);
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      await repository.commitBrainDocRevision(
        revisionInput(target, [{ title: "F", statements: [{ text: "+917700900086 promised the docs.", claimIds }] }], claimIds)
      );
      // A contact save resolves the number; repair sweeps prose deterministically.
      const importRun = await repository.startImportRun({ test: true });
      await repository.upsertContacts(importRun, [{ sourceJid: unresolvedJid, displayName: "Asha", phoneNumber: "+917700900086" }]);
      await repository.repairIdentityResolution(unresolvedJid);
      const detail = await repository.getBrainDoc(target.docId);
      const statementText = detail?.current?.sections[0]?.statements[0]?.text ?? "";
      expect(statementText).toContain("Asha");
      expect(statementText).not.toContain("+917700900086 promised");
    });
  });

  it("restores a wiped episodes/ directory from the database", async () => {
    // The vault is a pure projection: losing episode .md files must never be
    // data loss. (A test that regressed the schema to fire the contract-v2
    // rebuild guard was deleting the real vault on every `npm test` — the
    // recovery path below is what makes that survivable.)
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-episode-restore-"));
    const previous = { ...config.brain };
    Object.assign(config.brain, { rootDir: tempDir });
    try {
      const repository = new MemoryArchiveRepository();
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("A", CHAT, { timestampMs: base })]);
      const record = await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya fact.", citations: [messageKey(CHAT, "A")] }
        ])
      );
      await repository.updateBrainEpisodeMarkdown(record.id, "# Episode\n\n- Riya fact. ^claim-1");
      const episodesDir = path.join(tempDir, "episodes");
      // Nothing on disk yet — exactly the state a wipe leaves behind.
      expect(fs.existsSync(episodesDir)).toBe(false);
      const restored = await projectBrainEpisodes(repository);
      expect(restored.written).toBe(1);
      const files = fs.readdirSync(episodesDir);
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(episodesDir, files[0]), "utf8")).toContain("Riya fact.");
      // Idempotent: a second pass rewrites nothing.
      expect((await projectBrainEpisodes(repository)).written).toBe(0);
      // And the full rebuild restores episodes alongside pages.
      fs.rmSync(path.join(episodesDir, files[0]));
      expect((await rebuildBrainProjection(repository)).episodesWritten).toBe(1);
    } finally {
      Object.assign(config.brain, previous);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects pages + overview idempotently and sweeps orphans on rebuild", async () => {
    process.env.WAPP_BRAIN_ROLLUP_MIN_CLAIMS = "1";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-rollup-proj-"));
    const previous = { ...config.brain };
    Object.assign(config.brain, { rootDir: tempDir });
    try {
      const repository = new MemoryArchiveRepository();
      const base = NOW - 40 * DAY_MS;
      await seedChat(repository, CHAT, [message("A", CHAT, { timestampMs: base })]);
      const episode = await commitEpisode(
        repository,
        episodeInput(CHAT, { startAtMs: base, endAtMs: base + DAY_MS }, [
          { kind: "fact", text: "Riya fact.", citations: [messageKey(CHAT, "A")], entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const claimIds = [...episode.claims.values()].map((claim) => claim.id);
      const targetIds = await entityTarget(repository);
      const input = await repository.getBrainRollupInput({ nodeId: targetIds.nodeId });
      const target = { docId: input!.docId, kind: input!.kind, nodeId: input!.nodeId, slug: input!.slug };
      await repository.commitBrainDocRevision(revisionInput(target, [{ title: "F", statements: [{ text: "ok", claimIds }] }], claimIds));
      const first = await projectBrainDocs(repository);
      expect(first.written).toBe(1);
      // Name reads first, immutable slug disambiguates (7 real chats share the
      // name "Supratik"), so the file is readable in Obsidian AND unique.
      const pagePath = path.join(tempDir, "entities", `Riya (${target.slug}).md`);
      expect(fs.existsSync(pagePath)).toBe(true);
      await projectBrainOverview(repository);
      expect(fs.existsSync(path.join(tempDir, "overview.md"))).toBe(true);
      // Episodes: chat name first so a chat's episodes group, then the date,
      // then the short id.
      await repository.updateBrainEpisodeMarkdown(episode.id, "# Episode\n\n- Riya fact. ^claim-1");
      await projectBrainEpisodes(repository);
      const episodeFiles = fs.readdirSync(path.join(tempDir, "episodes"));
      expect(episodeFiles).toEqual([`Chat ${CHAT} ${new Date(base).toISOString().slice(0, 10)} ${episode.id.slice(0, 8)}.md`]);
      // The page's wikilink must resolve to that exact file — the two names
      // come from one definition precisely so this can never drift.
      const page = fs.readFileSync(pagePath, "utf8");
      expect(page).toContain(`[[episodes/${episodeFiles[0]!.replace(/\.md$/, "")}#^claim-`);
      // Idempotent: a second pass rewrites nothing.
      const second = await projectBrainDocs(repository);
      expect(second.written).toBe(0);
      expect(second.unchanged).toBe(1);
      // An orphan page file (from a wiped doc) is swept by the rebuild.
      fs.writeFileSync(path.join(tempDir, "entities", "ghost.md"), "orphan", "utf8");
      // …as is an episode file left under a superseded naming convention —
      // this is the migration path for the 9.4k already-projected files.
      fs.writeFileSync(path.join(tempDir, "episodes", `2014-07-21-919831899481-${episode.id.slice(0, 8)}.md`), "old name", "utf8");
      const rebuild = await rebuildBrainProjection(repository);
      expect(rebuild.removed).toBe(2);
      expect(fs.existsSync(pagePath)).toBe(true);
      expect(fs.readdirSync(path.join(tempDir, "episodes"))).toEqual(episodeFiles);
    } finally {
      Object.assign(config.brain, previous);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
