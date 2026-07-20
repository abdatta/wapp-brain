// Commitment lifecycle: the durable event fold, closed-world postdating
// validation, deterministic closure candidates (late reactions, replies,
// entity-overlapping claims), the L0 surface semantics (status-driven,
// overdue/stale, ordering), resolves-edge projection, rebuild/reset/supersede
// survival, and the closure sweep executor. Repository scenarios run against
// BOTH backends (SQLite and the in-memory mirror) — parity by execution.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import {
  buildLifecycleSweepPrompt,
  compareLifecycleItems,
  computeLifecycleFlags,
  foldLifecycleEvents,
  makeLifecycleComparator,
  parseLifecycleSweepResponse,
  type LifecycleSortable
} from "../src/server/brain/lifecycle";
import type { ArchiveRepository } from "../src/server/db/repository";
import type {
  BrainClaimInput,
  BrainEpisodeInput,
  BrainLifecycleEventRecord,
  BrainLifecycleSweepBatch,
  MessageRecord
} from "../src/shared/types";

const DAY_MS = 86_400_000;
const NOW = Date.now();

afterEach(() => {
  delete process.env.WAPP_BRAIN_SALIENCE_DORMANT;
  delete process.env.WAPP_BRAIN_LIFECYCLE_STALE_DAYS;
});

// --- Shared fixtures --------------------------------------------------------

const CHAT = "lifecycle@g.us";
const DM = "1666@s.whatsapp.net";
const RIYA = "1555@s.whatsapp.net";
const ARJUN = "1666@s.whatsapp.net";

function message(id: string, chatSourceId: string, overrides: Partial<MessageRecord> & { timestampMs: number }): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: "",
    sourceTable: "test",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: null,
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

async function seedChat(
  repository: ArchiveRepository,
  chatSourceId: string,
  messages: MessageRecord[],
  contacts: Array<{ sourceJid: string; displayName?: string | null; pushName?: string | null; phoneNumber?: string | null }> = []
): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  if (contacts.length) {
    await repository.upsertContacts(runId, contacts);
  }
  await repository.upsertChats(runId, [
    { sourceChatId: chatSourceId, jid: chatSourceId, displayName: `Chat ${chatSourceId}`, chatType: chatSourceId.endsWith("@g.us") ? "group" : "dm" }
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
    topics: ["visa"],
    claims,
    ...overrides
  };
}

type RepoKind = "sqlite" | "memory";

async function withRepos(test: (repository: ArchiveRepository, kind: RepoKind) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-lifecycle-"));
  const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await test(sqlite, "sqlite");
  } finally {
    await sqlite.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
  await test(new MemoryArchiveRepository(), "memory");
}

const BASE = NOW - 10 * DAY_MS;

// A promise in the group chat plus later messages the candidates derive from.
function seedMessages(): MessageRecord[] {
  return [
    message("M1", CHAT, { timestampMs: BASE, senderSourceJid: RIYA, body: "I will send the visa documents by Friday." }),
    message("M2", CHAT, { timestampMs: BASE + 60_000, senderSourceJid: ARJUN, body: "Great, waiting on them." }),
    // A reply days later quoting the promise (in-chat snapshot).
    message("R1", CHAT, {
      timestampMs: BASE + 3 * DAY_MS,
      senderSourceJid: RIYA,
      body: "Done — sent the documents just now.",
      quotedSourceMessageId: "M1",
      quotedSnapshot: {
        quotedSourceMessageId: "M1",
        quotedSourceChatId: null,
        quotedSenderSourceJid: RIYA,
        quotedFromMe: null,
        timestampMs: BASE,
        messageType: "text",
        body: "I will send the visa documents by Friday.",
        caption: null,
        mentionedJids: []
      }
    }),
    // Later message in the same chat a follow-up claim can cite.
    message("M4", CHAT, { timestampMs: BASE + 4 * DAY_MS, senderSourceJid: ARJUN, body: "Riya sent the documents on Tuesday." })
  ];
}

function commitmentClaim(citeKey: string, overrides: Partial<BrainClaimInput> = {}): BrainClaimInput {
  return {
    kind: "commitment",
    text: "Riya will send the visa documents by Friday.",
    citations: [citeKey],
    validUntilMs: BASE + 5 * DAY_MS,
    confidence: "stated",
    entities: [{ kind: "person", name: "Riya", jid: RIYA }],
    ...overrides
  };
}

async function commitPromiseEpisode(repository: ArchiveRepository, overrides: Partial<BrainEpisodeInput> = {}) {
  const keys = { m1: messageKey(CHAT, "M1"), m2: messageKey(CHAT, "M2") };
  const episode = await repository.commitBrainEpisode(
    episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 120_000 }, [commitmentClaim(keys.m1)], overrides)
  );
  const claimId = episode.claims[0]!.id;
  return { episode, claimId, keys };
}

async function addReaction(repository: ArchiveRepository, targetKey: string, occurredAtMs: number, reactorJid = ARJUN): Promise<void> {
  const applied = await repository.applyLiveMessageUpdates([
    {
      eventKey: `react-${targetKey}-${occurredAtMs}`,
      chatSourceId: CHAT,
      sourceMessageKey: targetKey,
      updateType: "reaction",
      occurredAtMs,
      metadata: { emoji: "👍", reactorJid }
    }
  ]);
  expect(applied.applied).toBe(1);
}

// --- Pure module ------------------------------------------------------------

function event(partial: Partial<BrainLifecycleEventRecord> & { id: number; toStatus: BrainLifecycleEventRecord["toStatus"] }): BrainLifecycleEventRecord {
  return {
    claimId: "c1",
    source: "model",
    evidenceAtMs: null,
    note: null,
    runId: null,
    model: null,
    orphanedAtMs: null,
    createdAtMs: 1000 + partial.id,
    cites: [],
    ...partial
  };
}

