// Brain read performance (brain-status-poll-cost): the two properties that make
// the poll-path/dashboard split safe to keep.
//
// 1. The lifecycle chips are computed set-based — the sweep_due count no longer
//    materializes closure candidates for every open node — and per-item
//    candidate counts are hydrated only for the returned page. Both are only
//    legitimate if the numbers are UNCHANGED, so the tests here re-derive every
//    chip from the full item list and compare, across every filter, sort and
//    limit, on BOTH repositories.
// 2. The status endpoint carries only what the shell renders. That is asserted
//    structurally (the payload's own shape) rather than by latency alone, so it
//    fails deterministically on any machine the day someone re-attaches a
//    full-population aggregate to the hot poll.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type {
  BrainClaimInput,
  BrainEpisodeInput,
  BrainLifecycleListResponse,
  BrainLifecycleSort,
  MessageRecord
} from "../src/shared/types";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const BASE = NOW - 120 * DAY_MS;
const CHAT = "perf-lifecycle@g.us";
// The control nodes live ALONE in their own chats. Producer (c) offers "a later
// model claim in the same chat sharing an entity" as a closure candidate, so a
// node sharing a busy chat with its siblings is sweep-due no matter what — a
// fixture built entirely in one chat cannot exercise the negative case at all.
const DM_UNDATED = "1777@s.whatsapp.net";
const DM_FUTURE = "1888@s.whatsapp.net";
const DM_OVERDUE = "1999@s.whatsapp.net";
const RIYA = "1555@s.whatsapp.net";
const ARJUN = "1666@s.whatsapp.net";

type RepoKind = "sqlite" | "memory";

async function withRepos(test: (repository: ArchiveRepository, kind: RepoKind) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-read-perf-"));
  const sqlite = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await test(sqlite, "sqlite");
  } finally {
    await sqlite.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
  await test(new MemoryArchiveRepository(), "memory");
}

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

function claim(text: string, citeKey: string, dueMs: number | null): BrainClaimInput {
  return {
    kind: "commitment",
    text,
    citations: [citeKey],
    validUntilMs: dueMs,
    confidence: "stated",
    entities: [{ kind: "person", name: "Riya", jid: RIYA }]
  };
}

