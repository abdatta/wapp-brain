import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";

const DAY_MS = 86_400_000;

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

async function withSqlite(prefix: string, run: (repository: SqliteArchiveRepository) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    await run(repository);
  } finally {
    await repository.close?.();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedBasics(repository: ArchiveRepository): Promise<string> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertChats(runId, [
    { sourceChatId: "plans@g.us", jid: "plans@g.us", displayName: "Plans", chatType: "group" }
  ]);
  await repository.upsertContacts(runId, [
    { sourceJid: "15550004444@s.whatsapp.net", displayName: "Kiran Rao", phoneNumber: "+15550004444" }
  ]);
  return runId;
}

describe("retrieval hardening — relaxation ladder", () => {
  it("recovers a typo'd multi-word query as a labelled partial match with honest totals", async () => {
    await withSqlite("wapp-rh-typo-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("T1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "dinner plan is set for saturday" }),
        message("T2", "plans@g.us", { timestampMs: Date.now() - 2 * DAY_MS, body: "no dinner for me tonight" })
      ]);
      const response = await repository.searchMessages({ query: "dinner tomorow plan", limit: 10, offset: 0 });
      expect(response.matchTier).toBe("partial");
      expect(response.relaxation?.droppedTerms).toEqual(["tomorow"]);
      expect(response.relaxation?.totalTerms).toBe(3);
      expect(response.results.map((hit) => hit.sourceMessageId)).toEqual(["T1"]);
      // The count describes the tier that produced the results.
      expect(response.totalMatches).toBe(1);
      // Per-row coverage is reported on partial tiers.
      expect(response.results[0].termCoverage).toEqual({ matched: 2, total: 3 });
    });
  });

  it("loosens word endings at the prefix tier before dropping any term", async () => {
    await withSqlite("wapp-rh-prefix-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("P1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "the rental agreement arrived yesterday evening" })
      ]);
      // "agree" is a non-final token, so the strict tier does not star it; the
      // prefix tier does and recovers the hit with every term still required.
      const response = await repository.searchMessages({ query: "agree yesterday evening", limit: 10, offset: 0 });
      expect(response.matchTier).toBe("relaxed");
      expect(response.relaxation?.tier).toBe(1);
      expect(response.relaxation?.droppedTerms).toEqual([]);
      expect(response.results.map((hit) => hit.sourceMessageId)).toEqual(["P1"]);
    });
  });

  it("never relaxes a query whose strict form has results", async () => {
    await withSqlite("wapp-rh-strict-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("S1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "the venue is booked" }),
        message("S2", "plans@g.us", { timestampMs: Date.now() - 2 * DAY_MS, body: "venue deposit paid yesterday" })
      ]);
      const response = await repository.searchMessages({ query: "venue booked", limit: 10, offset: 0 });
      expect(response.matchTier).toBe("exact");
      expect(response.relaxation ?? null).toBeNull();
      expect(response.results.map((hit) => hit.sourceMessageId)).toEqual(["S1"]);
      expect(response.totalMatches).toBe(1);
      expect(response.results[0].termCoverage).toBeUndefined();
    });
  });

  it("ranks higher term coverage first on the ranked-OR tier, above rare-term score spikes", async () => {
    await withSqlite("wapp-rh-or-coverage-", async (repository) => {
      await seedBasics(repository);
      const now = Date.now() - DAY_MS;
      await repository.upsertMessages([
        // "framboise" is archive-rare (huge BM25 when matched); the two-term
        // row must still outrank it on the OR tier.
        message("RARE", "plans@g.us", { timestampMs: now, body: "framboise" }),
        message("BOTH", "plans@g.us", { timestampMs: now, body: "citrus and pomelo tasting tonight" }),
        ...Array.from({ length: 6 }, (_, index) =>
          message(`C${index}`, "plans@g.us", { timestampMs: now, body: `citrus note number ${index}` })
        ),
        ...Array.from({ length: 6 }, (_, index) =>
          message(`P${index}`, "plans@g.us", { timestampMs: now, body: `pomelo note number ${index}` })
        )
      ]);
      // No row carries all three terms (or any two of them except BOTH), so
      // the ladder falls through to the ranked OR.
      const response = await repository.searchMessages({ query: "citrus pomelo framboise", limit: 10, offset: 0 });
      expect(response.matchTier).toBe("partial");
      expect(response.relaxation?.tier).toBe(4);
      expect(response.results[0].sourceMessageId).toBe("BOTH");
      expect(response.results[0].termCoverage).toEqual({ matched: 2, total: 3 });
    });
  });

  it("keeps zero-hit single-token queries empty instead of inventing matches", async () => {
    await withSqlite("wapp-rh-single-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("Z1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "nothing relevant here" })
      ]);
      const response = await repository.searchMessages({ query: "zzyzxq", limit: 10, offset: 0 });
      expect(response.results).toHaveLength(0);
      expect(response.totalMatches).toBe(0);
      expect(response.matchTier).toBe("exact");
    });
  });
});