describe("lifecycle fold (pure)", () => {
  it("folds terminals, reopens, and review stamps deterministically", () => {
    expect(foldLifecycleEvents([]).status).toBe("open");
    const closed = foldLifecycleEvents([event({ id: 1, toStatus: "fulfilled", evidenceAtMs: 500 })]);
    expect(closed.status).toBe("fulfilled");
    expect(closed.resolvedAtMs).toBe(500);
    const reopened = foldLifecycleEvents([event({ id: 1, toStatus: "fulfilled" }), event({ id: 2, toStatus: "reopened", source: "user" })]);
    expect(reopened.status).toBe("open");
    expect(reopened.resolvedAtMs).toBeNull();
    expect(reopened.resolvingEvent).toBeNull();
    // Review stamps: still_open never changes status but bumps the stamp.
    const reviewed = foldLifecycleEvents([event({ id: 1, toStatus: "still_open" })]);
    expect(reviewed.status).toBe("open");
    expect(reviewed.lastReviewedAtMs).toBe(1001);
    // Close → reopen → close again: the LAST terminal wins.
    const reClosed = foldLifecycleEvents([
      event({ id: 1, toStatus: "fulfilled" }),
      event({ id: 2, toStatus: "reopened", source: "user" }),
      event({ id: 3, toStatus: "dismissed", source: "user", evidenceAtMs: 900 })
    ]);
    expect(reClosed.status).toBe("dismissed");
    expect(reClosed.resolvingEvent?.id).toBe(3);
    // Orphaned events are excluded from the fold entirely.
    const orphaned = foldLifecycleEvents([event({ id: 1, toStatus: "fulfilled", orphanedAtMs: 42 })]);
    expect(orphaned.status).toBe("open");
    expect(orphaned.lastReviewedAtMs).toBeNull();
  });

  it("computes overdue/stale flags and the pinned ordering", () => {
    const asOfMs = NOW;
    expect(computeLifecycleFlags({ status: "open", dueMs: NOW - DAY_MS, lastEvidenceAtMs: NOW, lastReviewedAtMs: null, openedAtMs: NOW, asOfMs, staleDays: 30 }).overdue).toBe(true);
    expect(computeLifecycleFlags({ status: "fulfilled", dueMs: NOW - DAY_MS, lastEvidenceAtMs: null, lastReviewedAtMs: null, openedAtMs: null, asOfMs, staleDays: 30 }).overdue).toBe(false);
    const stale = computeLifecycleFlags({ status: "open", dueMs: null, lastEvidenceAtMs: NOW - 40 * DAY_MS, lastReviewedAtMs: null, openedAtMs: NOW - 60 * DAY_MS, asOfMs, staleDays: 30 });
    expect(stale.stale).toBe(true);
    // A recent review keeps it un-stale even without new evidence.
    const reviewed = computeLifecycleFlags({ status: "open", dueMs: null, lastEvidenceAtMs: NOW - 40 * DAY_MS, lastReviewedAtMs: NOW - DAY_MS, openedAtMs: NOW - 60 * DAY_MS, asOfMs, staleDays: 30 });
    expect(reviewed.stale).toBe(false);
    // Ordering: overdue first (most overdue first), then due ascending, then undated by last evidence desc.
    const items = [
      { nodeId: "d", overdue: false, dueMs: null, lastEvidenceAtMs: NOW - DAY_MS },
      { nodeId: "b", overdue: true, dueMs: NOW - DAY_MS, lastEvidenceAtMs: null },
      { nodeId: "a", overdue: true, dueMs: NOW - 3 * DAY_MS, lastEvidenceAtMs: null },
      { nodeId: "c", overdue: false, dueMs: NOW + DAY_MS, lastEvidenceAtMs: null },
      { nodeId: "e", overdue: false, dueMs: null, lastEvidenceAtMs: NOW - 5 * DAY_MS }
    ];
    expect([...items].sort(compareLifecycleItems).map((entry) => entry.nodeId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("explicit sorts route dates nulls-last with a stable id tiebreak", () => {
    const mk = (nodeId: string, over: Partial<LifecycleSortable>): LifecycleSortable => ({
      nodeId,
      overdue: false,
      dueMs: null,
      openedAtMs: null,
      lastEvidenceAtMs: null,
      lastReviewedAtMs: null,
      candidateCount: 0,
      resolution: null,
      ...over
    });
    const rows = [
      mk("a", { dueMs: NOW + 3 * DAY_MS, openedAtMs: NOW - 5 * DAY_MS, candidateCount: 2 }),
      mk("b", { dueMs: NOW + DAY_MS, openedAtMs: NOW - 2 * DAY_MS, candidateCount: 9 }),
      mk("c", { dueMs: null, openedAtMs: NOW - DAY_MS, candidateCount: 5 })
    ];
    // Due ascending: soonest first, undated (c) always last.
    expect([...rows].sort(makeLifecycleComparator("due_asc")).map((r) => r.nodeId)).toEqual(["b", "a", "c"]);
    // Due descending: latest first, undated STILL last (nulls-last both ways).
    expect([...rows].sort(makeLifecycleComparator("due_desc")).map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
    // Opened newest first.
    expect([...rows].sort(makeLifecycleComparator("opened_desc")).map((r) => r.nodeId)).toEqual(["c", "b", "a"]);
    // Most evidence first.
    expect([...rows].sort(makeLifecycleComparator("evidence_desc")).map((r) => r.nodeId)).toEqual(["b", "c", "a"]);
    // Tie on the key falls back to node id (all-equal candidateCount).
    const ties = [mk("z", { candidateCount: 1 }), mk("y", { candidateCount: 1 }), mk("x", { candidateCount: 1 })];
    expect([...ties].sort(makeLifecycleComparator("evidence_desc")).map((r) => r.nodeId)).toEqual(["x", "y", "z"]);
  });
});

describe("sweep prompt/response contract (pure)", () => {
  const batch: BrainLifecycleSweepBatch = {
    chatSourceId: CHAT,
    chatDisplayName: "Family",
    nodes: [
      {
        nodeId: "node-1",
        claimId: "claim-1",
        kind: "commitment",
        text: "Riya will send the visa documents by Friday.",
        holderLabel: "Riya",
        openedAtMs: BASE,
        dueMs: BASE + 5 * DAY_MS,
        candidates: [
          { kind: "reaction", sourceMessageKey: "k-react", timestampMs: BASE + 2 * DAY_MS, senderJid: ARJUN, senderLabel: "Arjun", text: "👍", claimId: null },
          { kind: "reply", sourceMessageKey: "k-reply", timestampMs: BASE + 3 * DAY_MS, senderJid: RIYA, senderLabel: "Riya", text: "Done — sent them.", claimId: "claim-9" }
        ]
      },
      {
        nodeId: "node-2",
        claimId: "claim-2",
        kind: "question",
        text: "Where is the appointment letter?",
        holderLabel: null,
        openedAtMs: BASE,
        dueMs: null,
        candidates: []
      }
    ]
  };

  it("renders fenced, aliased, bounded evidence with absolute dates", () => {
    const prompt = buildLifecycleSweepPrompt(batch, NOW);
    expect(prompt.user).toContain("BEGIN EVIDENCE");
    expect(prompt.user).toContain("END EVIDENCE");
    expect(prompt.user).toContain("Item n1 (commitment)");
    expect(prompt.user).toContain("Item n2 (question)");
    expect(prompt.user).toContain("e1 [");
    expect(prompt.user).toContain("e2 [");
    // Absolute dates, never relative.
    expect(prompt.user).toContain(new Date(BASE).toISOString().slice(0, 10));
    // A node with no candidates is listed only for its due-date context.
    expect(prompt.user).toContain("none (listed because its due date passed)");
    expect(prompt.system).toContain("untrusted");
    expect(prompt.nodeByAlias.get("n1")?.claimId).toBe("claim-1");
    expect(prompt.candidateByAlias.get("e2")?.candidate.sourceMessageKey).toBe("k-reply");
  });

  it("salvages routine deviations mechanically and maps cites through aliases", () => {
    const prompt = buildLifecycleSweepPrompt(batch, NOW);
    // Lone object instead of the array, comma-joined cite string.
    const parsed = parseLifecycleSweepResponse({ node: "n1", status: "fulfilled", cites: "e1, e2" }, prompt);
    expect(parsed.errors).toEqual([]);
    expect(parsed.resolutions).toHaveLength(1);
    expect(parsed.resolutions[0]!.cites.map((cite) => cite.sourceMessageKey)).toEqual(["k-react", "k-reply"]);
    expect(parsed.resolutions[0]!.cites[0]!.actorJid).toBe(ARJUN);
    expect(parsed.resolutions[0]!.cites[1]!.resolvingClaimId).toBe("claim-9");
    // n2 missing → still_open review.
    expect(parsed.missingAliases).toEqual(["n2"]);
  });

  it("collects contract violations as errors (unknown node, unknown status, foreign cite, citeless terminal)", () => {
    const prompt = buildLifecycleSweepPrompt(batch, NOW);
    const parsed = parseLifecycleSweepResponse(
      {
        resolutions: [
          { node: "n9", status: "fulfilled", cites: ["e1"] },
          { node: "n1", status: "done", cites: ["e1"] },
          { node: "n2", status: "fulfilled", cites: ["e1"] },
          { node: "n2", status: "fulfilled", cites: [] }
        ]
      },
      prompt
    );
    expect(parsed.errors.join(" ")).toMatch(/unknown node alias/);
    expect(parsed.errors.join(" ")).toMatch(/unknown status/);
    expect(parsed.errors.join(" ")).toMatch(/belongs to item n1/);
    expect(parsed.errors.join(" ")).toMatch(/resolved more than once/);
    expect(parsed.resolutions).toHaveLength(0);
  });
});

// --- Repository scenarios ---------------------------------------------------

describe("lifecycle candidates and sweep-due", () => {
  it("surfaces late reactions, quoting replies, and entity-overlapping later claims as postdating candidates", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [
        { sourceJid: RIYA, displayName: "Riya", phoneNumber: "+1555" },
        { sourceJid: ARJUN, displayName: "Arjun", phoneNumber: "+1666" }
      ]);
      const { claimId, keys } = await commitPromiseEpisode(repository);
      // Late reaction on the promise message, days after its episode committed.
      await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
      // A later episode whose claim shares the Riya entity and cites M4.
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE + 4 * DAY_MS - 60_000, endAtMs: BASE + 4 * DAY_MS + 60_000 }, [
          {
            kind: "fact",
            text: "Riya sent the documents on Tuesday.",
            citations: [messageKey(CHAT, "M4")],
            confidence: "stated",
            entities: [{ kind: "person", name: "Riya", jid: RIYA }]
          }
        ])
      );
      const batches = await repository.listBrainLifecycleSweepBatches();
      expect(batches, kind).toHaveLength(1);
      const node = batches[0]!.nodes.find((entry) => entry.claimId === claimId);
      expect(node, kind).toBeTruthy();
      const kinds = node!.candidates.map((candidate) => candidate.kind);
      expect(kinds, `${kind}: reaction candidate`).toContain("reaction");
      expect(kinds, `${kind}: reply candidate`).toContain("reply");
      expect(kinds, `${kind}: entity-overlap claim candidate`).toContain("claim");
      // Priority: reactions first; every candidate postdates the anchor.
      expect(node!.candidates[0]!.kind, kind).toBe("reaction");
      expect(node!.candidates[0]!.senderLabel, kind).toBe("Arjun");
      for (const candidate of node!.candidates) {
        expect(candidate.timestampMs!, kind).toBeGreaterThan(BASE);
      }
      // The list surface counts the same candidates and marks the node sweep-due.
      const list = await repository.listBrainLifecycleItems();
      const item = list.items.find((entry) => entry.claimId === claimId);
      expect(item!.candidateCount, kind).toBeGreaterThanOrEqual(3);
      expect(list.counts.sweepDue, kind).toBe(1);
    });
  });

  it("supports cross-chat Reply Privately snapshots as candidates", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages().slice(0, 2), [{ sourceJid: RIYA, displayName: "Riya" }]);
      await seedChat(repository, DM, [
        message("P1", DM, {
          timestampMs: BASE + 2 * DAY_MS,
          senderSourceJid: ARJUN,
          body: "About your promise — done now?",
          quotedSnapshot: {
            quotedSourceMessageId: "M1",
            quotedSourceChatId: CHAT,
            quotedSenderSourceJid: RIYA,
            quotedFromMe: null,
            timestampMs: BASE,
            messageType: "text",
            body: "I will send the visa documents by Friday.",
            caption: null,
            mentionedJids: []
          }
        })
      ]);
      const { claimId } = await commitPromiseEpisode(repository);
      const batches = await repository.listBrainLifecycleSweepBatches();
      const node = batches[0]?.nodes.find((entry) => entry.claimId === claimId);
      expect(node, kind).toBeTruthy();
      const reply = node!.candidates.find((candidate) => candidate.kind === "reply");
      expect(reply, `${kind}: cross-chat reply candidate via snapshot`).toBeTruthy();
      expect(reply!.sourceMessageKey, kind).toBe(messageKey(DM, "P1"));
    });
  });

  it("skips nodes with no new evidence: a still_open review consumes the candidates until new evidence arrives", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages().slice(0, 2), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { keys } = await commitPromiseEpisode(repository);
      const first = (await repository.listBrainLifecycleItems()).items[0]!;
      await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
      expect((await repository.listBrainLifecycleSweepBatches()).length, kind).toBe(1);
      // A still_open review stamps the node; the same candidate no longer makes it due.
      await repository.applyBrainLifecycleTransitions([{ claimId: first.claimId, toStatus: "still_open" }], { source: "model" });
      expect((await repository.listBrainLifecycleSweepBatches()).length, `${kind}: reviewed node is not re-offered`).toBe(0);
      const reviewed = (await repository.listBrainLifecycleItems()).items[0]!;
      expect(reviewed.lastReviewedAtMs, kind).not.toBeNull();
      expect(reviewed.candidateCount, kind).toBe(0);
      // New evidence AFTER the review revives dueness.
      await addReaction(repository, keys.m1, Date.now() + 1000, RIYA);
      expect((await repository.listBrainLifecycleSweepBatches()).length, `${kind}: fresh evidence re-arms the sweep`).toBe(1);
    });
  });
});