function episode(chatSourceId: string, startAtMs: number, endAtMs: number, claims: BrainClaimInput[], overrides: Partial<BrainEpisodeInput> = {}): BrainEpisodeInput {
  return {
    chatSourceId,
    startAtMs,
    endAtMs,
    messageCount: claims.length,
    participants: ["Riya"],
    summary: "Read-performance fixture episode.",
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

// A fixture that lands a node in every state the chips distinguish, so a wrong
// derivation of any one of them shows up as a count mismatch:
//   undated   own chat, no due date, no candidates → NOT sweep-due (the control)
//   future    own chat, due in the future          → NOT sweep-due, not overdue
//   overdue   own chat, due in the past            → sweep-due with NO candidate
//   reaction  group chat, undated, postdating 👍   → sweep-due via a candidate
//   reply     group chat, undated, quoting reply   → sweep-due via a candidate
//   stale     group chat, evidence 120 days old    → stale
//   fulfilled/dismissed                            → the closed views
// Both sweep-due routes are represented, and so is an open node that is neither
// — the case that fails if the existence pass is skipped for a node the
// due-date arithmetic did not already settle.
const CHAT_BY_NAME: Record<string, string> = {
  undated: DM_UNDATED,
  future: DM_FUTURE,
  overdue: DM_OVERDUE,
  reaction: CHAT,
  reply: CHAT,
  stale: CHAT,
  fulfilled: CHAT,
  dismissed: CHAT
};

async function seedLifecycleFixture(repository: ArchiveRepository): Promise<{ claimIds: Record<string, string> }> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [
    { sourceJid: RIYA, displayName: "Riya" },
    { sourceJid: ARJUN, displayName: "Arjun" }
  ]);
  await repository.upsertChats(runId, [
    { sourceChatId: CHAT, jid: CHAT, displayName: "Visa crew", chatType: "group" },
    { sourceChatId: DM_UNDATED, jid: DM_UNDATED, displayName: "Solo undated", chatType: "dm" },
    { sourceChatId: DM_FUTURE, jid: DM_FUTURE, displayName: "Solo future", chatType: "dm" },
    { sourceChatId: DM_OVERDUE, jid: DM_OVERDUE, displayName: "Solo overdue", chatType: "dm" }
  ]);

  const anchors = ["undated", "future", "overdue", "reaction", "reply", "stale", "fulfilled", "dismissed"];
  const messages: MessageRecord[] = anchors.map((name, index) =>
    message(`M-${name}`, CHAT_BY_NAME[name]!, { timestampMs: name === "stale" ? BASE : NOW - 20 * DAY_MS + index * 60_000 })
  );
  // The reply that quotes the `reply` commitment — a postdating candidate.
  messages.push(
    message("R-reply", CHAT, {
      timestampMs: NOW - 2 * DAY_MS,
      senderSourceJid: ARJUN,
      body: "Done — sent it just now.",
      quotedSourceMessageId: "M-reply",
      quotedSnapshot: {
        quotedSourceMessageId: "M-reply",
        quotedSourceChatId: null,
        quotedSenderSourceJid: RIYA,
        quotedFromMe: null,
        timestampMs: NOW - 20 * DAY_MS,
        messageType: "text",
        body: "body of M-reply",
        caption: null,
        mentionedJids: []
      }
    })
  );
  await repository.upsertMessages(messages);

  // One episode per claim keeps each node's anchor independent.
  const claimIds: Record<string, string> = {};
  const dueByName: Record<string, number | null> = {
    undated: null,
    future: NOW + 30 * DAY_MS,
    overdue: NOW - 5 * DAY_MS,
    reaction: null,
    reply: null,
    stale: null,
    fulfilled: null,
    dismissed: null
  };
  for (const name of anchors) {
    const chatSourceId = CHAT_BY_NAME[name]!;
    const key = messageKey(chatSourceId, `M-${name}`);
    const at = name === "stale" ? BASE : NOW - 20 * DAY_MS;
    const committed = await repository.commitBrainEpisode(
      episode(chatSourceId, at - 60_000, at + 60_000, [claim(`Riya will handle ${name}.`, key, dueByName[name]!)])
    );
    claimIds[name] = committed.claims[0]!.id;
  }

  // A postdating reaction on the `reaction` commitment's cited message.
  const applied = await repository.applyLiveMessageUpdates([
    {
      eventKey: "react-perf",
      chatSourceId: CHAT,
      sourceMessageKey: messageKey(CHAT, "M-reaction"),
      updateType: "reaction",
      occurredAtMs: NOW - DAY_MS,
      metadata: { emoji: "👍", reactorJid: ARJUN }
    }
  ]);
  expect(applied.applied).toBe(1);

  await repository.applyBrainLifecycleTransitions(
    [{ claimId: claimIds.fulfilled!, toStatus: "fulfilled", cites: [messageKey(CHAT, "R-reply")] }],
    { source: "user" }
  );
  await repository.applyBrainLifecycleTransitions([{ claimId: claimIds.dismissed!, toStatus: "dismissed" }], { source: "user" });
  return { claimIds };
}

// The chips, re-derived from the items themselves. `duePassedSinceReview` is
// reconstructed from fields the DTO already carries, so this is the per-item
// fold the set-based counts have to reproduce exactly.
function countsFromItems(response: BrainLifecycleListResponse) {
  const counts = { open: 0, overdue: 0, stale: 0, fulfilled: 0, dismissed: 0, sweepDue: 0 };
  for (const item of response.items) {
    if (item.status === "open") {
      counts.open += 1;
      if (item.overdue) counts.overdue += 1;
      if (item.stale) counts.stale += 1;
      const duePassedSinceReview =
        item.dueMs != null && item.dueMs < response.asOfMs && (item.lastReviewedAtMs == null || item.lastReviewedAtMs < item.dueMs);
      if (item.candidateCount > 0 || duePassedSinceReview) counts.sweepDue += 1;
    } else if (item.status === "fulfilled") {
      counts.fulfilled += 1;
    } else {
      counts.dismissed += 1;
    }
  }
  return counts;
}