describe("retrieval hardening — term aliases", () => {
  it("finds romanized-Hindi variants through the seeded alias table at the exact tier", async () => {
    await withSqlite("wapp-rh-alias-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("H1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "kal nahi aa raha hu" }),
        message("H2", "plans@g.us", { timestampMs: Date.now() - 2 * DAY_MS, body: "kal aa raha hu pakka" })
      ]);
      const single = await repository.searchMessages({ query: "nhi", limit: 10, offset: 0 });
      expect(single.matchTier).toBe("exact");
      expect(single.results.map((hit) => hit.sourceMessageId)).toEqual(["H1"]);
      // The code-mixed golden-set shape: a fully typed query with one
      // transliteration variant still lands on the right message, strictly.
      const phrase = await repository.searchMessages({ query: "kal nhi aa raha", limit: 10, offset: 0 });
      expect(phrase.matchTier).toBe("exact");
      expect(phrase.results.map((hit) => hit.sourceMessageId)).toEqual(["H1"]);
    });
  });

  it("expands aliases persisted later by any producer, with no model call", async () => {
    await withSqlite("wapp-rh-alias-add-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("A1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "the dinner reservation is confirmed" })
      ]);
      const before = await repository.searchMessages({ query: "dinnr", limit: 10, offset: 0 });
      expect(before.results).toHaveLength(0);
      const added = await repository.addTermAliases([{ term: "dinner", variant: "dinnr", source: "model" }]);
      expect(added).toBe(1);
      const after = await repository.searchMessages({ query: "dinnr", limit: 10, offset: 0 });
      expect(after.matchTier).toBe("exact");
      expect(after.results.map((hit) => hit.sourceMessageId)).toEqual(["A1"]);
      // Idempotent: re-adding the same pair changes nothing.
      expect(await repository.addTermAliases([{ term: "dinner", variant: "dinnr" }])).toBe(0);
    });
  });
});

describe("retrieval hardening — dual candidate pool", () => {
  it("guarantees a recent average-relevance match survives a common-term flood", async () => {
    await withSqlite("wapp-rh-pool-", async (repository) => {
      await seedBasics(repository);
      const old = Date.now() - 400 * DAY_MS;
      // 260 old, short, high-BM25 rows monopolize the relevance pool (240);
      // the recent hit is long (diluted term frequency) so it ranks below all
      // of them on relevance alone.
      await repository.upsertMessages(
        Array.from({ length: 260 }, (_, index) =>
          message(`F${index}`, "plans@g.us", {
            timestampMs: old + index * 1000,
            body: "meeting meeting meeting"
          })
        )
      );
      await repository.upsertMessages([
        message("RECENT", "plans@g.us", {
          timestampMs: Date.now() - 60_000,
          body: "quick note that the meeting moved to the cafe next to the office by the station entrance after lunch today"
        })
      ]);
      const response = await repository.searchMessages({ query: "meeting", limit: 50, offset: 0 });
      expect(response.totalMatches).toBe(261);
      expect(response.results.map((hit) => hit.sourceMessageId)).toContain("RECENT");
    });
  });
});

describe("retrieval hardening — sender split and mention boost", () => {
  it("marks sender-only hits and ranks them below content hits", async () => {
    await withSqlite("wapp-rh-sender-", async (repository) => {
      await seedBasics(repository);
      const now = Date.now() - DAY_MS;
      await repository.upsertMessages([
        message("BY", "plans@g.us", {
          senderSourceJid: "15550004444@s.whatsapp.net",
          timestampMs: now,
          body: "totally unrelated words in this one"
        }),
        message("ABOUT", "plans@g.us", {
          timestampMs: now,
          body: "met kiran rao at the office today"
        })
      ]);
      const response = await repository.searchMessages({ query: "kiran", limit: 10, offset: 0 });
      const ids = response.results.map((hit) => hit.sourceMessageId);
      expect(ids).toEqual(["ABOUT", "BY"]);
      const senderHit = response.results.find((hit) => hit.sourceMessageId === "BY");
      const contentHit = response.results.find((hit) => hit.sourceMessageId === "ABOUT");
      expect(senderHit?.senderOnlyMatch).toBe(true);
      expect(contentHit?.senderOnlyMatch).toBeUndefined();
    });
  });

  it("boosts authoritative structured mentions over text-token fallbacks", async () => {
    await withSqlite("wapp-rh-mentions-", async (repository) => {
      await seedBasics(repository);
      const now = Date.now() - DAY_MS;
      await repository.upsertMessages([
        // Identical bodies: one carries the transport's structured mention
        // (source_mask bit 2), the other only the @digits text fallback.
        message("PLAIN", "plans@g.us", { timestampMs: now, body: "ping @15550004444 about the trip" }),
        message("STRUCTURED", "plans@g.us", {
          timestampMs: now,
          body: "ping @15550004444 about the trip",
          mentionedJids: ["15550004444@s.whatsapp.net"]
        })
      ]);
      const response = await repository.searchMessages({ query: "kiran trip", limit: 10, offset: 0 });
      expect(response.results.map((hit) => hit.sourceMessageId)).toEqual(["STRUCTURED", "PLAIN"]);
      expect(response.results[0].score).toBeGreaterThan(response.results[1].score);
    });
  });
});