describe("lifecycle surface: flag filters and sorting", () => {
  it("filters open items by flag while keeping counts full, and honours explicit sorts", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      // A: cites M1 (anchor = BASE, ~10d ago), due 5d ago → OVERDUE.
      // B: cites M4 (anchor = BASE+4d), due far in the future → not overdue.
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 5 * DAY_MS }, [
          commitmentClaim(messageKey(CHAT, "M1"), { text: "Overdue promise A.", validUntilMs: BASE + 5 * DAY_MS }),
          commitmentClaim(messageKey(CHAT, "M4"), { text: "Future promise B.", validUntilMs: NOW + 20 * DAY_MS })
        ])
      );
      const items = (await repository.listBrainLifecycleItems({ status: "open", limit: 50 })).items;
      const a = items.find((entry) => entry.text.startsWith("Overdue"))!;
      const b = items.find((entry) => entry.text.startsWith("Future"))!;
      expect(a.overdue, kind).toBe(true);
      expect(b.overdue, kind).toBe(false);

      // Flag filter narrows the list but leaves counts at the full totals.
      const overdue = await repository.listBrainLifecycleItems({ flag: "overdue", limit: 50 });
      expect(overdue.items.map((entry) => entry.text.startsWith("Overdue")), kind).toEqual([true]);
      expect(overdue.counts.open, `${kind}: counts stay full under a flag filter`).toBe(2);
      expect(overdue.counts.overdue, kind).toBe(1);

      // Explicit sorts. due_asc: past-due A before future B.
      const byDue = await repository.listBrainLifecycleItems({ status: "open", sort: "due_asc", limit: 50 });
      expect(byDue.items.map((entry) => entry.text.slice(0, 7)), kind).toEqual(["Overdue", "Future "]);
      // opened_asc: A (older anchor) before B; opened_desc reverses.
      const openedAsc = await repository.listBrainLifecycleItems({ status: "open", sort: "opened_asc", limit: 50 });
      expect(openedAsc.items.map((entry) => entry.text.slice(0, 7)), kind).toEqual(["Overdue", "Future "]);
      const openedDesc = await repository.listBrainLifecycleItems({ status: "open", sort: "opened_desc", limit: 50 });
      expect(openedDesc.items.map((entry) => entry.text.slice(0, 7)), kind).toEqual(["Future ", "Overdue"]);
      void a;
      void b;
    });
  });

  it("sweep_due flag returns only nodes a sweep would spend on", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [
        { sourceJid: RIYA, displayName: "Riya" },
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      // One promise with a future due date (not overdue, no candidates yet) and
      // one whose message gets a later reaction (sweep-due).
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 120_000 }, [
          commitmentClaim(messageKey(CHAT, "M1"), { text: "Acknowledged promise.", validUntilMs: NOW + 30 * DAY_MS }),
          commitmentClaim(messageKey(CHAT, "M2"), { text: "Quiet promise.", validUntilMs: NOW + 30 * DAY_MS })
        ])
      );
      await addReaction(repository, messageKey(CHAT, "M1"), BASE + 2 * DAY_MS);
      const sweepDue = await repository.listBrainLifecycleItems({ flag: "sweep_due", limit: 50 });
      expect(sweepDue.items.map((entry) => entry.text), kind).toEqual(["Acknowledged promise."]);
      expect(sweepDue.counts.open, kind).toBe(2);
      expect(sweepDue.counts.sweepDue, kind).toBe(1);
    });
  });

  it("hide exclusions narrow the list (future-due only) while counts stay full", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 5 * DAY_MS }, [
          commitmentClaim(messageKey(CHAT, "M1"), { text: "Overdue promise A.", validUntilMs: BASE + 5 * DAY_MS }),
          commitmentClaim(messageKey(CHAT, "M4"), { text: "Future promise B.", validUntilMs: NOW + 20 * DAY_MS })
        ])
      );
      // The concrete ask: "order by soonest due date but only future ones."
      const futureOnly = await repository.listBrainLifecycleItems({ status: "open", hideOverdue: true, sort: "due_asc", limit: 50 });
      expect(futureOnly.items.map((entry) => entry.text), kind).toEqual(["Future promise B."]);
      // Counts remain the full open set (both), so the chips stay honest.
      expect(futureOnly.counts.open, kind).toBe(2);
      expect(futureOnly.counts.overdue, kind).toBe(1);
    });
  });

  it("dueUpcoming keeps only open, future-dated items (excludes overdue and undated)", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(
        repository,
        CHAT,
        [
          message("F1", CHAT, { timestampMs: BASE, senderSourceJid: RIYA, body: "Riya will file soon." }),
          message("F2", CHAT, { timestampMs: BASE + 60_000, senderSourceJid: ARJUN, body: "Arjun will call." }),
          message("F3", CHAT, { timestampMs: BASE + 120_000, senderSourceJid: RIYA, body: "Riya will think about it." })
        ],
        [
          { sourceJid: RIYA, displayName: "Riya" },
          { sourceJid: ARJUN, displayName: "Arjun" }
        ]
      );
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 5 * DAY_MS }, [
          // Future-dated → kept.
          { kind: "commitment", text: "Future.", citations: [messageKey(CHAT, "F1")], validUntilMs: NOW + 10 * DAY_MS, confidence: "stated", entities: [{ kind: "person", name: "Riya", jid: RIYA }] },
          // Overdue (past due) → excluded.
          { kind: "commitment", text: "Overdue.", citations: [messageKey(CHAT, "F2")], validUntilMs: BASE + DAY_MS, confidence: "stated", entities: [{ kind: "person", name: "Arjun", jid: ARJUN }] },
          // No due date → excluded.
          { kind: "commitment", text: "Undated.", citations: [messageKey(CHAT, "F3")], confidence: "stated", entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      const upcoming = await repository.listBrainLifecycleItems({ dueUpcoming: true, sort: "due_asc", limit: 50 });
      expect(upcoming.items.map((item) => item.text), kind).toEqual(["Future."]);
      // Counts stay full (all three open).
      expect(upcoming.counts.open, kind).toBe(3);
    });
  });

  it("hide fulfilled/dismissed excludes closed items from the 'all' view", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const episode = await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 120_000 }, [
          commitmentClaim(messageKey(CHAT, "M1"), { text: "Will close this.", validUntilMs: NOW + 20 * DAY_MS }),
          commitmentClaim(messageKey(CHAT, "M2"), { text: "Stays open.", validUntilMs: NOW + 20 * DAY_MS })
        ])
      );
      await repository.applyBrainLifecycleTransitions([{ claimId: episode.claims[0]!.id, toStatus: "fulfilled" }], { source: "user" });
      const all = await repository.listBrainLifecycleItems({ status: "all", limit: 50 });
      expect(all.items.length, kind).toBe(2);
      const noClosed = await repository.listBrainLifecycleItems({ status: "all", hideFulfilled: true, limit: 50 });
      expect(noClosed.items.map((entry) => entry.text), kind).toEqual(["Stays open."]);
      expect(noClosed.counts.fulfilled, `${kind}: counts stay full`).toBe(1);
    });
  });
});