describe("lifecycle chips stay exact while the work stops being full-population", () => {
  it("every chip matches the per-item fold, and the fixture exercises each path", async () => {
    await withRepos(async (repository, kind) => {
      const { claimIds } = await seedLifecycleFixture(repository);
      // status=all with a limit above the population: every row is returned, so
      // every candidateCount is hydrated and the reference is complete.
      const all = await repository.listBrainLifecycleItems({ status: "all", limit: 500 });
      expect(all.items.length, kind).toBe(8);
      expect(countsFromItems(all), kind).toEqual({
        open: all.counts.open,
        overdue: all.counts.overdue,
        stale: all.counts.stale,
        fulfilled: all.counts.fulfilled,
        dismissed: all.counts.dismissed,
        sweepDue: all.counts.sweepDue
      });

      // The fixture really does cover the paths the counts are derived from —
      // otherwise this test could pass on a fixture where every node is alike.
      const byClaim = new Map(all.items.map((item) => [item.claimId, item]));
      const undated = byClaim.get(claimIds.undated!)!;
      const future = byClaim.get(claimIds.future!)!;
      const overdue = byClaim.get(claimIds.overdue!)!;
      const reaction = byClaim.get(claimIds.reaction!)!;
      const reply = byClaim.get(claimIds.reply!)!;
      // Neither route fires: no candidate and no due date. If the existence
      // pass were skipped or inverted, this row would be miscounted.
      expect([undated.candidateCount, undated.overdue, undated.dueMs], `${kind}: undated open is the not-sweep-due control`).toEqual([0, false, null]);
      expect([future.candidateCount, future.overdue], `${kind}: a future due date is not sweep-due`).toEqual([0, false]);
      // The due-date route ALONE.
      expect(overdue.overdue, `${kind}: overdue`).toBe(true);
      expect(overdue.candidateCount, `${kind}: overdue is sweep-due WITHOUT a candidate`).toBe(0);
      // The candidate route ALONE (undated, so the due-date test cannot settle them).
      expect(reaction.candidateCount, `${kind}: reaction is a candidate`).toBeGreaterThan(0);
      expect(reaction.dueMs, `${kind}: reaction is sweep-due by candidate ALONE`).toBeNull();
      expect(reply.candidateCount, `${kind}: quoting reply is a candidate`).toBeGreaterThan(0);
      expect(reply.dueMs, `${kind}: reply is sweep-due by candidate ALONE`).toBeNull();
      expect(byClaim.get(claimIds.stale!)!.stale, `${kind}: stale`).toBe(true);
      expect(all.counts.open, kind).toBe(6);
      expect(all.counts.fulfilled, kind).toBe(1);
      expect(all.counts.dismissed, kind).toBe(1);
      // Both routes contribute, and two open rows take neither.
      expect(all.counts.sweepDue, `${kind}: sweep-due covers both routes and excludes neither-route rows`).toBe(4);
    });
  });

  it("counts are full-population under every filter, sort and limit", async () => {
    await withRepos(async (repository, kind) => {
      await seedLifecycleFixture(repository);
      const reference = (await repository.listBrainLifecycleItems({ status: "all", limit: 500 })).counts;
      const sorts: BrainLifecycleSort[] = ["smart", "due_asc", "due_desc", "opened_asc", "opened_desc", "evidence_desc", "recent_activity"];
      // `kind` and `chatSourceId` are SCOPE (they choose the population the
      // chips describe); everything below only narrows the shown list, so the
      // chips must not move.
      const cases: Array<Parameters<ArchiveRepository["listBrainLifecycleItems"]>[0]> = [
        {},
        { limit: 1 },
        { limit: 500 },
        { status: "all" },
        { status: "all", limit: 1 },
        { status: "fulfilled" },
        { status: "dismissed" },
        { status: "closed" },
        { flag: "overdue" },
        { flag: "stale" },
        { flag: "sweep_due" },
        { hideOverdue: true },
        { hideStale: true },
        { status: "all", hideFulfilled: true },
        { status: "all", hideDismissed: true },
        { dueUpcoming: true },
        { includeChats: [CHAT] },
        { excludeChats: [CHAT] },
        ...sorts.map((sort) => ({ sort })),
        ...sorts.map((sort) => ({ sort, limit: 1 }))
      ];
      for (const options of cases) {
        const response = await repository.listBrainLifecycleItems(options);
        expect(response.counts, `${kind}: ${JSON.stringify(options)}`).toEqual(reference);
      }
      // Scope filters DO move the chips — and must move them to the truth for
      // that scope, not to a stale full-population number.
      const commitments = await repository.listBrainLifecycleItems({ kind: "commitment", status: "all", limit: 500 });
      expect(commitments.counts, `${kind}: every fixture node is a commitment`).toEqual(reference);
      const questions = await repository.listBrainLifecycleItems({ kind: "question", status: "all", limit: 500 });
      expect(questions.counts, `${kind}: no questions in the fixture`).toEqual({ ...reference, open: 0, overdue: 0, stale: 0, fulfilled: 0, dismissed: 0, sweepDue: 0 });
      const scopedToChat = await repository.listBrainLifecycleItems({ chatSourceId: DM_OVERDUE, status: "all", limit: 500 });
      expect(scopedToChat.counts, `${kind}: a one-node chat reports its own truth`).toEqual({
        ...reference,
        open: 1,
        overdue: 1,
        stale: 0,
        fulfilled: 0,
        dismissed: 0,
        sweepDue: 1
      });
    });
  });

  it("the sweep_due view returns exactly the items the chip counted", async () => {
    await withRepos(async (repository, kind) => {
      await seedLifecycleFixture(repository);
      const all = await repository.listBrainLifecycleItems({ status: "all", limit: 500 });
      const expected = new Set(
        all.items
          .filter((item) => {
            if (item.status !== "open") return false;
            const duePassed =
              item.dueMs != null && item.dueMs < all.asOfMs && (item.lastReviewedAtMs == null || item.lastReviewedAtMs < item.dueMs);
            return item.candidateCount > 0 || duePassed;
          })
          .map((item) => item.claimId)
      );
      const view = await repository.listBrainLifecycleItems({ flag: "sweep_due", limit: 500 });
      expect(new Set(view.items.map((item) => item.claimId)), kind).toEqual(expected);
      expect(view.items.length, `${kind}: the view and its chip agree`).toBe(all.counts.sweepDue);
    });
  });

  // The claim that lets candidate hydration be scoped to a page at all: a
  // claim's candidate count must not depend on which other claims it was
  // queried alongside.
  it("a returned item's candidate count is the same whether one row or all are asked for", async () => {
    await withRepos(async (repository, kind) => {
      await seedLifecycleFixture(repository);
      const all = await repository.listBrainLifecycleItems({ status: "all", limit: 500 });
      for (const sort of ["smart", "due_asc", "opened_asc", "evidence_desc"] as BrainLifecycleSort[]) {
        const wide = await repository.listBrainLifecycleItems({ status: "all", limit: 500, sort });
        const narrow = await repository.listBrainLifecycleItems({ status: "all", limit: 1, sort });
        expect(narrow.items.length, `${kind}: ${sort}`).toBe(1);
        const first = narrow.items[0]!;
        const same = wide.items.find((item) => item.claimId === first.claimId)!;
        expect(first.claimId, `${kind}: ${sort} picks the same first row`).toBe(wide.items[0]!.claimId);
        expect(first.candidateCount, `${kind}: ${sort} candidate count is scope-invariant`).toBe(same.candidateCount);
        // Deferred hydration must still produce the text and resolution the
        // whole-population pass produced.
        expect(first.text, `${kind}: ${sort} text is hydrated for the page`).toBe(same.text);
        expect(first.text.length, `${kind}: ${sort} text is real, not a fallback stub`).toBeGreaterThan(0);
        expect(first.resolution?.cites ?? null, `${kind}: ${sort} resolution cites hydrated`).toEqual(same.resolution?.cites ?? null);
      }
      expect(all.items.every((item) => item.text.startsWith("Riya will handle")), kind).toBe(true);
    });
  });

  it("a closed item keeps its resolution and cites through deferred hydration", async () => {
    await withRepos(async (repository, kind) => {
      const { claimIds } = await seedLifecycleFixture(repository);
      const fulfilled = (await repository.listBrainLifecycleItems({ status: "fulfilled", limit: 500 })).items;
      expect(fulfilled.length, kind).toBe(1);
      expect(fulfilled[0]!.claimId, kind).toBe(claimIds.fulfilled);
      expect(fulfilled[0]!.resolution?.status, kind).toBe("fulfilled");
      expect(fulfilled[0]!.resolution?.cites.length, `${kind}: the resolving event's cites survive`).toBe(1);
    });
  });
});