describe("retrieval hardening — contextual text indexing", () => {
  it("indexes orphaned quoted snapshots, skips live in-chat quotes, and converges when originals arrive", async () => {
    await withSqlite("wapp-rh-quotes-", async (repository) => {
      await seedBasics(repository);
      const now = Date.now() - DAY_MS;
      await repository.upsertMessages([
        // Original present in-chat + a reply quoting it: the snapshot text
        // must NOT double-hit the search.
        message("O2", "plans@g.us", { timestampMs: now - 3_600_000, body: "original text bravo lives here" }),
        message("R2", "plans@g.us", {
          timestampMs: now,
          body: "replying to that one",
          quotedSourceMessageId: "O2",
          quotedSnapshot: {
            quotedSourceMessageId: "O2",
            quotedSourceChatId: null,
            quotedSenderSourceJid: null,
            quotedFromMe: null,
            timestampMs: now - 3_600_000,
            messageType: "text",
            rawTypeCode: null,
            body: "original text bravo lives here",
            caption: null
          }
        }),
        // Cross-chat Reply-Privately shape: the quoted original is absent.
        message("R1", "plans@g.us", {
          timestampMs: now,
          body: "sure, will do",
          quotedSourceMessageId: "GONE1",
          quotedSnapshot: {
            quotedSourceMessageId: "GONE1",
            quotedSourceChatId: "elsewhere@s.whatsapp.net",
            quotedSenderSourceJid: null,
            quotedFromMe: null,
            timestampMs: now - 7_200_000,
            messageType: "text",
            rawTypeCode: null,
            body: "secret quoted phrase alpha zulu",
            caption: null
          }
        })
      ]);

      const inChat = await repository.searchMessages({ query: "bravo lives", limit: 10, offset: 0 });
      expect(inChat.results.map((hit) => hit.sourceMessageId)).toEqual(["O2"]);

      const orphan = await repository.searchMessages({ query: "quoted phrase alpha", limit: 10, offset: 0 });
      expect(orphan.matchTier).toBe("exact");
      expect(orphan.results.map((hit) => hit.sourceMessageId)).toEqual(["R1"]);

      // The original arrives later (cross-chat): the reply's snapshot copy
      // converges away and the original becomes the match.
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertChats(runId, [
        { sourceChatId: "elsewhere@s.whatsapp.net", jid: "elsewhere@s.whatsapp.net", displayName: "Elsewhere", chatType: "dm" }
      ]);
      await repository.upsertMessages([
        message("GONE1", "elsewhere@s.whatsapp.net", {
          timestampMs: now - 7_200_000,
          body: "secret quoted phrase alpha zulu"
        })
      ]);
      const converged = await repository.searchMessages({ query: "quoted phrase alpha", limit: 10, offset: 0 });
      expect(converged.results.map((hit) => hit.sourceMessageId)).toEqual(["GONE1"]);
    });
  });

  it("makes link-preview text searchable", async () => {
    await withSqlite("wapp-rh-previews-", async (repository) => {
      await seedBasics(repository);
      await repository.upsertMessages([
        message("L1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "check this https://example.com/a" })
      ]);
      await repository.recordLinkPreviews([
        {
          chatSourceId: "plans@g.us",
          sourceMessageId: "L1",
          title: "Quarterly housing report",
          description: "Rents and vacancy trends for the metro area",
          canonicalUrl: "https://example.com/a",
          thumbnail: null
        }
      ]);
      const byTitle = await repository.searchMessages({ query: "quarterly housing", limit: 10, offset: 0 });
      expect(byTitle.matchTier).toBe("exact");
      expect(byTitle.results.map((hit) => hit.sourceMessageId)).toEqual(["L1"]);
      const byDescription = await repository.searchMessages({ query: "vacancy trends", limit: 10, offset: 0 });
      expect(byDescription.results.map((hit) => hit.sourceMessageId)).toEqual(["L1"]);
    });
  });
});

describe("retrieval hardening — rename-triggered recompute", () => {
  it("repairs derived search text when a genuine name changes, and skips restated names", async () => {
    await withSqlite("wapp-rh-rename-", async (repository) => {
      const runId = await seedBasics(repository);
      await repository.upsertContacts(runId, [
        { sourceJid: "15550007777@s.whatsapp.net", displayName: "Asha Patel", phoneNumber: "+15550007777" }
      ]);
      await repository.upsertMessages([
        message("N1", "plans@g.us", {
          senderSourceJid: "15550007777@s.whatsapp.net",
          timestampMs: Date.now() - 10 * DAY_MS,
          body: "booked the tickets already"
        })
      ]);
      const byOldName = await repository.searchMessages({ query: "asha tickets", limit: 10, offset: 0 });
      expect(byOldName.matchTier).toBe("exact");
      expect(byOldName.results.map((hit) => hit.sourceMessageId)).toEqual(["N1"]);

      // Genuine rename (name → different name): old messages become
      // searchable by the NEW name with no model call.
      await repository.upsertContacts(runId, [
        { sourceJid: "15550007777@s.whatsapp.net", displayName: "Bhavna Patel", phoneNumber: "+15550007777" }
      ]);
      const byNewName = await repository.searchMessages({ query: "bhavna tickets", limit: 10, offset: 0 });
      expect(byNewName.matchTier).toBe("exact");
      expect(byNewName.results.map((hit) => hit.sourceMessageId)).toEqual(["N1"]);
      // The old name no longer matches strictly (it survives only via the
      // relaxation ladder, labelled partial).
      const oldAfterRename = await repository.searchMessages({ query: "asha tickets", limit: 10, offset: 0 });
      expect(oldAfterRename.matchTier).not.toBe("exact");

      // Restating the same name is a no-op: no repair work runs.
      const repairSpy = vi.spyOn(repository, "repairIdentityResolution");
      await repository.upsertContacts(runId, [
        { sourceJid: "15550007777@s.whatsapp.net", displayName: "Bhavna Patel", phoneNumber: "+15550007777" }
      ]);
      expect(repairSpy).not.toHaveBeenCalled();
      repairSpy.mockRestore();
    });
  });
});

describe("retrieval hardening — in-memory mirror parity", () => {
  it("mirrors the ladder, aliases, sender marking, and rename repair", async () => {
    const repository = new MemoryArchiveRepository();
    const runId = await seedBasics(repository);
    await repository.upsertMessages([
      message("M1", "plans@g.us", { timestampMs: Date.now() - DAY_MS, body: "dinner plan is set for saturday" }),
      message("M2", "plans@g.us", { timestampMs: Date.now() - 2 * DAY_MS, body: "kal nahi aa raha hu" }),
      message("M3", "plans@g.us", {
        senderSourceJid: "15550004444@s.whatsapp.net",
        timestampMs: Date.now() - DAY_MS,
        body: "totally unrelated words in this one"
      })
    ]);

    const typo = await repository.searchMessages({ query: "dinner tomorow plan", limit: 10, offset: 0 });
    expect(typo.matchTier).toBe("partial");
    expect(typo.relaxation?.droppedTerms).toEqual(["tomorow"]);
    expect(typo.results.map((hit) => hit.sourceMessageId)).toEqual(["M1"]);

    const alias = await repository.searchMessages({ query: "nhi", limit: 10, offset: 0 });
    expect(alias.matchTier).toBe("exact");
    expect(alias.results.map((hit) => hit.sourceMessageId)).toEqual(["M2"]);

    const sender = await repository.searchMessages({ query: "kiran", limit: 10, offset: 0 });
    expect(sender.results.map((hit) => hit.sourceMessageId)).toEqual(["M3"]);
    expect(sender.results[0].senderOnlyMatch).toBe(true);

    // Rename parity: new name finds old messages, restated names change nothing.
    await repository.upsertContacts(runId, [
      { sourceJid: "15550004444@s.whatsapp.net", displayName: "Kiran Mehta", phoneNumber: "+15550004444" }
    ]);
    const renamed = await repository.searchMessages({ query: "mehta", limit: 10, offset: 0 });
    expect(renamed.results.map((hit) => hit.sourceMessageId)).toEqual(["M3"]);

    const added = await repository.addTermAliases([{ term: "dinner", variant: "dinnr" }]);
    expect(added).toBe(1);
    const learned = await repository.searchMessages({ query: "dinnr", limit: 10, offset: 0 });
    expect(learned.results.map((hit) => hit.sourceMessageId)).toEqual(["M1"]);
  });
});