describe("lifecycle surface: group facets and filter", () => {
  it("reports per-group facets and include/exclude filter items by chat", async () => {
    await withRepos(async (repository, kind) => {
      const chatA = "groupA@g.us";
      const chatB = "spam@g.us";
      await seedChat(repository, chatA, [message("A1", chatA, { timestampMs: BASE, senderSourceJid: RIYA, body: "Riya will bring cake." })], [
        { sourceJid: RIYA, displayName: "Riya" }
      ]);
      await seedChat(repository, chatB, [message("B1", chatB, { timestampMs: BASE, senderSourceJid: ARJUN, body: "Arjun will spam." })], [
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      await repository.commitBrainEpisode(
        episodeInput(chatA, { startAtMs: BASE - 60_000, endAtMs: BASE + 60_000 }, [
          { kind: "commitment", text: "Cake promise.", citations: [messageKey(chatA, "A1")], validUntilMs: NOW + 20 * DAY_MS, confidence: "stated", entities: [{ kind: "person", name: "Riya", jid: RIYA }] }
        ])
      );
      await repository.commitBrainEpisode(
        episodeInput(chatB, { startAtMs: BASE - 60_000, endAtMs: BASE + 60_000 }, [
          { kind: "commitment", text: "Spam promise.", citations: [messageKey(chatB, "B1")], validUntilMs: NOW + 20 * DAY_MS, confidence: "stated", entities: [{ kind: "person", name: "Arjun", jid: ARJUN }] }
        ])
      );
      const all = await repository.listBrainLifecycleItems({ status: "open", limit: 50 });
      const facetChats = new Set(all.chatFacets.map((facet) => facet.chatSourceId));
      expect(facetChats.has(chatA) && facetChats.has(chatB), `${kind}: both groups faceted`).toBe(true);
      expect(all.chatFacets.find((facet) => facet.chatSourceId === chatA)?.count, kind).toBe(1);
      // Include only chatA.
      const only = await repository.listBrainLifecycleItems({ status: "open", includeChats: [chatA], limit: 50 });
      expect(only.items.map((item) => item.text), kind).toEqual(["Cake promise."]);
      // Facets stay the full set even under a filter (so the picker never loses a group).
      expect(only.chatFacets.length, kind).toBe(2);
      // Exclude the spam group.
      const noSpam = await repository.listBrainLifecycleItems({ status: "open", excludeChats: [chatB], limit: 50 });
      expect(noSpam.items.map((item) => item.text), kind).toEqual(["Cake promise."]);
      // Counts stay the full open total.
      expect(noSpam.counts.open, kind).toBe(2);
    });
  });
});

describe("lifecycle item detail", () => {
  it("returns origin, all postdating candidates with thread coords, and event history", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [
        { sourceJid: RIYA, displayName: "Riya" },
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      const { claimId, keys } = await commitPromiseEpisode(repository);
      await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
      // Review the node, then fetch detail: candidates should include the
      // reaction REGARDLESS of the review (detail shows since-anchor, not
      // since-review).
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "still_open" }], { source: "model", model: "test-model" });
      const detail = await repository.getBrainLifecycleItemDetail(claimId);
      expect(detail, kind).not.toBeNull();
      expect(detail!.item.claimId, kind).toBe(claimId);
      // Origin = the promise's own cited message.
      expect(detail!.origin.length, kind).toBeGreaterThanOrEqual(1);
      expect(detail!.origin[0]!.chatId, `${kind}: origin has thread coords`).not.toBeNull();
      // Candidates present despite the review, each with click-through coords.
      const reaction = detail!.candidates.find((candidate) => candidate.kind === "reaction");
      expect(reaction, `${kind}: reaction candidate in detail after review`).toBeTruthy();
      expect(reaction!.chatId, kind).not.toBeNull();
      expect(reaction!.messageId, kind).not.toBeNull();
      // History carries the still_open review event.
      expect(detail!.events.some((event) => event.toStatus === "still_open"), kind).toBe(true);
      // Unknown claim → null.
      expect(await repository.getBrainLifecycleItemDetail("nope"), kind).toBeNull();
    });
  });
});