describe("the status poll carries only what the shell renders", () => {
  // Structural, so it fails identically on a fast machine and a slow one: these
  // aggregates are full-population reads and belong on /api/brain/quality.
  const DASHBOARD_ONLY = ["regenerableEpisodes", "validationIssues", "mediaGaps", "resolutionDebt", "modelQuality", "extractionVersion"] as const;

  it("BrainStatusSummary carries no dashboard aggregate", async () => {
    await withRepos(async (repository, kind) => {
      await seedLifecycleFixture(repository);
      const status = (await repository.getBrainStatus()) as unknown as Record<string, unknown>;
      for (const field of DASHBOARD_ONLY) {
        expect(field in status, `${kind}: ${field} must not ride the poll path`).toBe(false);
      }
      // What the shell DOES render is still there.
      for (const field of ["coveragePercent", "chatsWithBacklog", "backlogSample", "tasks", "usageToday", "latestRun", "activeRun"]) {
        expect(field in status, `${kind}: ${field} is what the shell polls for`).toBe(true);
      }
    });
  });

  it("the quality aggregates answer, and answer separately", async () => {
    await withRepos(async (repository, kind) => {
      await seedLifecycleFixture(repository);
      // Each is reachable on its own — that is what lets the brain page fetch
      // them off the poll and shimmer them independently.
      expect(await repository.countRegenerableBrainEpisodes(99), kind).toBe(0);
      expect(await repository.getBrainValidationIssueSummary(), kind).toEqual({ error: 0, warning: 0, info: 0 });
      expect(Array.isArray(await repository.getBrainMediaGapSummary()), kind).toBe(true);
      expect((await repository.getBrainResolutionDebt({ limit: 8 })).episodesWithUnresolved, kind).toBe(0);
      expect((await repository.getBrainModelQualityAggregates()).some((row) => row.model === "test-model"), kind).toBe(true);
    });
  });
});