describe("lifecycle migration: cancelled → dismissed", () => {
  it("rebuilds the events table on open and maps existing cancelled rows to dismissed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-lifecycle-mig-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    // Pre-create the OLD-shape events table with a real cancelled transition.
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE brain_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id TEXT NOT NULL,
      to_status TEXT NOT NULL CHECK (to_status IN ('fulfilled','cancelled','still_open','reopened')),
      source TEXT NOT NULL CHECK (source IN ('model','user')),
      evidence_at_ms INTEGER NULL, note TEXT NULL, run_id TEXT NULL, model TEXT NULL,
      orphaned_at_ms INTEGER NULL, created_at_ms INTEGER NOT NULL
    )`);
    raw
      .prepare(`INSERT INTO brain_lifecycle_events (claim_id, to_status, source, note, created_at_ms) VALUES (?, 'cancelled', 'user', ?, ?)`)
      .run("claim-x", "moot", Date.now());
    raw.close();
    // Opening the repository runs migrateLifecycleDismissed.
    const repository = new SqliteArchiveRepository(dbPath);
    try {
      const db = (repository as unknown as { db: Database.Database }).db;
      const rows = db.prepare(`SELECT to_status AS s, note AS n FROM brain_lifecycle_events`).all() as Array<{ s: string; n: string }>;
      expect(rows, "the audited transition survives, remapped").toEqual([{ s: "dismissed", n: "moot" }]);
      const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brain_lifecycle_events'`).get() as { sql: string }).sql;
      expect(ddl).toContain("'dismissed'");
      expect(ddl).not.toContain("'cancelled'");
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("lifecycle sweep: explicit item selection", () => {
  it("sweeps exactly the selected claims, overriding the sweep-due heuristic", async () => {
    await withRepos(async (repository, kind) => {
      // Two plain messages (no replies/reactions), distinct entities, future
      // due → NO candidate evidence, so neither node is sweep-due.
      await seedChat(
        repository,
        CHAT,
        [
          message("P1", CHAT, { timestampMs: BASE, senderSourceJid: RIYA, body: "Riya will handle the invites." }),
          message("P2", CHAT, { timestampMs: BASE + 60_000, senderSourceJid: ARJUN, body: "Arjun will book the hall." })
        ],
        [
          { sourceJid: RIYA, displayName: "Riya" },
          { sourceJid: ARJUN, displayName: "Arjun" }
        ]
      );
      const episode = await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 120_000 }, [
          {
            kind: "commitment",
            text: "Pick me.",
            citations: [messageKey(CHAT, "P1")],
            validUntilMs: NOW + 30 * DAY_MS,
            confidence: "stated",
            entities: [{ kind: "person", name: "Riya", jid: RIYA }]
          },
          {
            kind: "commitment",
            text: "Not me.",
            citations: [messageKey(CHAT, "P2")],
            validUntilMs: NOW + 30 * DAY_MS,
            confidence: "stated",
            entities: [{ kind: "person", name: "Arjun", jid: ARJUN }]
          }
        ])
      );
      const target = episode.claims[0]!.id;
      expect((await repository.listBrainLifecycleSweepBatches()).length, `${kind}: nothing is sweep-due`).toBe(0);
      // Explicit selection overrides the skip: exactly the chosen claim is offered.
      const batches = await repository.listBrainLifecycleSweepBatches({ claimIds: [target] });
      const offered = batches.flatMap((batch) => batch.nodes);
      expect(offered.map((node) => node.claimId), kind).toEqual([target]);
      expect(offered[0]!.text, kind).toBe("Pick me.");
    });
  });
});

describe("lifecycle transitions: validation and projection", () => {
  it("applies a model closure with postdating cites, projects payload + resolves edge, and survives rebuild", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [
        { sourceJid: RIYA, displayName: "Riya" },
        { sourceJid: ARJUN, displayName: "Arjun" }
      ]);
      const { claimId, keys } = await commitPromiseEpisode(repository);
      await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
      const batches = await repository.listBrainLifecycleSweepBatches();
      const node = batches[0]!.nodes.find((entry) => entry.claimId === claimId)!;
      const reaction = node.candidates.find((candidate) => candidate.kind === "reaction")!;
      const result = await repository.applyBrainLifecycleTransitions(
        [{ claimId, toStatus: "fulfilled", cites: [reaction.sourceMessageKey], note: "Acknowledged by reaction." }],
        { source: "model", model: "test-model", allowedCitesByClaim: new Map([[claimId, node.candidates]]) }
      );
      expect(result.applied, kind).toBe(1);
      expect(result.events[0]!.cites[0]!.actorJid, `${kind}: the reactor is the resolving actor`).toBe(ARJUN);

      const list = await repository.listBrainLifecycleItems({ status: "all" });
      const item = list.items.find((entry) => entry.claimId === claimId)!;
      expect(item.status, kind).toBe("fulfilled");
      expect(item.resolution?.source, kind).toBe("model");
      expect(item.resolution?.note, kind).toBe("Acknowledged by reaction.");
      expect(item.resolution?.cites[0]?.senderLabel, kind).toBe("Arjun");
      expect(list.counts.open, kind).toBe(0);
      expect(list.counts.fulfilled, kind).toBe(1);

      let stats = await repository.getBrainGraphStats();
      expect(stats.edgesByKind.resolves ?? 0, `${kind}: resolves edge projected`).toBe(1);
      expect(stats.openLifecycleNodes, kind).toBe(0);

      // Rebuild wipes graph tables; the durable events re-project the closure.
      await repository.rebuildBrainGraph();
      stats = await repository.getBrainGraphStats();
      expect(stats.edgesByKind.resolves ?? 0, `${kind}: resolves edge re-derived by rebuild`).toBe(1);
      const rebuilt = (await repository.listBrainLifecycleItems({ status: "all" })).items.find((entry) => entry.claimId === claimId)!;
      expect(rebuilt.status, `${kind}: closure survives rebuild`).toBe("fulfilled");
    });
  });

  it("rejects backdated, non-offered, and precondition-violating transitions with everything collected", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { claimId, keys } = await commitPromiseEpisode(repository);
      // Backdated: a candidate whose timestamp does NOT postdate the anchor.
      const backdated = [
        { kind: "reply" as const, sourceMessageKey: keys.m2, timestampMs: BASE - DAY_MS, senderJid: ARJUN, senderLabel: "Arjun", text: "old", claimId: null }
      ];
      await expect(
        repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled", cites: [keys.m2] }], {
          source: "model",
          allowedCitesByClaim: new Map([[claimId, backdated]])
        })
      ).rejects.toThrow(/postdate/);
      // Non-offered cite (closed world).
      await expect(
        repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled", cites: [keys.m2] }], {
          source: "model",
          allowedCitesByClaim: new Map([[claimId, []]])
        })
      ).rejects.toThrow(/not offered|at least one/);
      // Citeless model terminal.
      await expect(
        repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled", cites: [] }], { source: "model", allowedCitesByClaim: new Map() })
      ).rejects.toThrow(/at least one/);
      // Model reopen is forbidden; user reopen on an OPEN node is a precondition error.
      await expect(
        repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "reopened" }], { source: "model" })
      ).rejects.toThrow(/may not reopen/);
      await expect(repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "reopened" }], { source: "user" })).rejects.toThrow(
        /only a closed item/
      );
      // Unknown claim.
      await expect(
        repository.applyBrainLifecycleTransitions([{ claimId: "nope", toStatus: "fulfilled" }], { source: "user" })
      ).rejects.toThrow(/no open commitment/);
      // Nothing applied by any of the rejects.
      expect((await repository.listBrainLifecycleItems()).items[0]!.status, kind).toBe("open");
    });
  });

  it("user close needs no citation; reopen restores open semantics and removes the resolves projection; double-close is refused", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { claimId } = await commitPromiseEpisode(repository);
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "dismissed", note: "Moot — plan changed." }], { source: "user" });
      let item = (await repository.listBrainLifecycleItems({ status: "all" })).items.find((entry) => entry.claimId === claimId)!;
      expect(item.status, kind).toBe("dismissed");
      expect(item.resolution?.source, kind).toBe("user");
      // Closing a closed item is a precondition violation.
      await expect(repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled" }], { source: "user" })).rejects.toThrow(
        /already dismissed/
      );
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "reopened" }], { source: "user" });
      item = (await repository.listBrainLifecycleItems({ status: "all" })).items.find((entry) => entry.claimId === claimId)!;
      expect(item.status, kind).toBe("open");
      expect((await repository.getBrainGraphStats()).edgesByKind.resolves ?? 0, kind).toBe(0);
      expect((await repository.getBrainGraphStats()).openLifecycleNodes, kind).toBe(1);
    });
  });

  it("closed nodes lose the dormancy exemption and decay; open ones survive recompute", async () => {
    await withRepos(async (repository, kind) => {
      process.env.WAPP_BRAIN_SALIENCE_DORMANT = "10"; // everything decays…
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { claimId } = await commitPromiseEpisode(repository);
      await repository.recomputeBrainGraphSalience();
      let item = (await repository.listBrainLifecycleItems({ status: "all" })).items.find((entry) => entry.claimId === claimId)!;
      expect(item.dormant, `${kind}: open lifecycle node is dormancy-exempt`).toBe(false);
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "dismissed" }], { source: "user" });
      await repository.recomputeBrainGraphSalience();
      item = (await repository.listBrainLifecycleItems({ status: "all" })).items.find((entry) => entry.claimId === claimId)!;
      expect(item.dormant, `${kind}: closed node decays like an ordinary node`).toBe(true);
      // Status-driven surface: the closed item is still listed (dormancy hides ranked surfaces, not this one).
      expect(item.status, kind).toBe("dismissed");
    });
  });

  it("flags overdue and stale distinctly on the open surface", async () => {
    await withRepos(async (repository, kind) => {
      process.env.WAPP_BRAIN_LIFECYCLE_STALE_DAYS = "5";
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      // Due date already passed; opened long ago; no evidence since BASE+ (all
      // evidence is ~10 days old, past the 5-day stale window).
      const { claimId } = await commitPromiseEpisode(repository);
      const list = await repository.listBrainLifecycleItems();
      const item = list.items.find((entry) => entry.claimId === claimId)!;
      expect(item.overdue, `${kind}: due ${new Date(item.dueMs ?? 0).toISOString()} passed`).toBe(true);
      expect(item.stale, kind).toBe(true);
      expect(list.counts.overdue, kind).toBe(1);
      expect(list.counts.stale, kind).toBe(1);
      expect(list.asOfMs, kind).toBeGreaterThan(0);
      expect(list.staleDays, kind).toBe(5);
    });
  });
});