// --- Scale guards -----------------------------------------------------------

const SCALE_CHAT = "scale@g.us";
const SCALE_NODES = 250;

// Enough population that per-population work is visibly different from per-page
// work. Deliberately smaller than the real archive (327k messages): the guard
// exists to catch a REGRESSION in shape — an aggregate re-attached to the poll,
// or hydration escaping back to the whole population — and shape shows up at
// this size without making the suite take minutes.
async function seedScaleArchive(repository: ArchiveRepository): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertChats(runId, [{ sourceChatId: SCALE_CHAT, jid: SCALE_CHAT, displayName: "Scale", chatType: "group" }]);
  const messages: MessageRecord[] = [];
  for (let index = 0; index < SCALE_NODES; index += 1) {
    messages.push(message(`S-${index}`, SCALE_CHAT, { timestampMs: NOW - (SCALE_NODES - index) * 60_000 }));
  }
  await repository.upsertMessages(messages);
  for (let index = 0; index < SCALE_NODES; index += 1) {
    const at = NOW - (SCALE_NODES - index) * 60_000;
    await repository.commitBrainEpisode(
      episode(SCALE_CHAT, at - 1000, at + 1000, [
        claim(`Riya will handle item ${index}.`, messageKey(SCALE_CHAT, `S-${index}`), index % 3 === 0 ? NOW - DAY_MS : null)
      ])
    );
  }
}

// Counts rows materialized by every SQLite statement while `fn` runs. Wall clock
// on a loaded developer machine is far too noisy to assert on; the number of
// rows a query pulls back is deterministic, and it is the thing that actually
// grew.
async function rowsMaterialized(fn: () => Promise<unknown>): Promise<number> {
  const prototype = Database.prototype as unknown as { prepare: (sql: string) => unknown };
  const originalPrepare = prototype.prepare;
  let rows = 0;
  prototype.prepare = function patched(this: unknown, sql: string) {
    const statement = originalPrepare.call(this, sql) as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["all", "get"] as const) {
      const original = statement[method];
      if (typeof original !== "function") continue;
      statement[method] = (...args: unknown[]) => {
        const out = original.apply(statement, args);
        rows += Array.isArray(out) ? out.length : out == null ? 0 : 1;
        return out;
      };
    }
    return statement;
  };
  try {
    await fn();
  } finally {
    prototype.prepare = originalPrepare;
  }
  return rows;
}

describe("read cost scales with the page, not the population", () => {
  it("a one-row request materializes far fewer rows than a full page", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-read-scale-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedScaleArchive(repository);
      const one = await rowsMaterialized(() => repository.listBrainLifecycleItems({ limit: 1 }));
      const page = await rowsMaterialized(() => repository.listBrainLifecycleItems({ limit: SCALE_NODES }));
      // Per-row hydration (claim texts, candidate lists, resolution cites) is
      // paid for the returned rows only. Measured on this fixture: before the
      // change both requests materialized the IDENTICAL 1,506 rows — the limit
      // was free — and after, 1,642 against 2,182.
      expect(page, `page=${page} one=${one}`).toBeGreaterThan(one + SCALE_NODES / 2);
      // Both still report the same full-population chips.
      const oneResponse = await repository.listBrainLifecycleItems({ limit: 1 });
      const pageResponse = await repository.listBrainLifecycleItems({ limit: SCALE_NODES });
      expect(oneResponse.counts).toEqual(pageResponse.counts);
      expect(oneResponse.counts.open).toBe(SCALE_NODES);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // The budget the shell's poll must stay inside. Generous on purpose: it has to
  // fail on a shape regression (an uncached full-population aggregate back on
  // the poll path costs multiples of this) without failing on machine variance.
  const POLL_BUDGET_MS = 2_000;

  it("the polled status answers within its budget at scale", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-read-budget-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    const seeder = new SqliteArchiveRepository(dbPath);
    await seedScaleArchive(seeder);
    await seeder.close?.();
    // A SECOND repository over the same file starts with an empty TTL cache, so
    // this times the uncached path — the one a regression would land on. Timing
    // a cache hit would pass no matter what was re-attached to the poll.
    const repository = new SqliteArchiveRepository(dbPath);
    try {
      const started = performance.now();
      const status = await repository.getBrainStatus();
      const elapsed = performance.now() - started;
      expect(status.totalVisibleMessages).toBe(SCALE_NODES);
      expect(elapsed, `getBrainStatus took ${Math.round(elapsed)}ms (budget ${POLL_BUDGET_MS}ms)`).toBeLessThan(POLL_BUDGET_MS);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