describe("lifecycle survives reset and regeneration", () => {
  it("reset wipes lifecycle events with the rest of the derived data", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { claimId } = await commitPromiseEpisode(repository);
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled" }], { source: "user" });
      await repository.resetBrainDerivedData();
      const list = await repository.listBrainLifecycleItems({ status: "all" });
      expect(list.items, kind).toHaveLength(0);
      expect(list.counts.orphanedEvents, kind).toBe(0);
      // Re-committing the same window starts honestly open (the closure was derived state).
      const { claimId: freshClaim } = await commitPromiseEpisode(repository);
      expect((await repository.listBrainLifecycleItems()).items.find((entry) => entry.claimId === freshClaim)!.status, kind).toBe("open");
    });
  });

  it("supersede re-keys events onto the unique citation-sharing replacement claim", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { episode, claimId, keys } = await commitPromiseEpisode(repository);
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled", note: "done" }], { source: "user" });
      // Regeneration recommits the window: same commitment, new claim id.
      const replacement = await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 120_000 }, [commitmentClaim(keys.m1)], {
          advanceWatermark: false,
          supersedesEpisodeId: episode.id
        })
      );
      const newClaimId = replacement.claims[0]!.id;
      expect(newClaimId, kind).not.toBe(claimId);
      const list = await repository.listBrainLifecycleItems({ status: "all" });
      expect(list.items, kind).toHaveLength(1);
      expect(list.items[0]!.claimId, `${kind}: events re-keyed to the replacement claim`).toBe(newClaimId);
      expect(list.items[0]!.status, `${kind}: the closure followed the commitment`).toBe("fulfilled");
      expect(list.counts.orphanedEvents, kind).toBe(0);
    });
  });

  it("orphans events honestly when no unambiguous replacement exists", async () => {
    await withRepos(async (repository, kind) => {
      await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
      const { episode, claimId } = await commitPromiseEpisode(repository);
      await repository.applyBrainLifecycleTransitions([{ claimId, toStatus: "fulfilled" }], { source: "user" });
      // The replacement extracts NO commitment (different citation set).
      await repository.commitBrainEpisode(
        episodeInput(CHAT, { startAtMs: BASE - 60_000, endAtMs: BASE + 120_000 }, [
          { kind: "fact", text: "Documents were discussed.", citations: [messageKey(CHAT, "M2")], confidence: "stated", entities: [] }
        ], { advanceWatermark: false, supersedesEpisodeId: episode.id })
      );
      const list = await repository.listBrainLifecycleItems({ status: "all" });
      expect(list.items, `${kind}: no lifecycle node remains`).toHaveLength(0);
      expect(list.counts.orphanedEvents, `${kind}: the closure is visible debt, not silent loss`).toBe(1);
    });
  });
});

// --- Sweep executor ---------------------------------------------------------
// The provider is mocked at the module boundary; everything below it (batches,
// prompt, validation, writer, ledger, run records) is real.

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

async function waitForRun(): Promise<import("../src/shared/types").BrainRunProgress> {
  const { getBrainRunProgress } = await import("../src/server/brain/runJob");
  for (let i = 0; i < 200 && getBrainRunProgress().state === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getBrainRunProgress();
}

describe("closure sweep executor", () => {
  it("closes a reaction-acknowledged promise end-to-end and records the ledger under 'lifecycle'", async () => {
    const provider = await import("../src/server/brain/provider");
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, CHAT, seedMessages(), [
      { sourceJid: RIYA, displayName: "Riya" },
      { sourceJid: ARJUN, displayName: "Arjun" }
    ]);
    const { claimId, keys } = await commitPromiseEpisode(repository);
    await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
    vi.mocked(provider.generateStructured).mockResolvedValueOnce({
      json: { resolutions: [{ node: "n1", status: "fulfilled", cites: ["e1"], note: "Thumbs-up ack." }] },
      usage: { inputTokens: 100, outputTokens: 50 }
    });
    const { startBrainLifecycleSweep } = await import("../src/server/brain/runJob");
    const started = startBrainLifecycleSweep(repository, {});
    expect(started.started).toBe(true);
    const final = await waitForRun();
    expect(final.state).toBe("completed");
    expect(final.kind).toBe("lifecycle");
    expect(final.lifecycle).toMatchObject({ nodesOffered: 1, fulfilled: 1, dismissed: 0, stillOpen: 0, failedCalls: 0 });
    // The item folded closed with the reaction's message cited.
    const item = (await repository.listBrainLifecycleItems({ status: "all" })).items.find((entry) => entry.claimId === claimId)!;
    expect(item.status).toBe("fulfilled");
    expect(item.resolution?.note).toBe("Thumbs-up ack.");
    // Ledger row under the lifecycle purpose; run record kind lifecycle.
    const usage = await repository.getBrainLlmUsage({ day: new Date().toISOString().slice(0, 10) });
    expect(usage.calls).toBe(1);
    const run = await repository.getBrainRun(final.runId!);
    expect(run?.kind).toBe("lifecycle");
    expect(run?.status).toBe("completed");
    expect(run?.totals?.fulfilled).toBe(1);
  });

  it("retries once with enumerated errors, then leaves nodes open with a visible validation issue (no fallback)", async () => {
    const provider = await import("../src/server/brain/provider");
    const repository = new MemoryArchiveRepository();
    await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
    const { claimId, keys } = await commitPromiseEpisode(repository);
    await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
    const generate = vi.mocked(provider.generateStructured);
    generate.mockReset();
    generate
      .mockResolvedValueOnce({ json: { resolutions: [{ node: "n1", status: "fulfilled", cites: ["e99"] }] }, usage: { inputTokens: 10, outputTokens: 5 } })
      .mockResolvedValueOnce({ json: { resolutions: [{ node: "zzz", status: "fulfilled", cites: ["e1"] }] }, usage: { inputTokens: 10, outputTokens: 5 } });
    const { startBrainLifecycleSweep } = await import("../src/server/brain/runJob");
    startBrainLifecycleSweep(repository, {});
    const final = await waitForRun();
    expect(final.state).toBe("completed");
    expect(final.lifecycle?.failedCalls).toBe(1);
    // The retry message enumerated the first call's errors.
    const retryPrompt = generate.mock.calls[1]![0].user;
    expect(retryPrompt).toMatch(/previous response had these problems/);
    expect(retryPrompt).toMatch(/unknown evidence alias/);
    // Nodes stay open and sweep-due; the failure is a recorded issue.
    const item = (await repository.listBrainLifecycleItems()).items.find((entry) => entry.claimId === claimId)!;
    expect(item.status).toBe("open");
    const issues = await repository.listBrainValidationIssues();
    expect(issues.some((issue) => issue.code === "lifecycle_sweep_invalid" && issue.severity === "error")).toBe(true);
  });

  it("records still_open reviews for offered-but-unresolved nodes and stops at named budgets", async () => {
    const provider = await import("../src/server/brain/provider");
    const repository = new MemoryArchiveRepository();
    const secondChat = "second@g.us";
    await seedChat(repository, CHAT, seedMessages(), [{ sourceJid: RIYA, displayName: "Riya" }]);
    await seedChat(repository, secondChat, [
      message("S1", secondChat, { timestampMs: BASE, senderSourceJid: ARJUN, body: "I'll book the venue." })
    ]);
    const { keys, claimId } = await commitPromiseEpisode(repository);
    await addReaction(repository, keys.m1, BASE + 2 * DAY_MS);
    await repository.commitBrainEpisode(
      episodeInput(secondChat, { startAtMs: BASE - 60_000, endAtMs: BASE + 60_000 }, [
        {
          kind: "commitment",
          text: "Arjun will book the venue.",
          citations: [messageKey(secondChat, "S1")],
          validUntilMs: BASE + DAY_MS,
          confidence: "stated",
          entities: [{ kind: "person", name: "Arjun", jid: ARJUN }]
        }
      ])
    );
    const generate = vi.mocked(provider.generateStructured);
    generate.mockReset();
    // First batch answered with still_open only; the second batch never runs
    // (call ceiling = 1).
    generate.mockResolvedValue({ json: { resolutions: [{ node: "n1", status: "still_open", cites: [] }] }, usage: { inputTokens: 10, outputTokens: 5 } });
    const { startBrainLifecycleSweep } = await import("../src/server/brain/runJob");
    startBrainLifecycleSweep(repository, { maxModelCalls: 1 });
    const final = await waitForRun();
    expect(final.state).toBe("budget_exceeded");
    expect(generate).toHaveBeenCalledTimes(1);
    const run = await repository.getBrainRun(final.runId!);
    expect(run?.status).toBe("budget_exceeded");
    expect(run?.errorMessage).toMatch(/Model-call ceiling/);
    // The offered node got its review stamp; the never-offered one did not.
    const items = (await repository.listBrainLifecycleItems()).items;
    const reviewedCount = items.filter((entry) => entry.lastReviewedAtMs != null).length;
    expect(reviewedCount).toBe(1);
    expect(items.every((entry) => entry.status === "open")).toBe(true);
    void claimId;
  });
});
