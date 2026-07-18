import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";
import { SEARCH_HIGHLIGHT_START } from "../src/shared/types";

const DAY_MS = 86_400_000;

async function seedArchive(
  repository: ArchiveRepository,
  options: { canaryBody?: string } = {}
): Promise<void> {
  const runId = await repository.startImportRun({ test: true });
  await repository.upsertContacts(runId, [
    { sourceJid: "15550001111@s.whatsapp.net", displayName: "Riya Sharma", phoneNumber: "+15550001111" },
    { sourceJid: "15550002222@s.whatsapp.net", displayName: "Sam Iyer", phoneNumber: "+15550002222" }
  ]);
  await repository.upsertChats(runId, [
    { sourceChatId: "15550001111@s.whatsapp.net", jid: "15550001111@s.whatsapp.net", displayName: "Riya Sharma", chatType: "dm" },
    { sourceChatId: "flat@g.us", jid: "flat@g.us", displayName: "Flat Hunt", chatType: "group" }
  ]);
  await repository.upsertMessages([
    message("A1", "15550001111@s.whatsapp.net", {
      senderSourceJid: "15550001111@s.whatsapp.net",
      timestampMs: Date.now() - 30 * DAY_MS,
      body: "Found a great apartment near the park in Lisbon"
    }),
    message("A2", "flat@g.us", {
      senderSourceJid: "15550002222@s.whatsapp.net",
      timestampMs: Date.now() - 2 * DAY_MS,
      body: "hey @15550001111 did you see the rent numbers?",
      mentionedJids: ["15550001111@s.whatsapp.net"]
    }),
    message("A3", "flat@g.us", {
      senderSourceJid: "15550002222@s.whatsapp.net",
      timestampMs: Date.now() - DAY_MS,
      body: options.canaryBody ?? "the deposit is due friday"
    }),
    message("A4", "flat@g.us", {
      senderSourceJid: null,
      timestampMs: Date.now() - DAY_MS,
      direction: "system",
      messageType: "system",
      body: "apartment group settings changed"
    })
  ]);
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

describe("archive full-text search", () => {
  it("finds messages across chats with ranked snippets the moment they are ingested", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedArchive(repository);
      const { index, totalMatches, results } = await repository.searchMessages({ query: "apartment lisbon", limit: 10, offset: 0 });
      expect(index.state).toBe("ready");
      expect(totalMatches).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].sourceMessageId).toBe("A1");
      expect(results[0].chatDisplayName).toBe("Riya Sharma");
      expect(results[0].snippet).toContain(SEARCH_HIGHLIGHT_START);

      const prefix = await repository.searchMessages({ query: "apartm", limit: 10, offset: 0 });
      expect(prefix.results.some((hit) => hit.sourceMessageId === "A1")).toBe(true);

      // The exact count spans the whole archive even when paging trims results.
      const paged = await repository.searchMessages({ query: "the", limit: 1, offset: 0 });
      expect(paged.results.length).toBeLessThanOrEqual(1);
      expect(paged.totalMatches).toBeGreaterThanOrEqual(paged.results.length);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("indexes resolved identity text so person-name queries match mentions and senders", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-resolved-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedArchive(repository);
      const { results } = await repository.searchMessages({ query: "riya", limit: 10, offset: 0 });
      const ids = results.map((hit) => hit.sourceMessageId).sort();
      // A1 is sent by Riya (sender label), A2 mentions @<digits> that resolve
      // to Riya; both must match a name that appears in neither raw body.
      expect(ids).toEqual(["A1", "A2"]);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports sender, date, type, and direction filters and hides noise by default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-filters-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedArchive(repository);
      const bySender = await repository.searchMessages({ query: "rent", sender: "Sam", limit: 10, offset: 0 });
      expect(bySender.results).toHaveLength(1);
      expect(bySender.results[0].senderDisplayName).toBe("Sam Iyer");

      const byJid = await repository.searchMessages({
        query: "rent",
        sender: "15550002222@s.whatsapp.net",
        limit: 10,
        offset: 0
      });
      expect(byJid.results).toHaveLength(1);

      const wrongWindow = await repository.searchMessages({
        query: "apartment",
        afterMs: Date.now() - 7 * DAY_MS,
        limit: 10,
        offset: 0
      });
      expect(wrongWindow.results.every((hit) => hit.sourceMessageId !== "A1")).toBe(true);

      const outgoingOnly = await repository.searchMessages({ query: "rent", direction: "outgoing", limit: 10, offset: 0 });
      expect(outgoingOnly.results).toHaveLength(0);

      // System rows are indexed but excluded from conversation-only results.
      const noiseDefault = await repository.searchMessages({ query: "settings changed", limit: 10, offset: 0 });
      expect(noiseDefault.results).toHaveLength(0);
      const withNoise = await repository.searchMessages({ query: "settings changed", includeNoise: true, limit: 10, offset: 0 });
      expect(withNoise.results).toHaveLength(1);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the index in step with edits, tombstones, and row removals", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-updates-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedArchive(repository);
      // Live edit rewrites the body: new text matches, old text does not.
      await repository.applyLiveMessageUpdates([
        {
          eventKey: "edit-1",
          chatSourceId: "flat@g.us",
          sourceMessageKey: messageKey("flat@g.us", "A3"),
          updateType: "edit",
          occurredAtMs: Date.now(),
          metadata: { body: "the deposit is due saturday" }
        }
      ]);
      const newText = await repository.searchMessages({ query: "saturday", limit: 10, offset: 0 });
      expect(newText.results.map((hit) => hit.sourceMessageId)).toContain("A3");
      const oldText = await repository.searchMessages({ query: "friday", limit: 10, offset: 0 });
      expect(oldText.results).toHaveLength(0);

      // Tombstoned messages keep held content searchable.
      await repository.applyLiveMessageUpdates([
        {
          eventKey: "del-1",
          chatSourceId: "flat@g.us",
          sourceMessageKey: messageKey("flat@g.us", "A3"),
          updateType: "delete",
          occurredAtMs: Date.now(),
          metadata: null
        }
      ]);
      const afterDelete = await repository.searchMessages({ query: "saturday", limit: 10, offset: 0 });
      expect(afterDelete.results).toHaveLength(1);
      expect(afterDelete.results[0].isDeleted).toBe(true);

      // A physically removed row drops out of the index entirely.
      await repository.collapseSupersededMessages([
        { chatSourceId: "flat@g.us", staleMessageId: "A3", canonicalMessageId: "A2" }
      ]);
      const afterRemoval = await repository.searchMessages({ query: "saturday", limit: 10, offset: 0 });
      expect(afterRemoval.results).toHaveLength(0);
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-resolves derived text and mentions when identities merge", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-merge-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertChats(runId, [{ sourceChatId: "g@g.us", jid: "g@g.us", displayName: "Group", chatType: "group" }]);
      // A message sent from a LID identity with no contact record yet.
      await repository.upsertMessages([
        message("L1", "g@g.us", {
          senderSourceJid: "99912345678@lid",
          timestampMs: Date.now() - DAY_MS,
          body: "bring the projector tomorrow"
        })
      ]);
      // Pre-merge, the name term resolves to nothing. The relaxation ladder
      // (retrieval-hardening) now recovers the other term instead of returning
      // an empty set — but only labelled as a partial match that dropped the
      // unresolvable name, never as an exact hit.
      const before = await repository.searchMessages({ query: "priya projector", limit: 10, offset: 0 });
      expect(before.matchTier).toBe("partial");
      expect(before.relaxation?.droppedTerms).toContain("priya");

      // The LID collapses onto a phone identity whose contact has a name.
      await repository.upsertContacts(runId, [
        { sourceJid: "15550009999@s.whatsapp.net", displayName: "Priya Nair", phoneNumber: "+15550009999" }
      ]);
      await repository.recordIdentityLinks([{ lid: "99912345678@lid", pn: "15550009999@s.whatsapp.net" }]);
      await repository.mergeIdentity("99912345678@lid", "15550009999@s.whatsapp.net");

      const after = await repository.searchMessages({ query: "priya projector", limit: 10, offset: 0 });
      expect(after.results.map((hit) => hit.sourceMessageId)).toContain("L1");
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records canonical message mentions and repoints them on merge", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-mentions-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    const repository = new SqliteArchiveRepository(dbPath);
    try {
      await seedArchive(repository);
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(`SELECT mentioned_jid FROM message_mentions ORDER BY mentioned_jid`).all() as Array<{
        mentioned_jid: string;
      }>;
      db.close();
      expect(rows.map((row) => row.mentioned_jid)).toContain("15550001111@s.whatsapp.net");
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses search on a pre-index archive, survives writes before rebuild, then rebuilds", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-rebuild-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    let repository = new SqliteArchiveRepository(dbPath);
    try {
      await seedArchive(repository);
      await repository.close?.();

      // Simulate the real migration shape: an archive written before the
      // search feature existed — no index, no triggers, no stamp, and no
      // derived resolved_text on any row.
      const db = new Database(dbPath);
      db.exec(`DROP TRIGGER IF EXISTS messages_fts_ai; DROP TRIGGER IF EXISTS messages_fts_ad; DROP TRIGGER IF EXISTS messages_fts_au;`);
      db.exec(`DROP TABLE IF EXISTS messages_fts`);
      db.exec(`UPDATE messages SET resolved_text = NULL`);
      db.prepare(`DELETE FROM schema_meta WHERE key = 'fts_state'`).run();
      db.close();

      repository = new SqliteArchiveRepository(dbPath);
      const status = await repository.getSearchIndexStatus();
      expect(status.state).toBe("needs_rebuild");
      await expect(repository.searchMessages({ query: "apartment", limit: 10, offset: 0 })).rejects.toThrow(/search index/i);

      // Live writes against unindexed history must never corrupt the index —
      // this is the exact failure the external-content design produced on a
      // real archive ("database disk image is malformed").
      await repository.applyLiveMessageUpdates([
        {
          eventKey: "pre-rebuild-edit",
          chatSourceId: "flat@g.us",
          sourceMessageKey: messageKey("flat@g.us", "A3"),
          updateType: "edit",
          occurredAtMs: Date.now(),
          metadata: { body: "the deposit is due sunday" }
        }
      ]);

      const progressCalls: Array<[number, number]> = [];
      const rebuilt = await repository.rebuildSearchIndex((processed, total) => progressCalls.push([processed, total]));
      expect(rebuilt.indexedMessages).toBeGreaterThan(0);
      // Progress reports the total immediately, before the first chunk lands.
      expect(progressCalls[0][0]).toBe(0);
      expect(progressCalls[0][1]).toBe(rebuilt.indexedMessages);

      const after = await repository.searchMessages({ query: "apartment", limit: 10, offset: 0 });
      expect(after.index.state).toBe("ready");
      expect(after.results.map((hit) => hit.sourceMessageId)).toContain("A1");
      // The pre-rebuild edit is indexed with its final content.
      const edited = await repository.searchMessages({ query: "sunday", limit: 10, offset: 0 });
      expect(edited.results.map((hit) => hit.sourceMessageId)).toContain("A3");
      // FTS internal consistency after the whole sequence.
      const check = new Database(dbPath);
      try {
        expect(() => check.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)`)).not.toThrow();
      } finally {
        check.close();
      }
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates a legacy external-content index to the rowid-keyed design", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-legacy-fts-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    let repository = new SqliteArchiveRepository(dbPath);
    try {
      await seedArchive(repository);
      await repository.close?.();

      // Recreate the retired external-content table shape (as shipped in the
      // first Phase 1 build) with a stale 'ready' stamp.
      const db = new Database(dbPath);
      db.exec(`DROP TRIGGER IF EXISTS messages_fts_ai; DROP TRIGGER IF EXISTS messages_fts_ad; DROP TRIGGER IF EXISTS messages_fts_au;`);
      db.exec(`DROP TABLE IF EXISTS messages_fts`);
      db.exec(
        `CREATE VIRTUAL TABLE messages_fts USING fts5(resolved_text, body, caption, content='messages', content_rowid='id')`
      );
      db.close();

      // Reopening migrates: drops the legacy table, recreates the
      // content-storing one, and forces an honest needs_rebuild stamp.
      repository = new SqliteArchiveRepository(dbPath);
      const status = await repository.getSearchIndexStatus();
      expect(status.state).toBe("needs_rebuild");
      await repository.rebuildSearchIndex();
      const after = await repository.searchMessages({ query: "apartment", limit: 10, offset: 0 });
      expect(after.results.map((hit) => hit.sourceMessageId)).toContain("A1");
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns anchor-centered context windows for deep links", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-context-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const runId = await repository.startImportRun({ test: true });
      await repository.upsertChats(runId, [{ sourceChatId: "long@g.us", jid: "long@g.us", displayName: "Long", chatType: "group" }]);
      const base = Date.now() - 100 * 60_000;
      await repository.upsertMessages(
        Array.from({ length: 40 }, (_, index) =>
          message(`M${index}`, "long@g.us", {
            senderSourceJid: "15550002222@s.whatsapp.net",
            timestampMs: base + index * 60_000,
            body: index === 20 ? "the anchor message about the venue" : `filler message number ${index}`
          })
        )
      );
      const hit = await repository.searchMessages({ query: "anchor venue", limit: 5, offset: 0 });
      expect(hit.results).toHaveLength(1);
      const window = await repository.listMessagesAround(hit.results[0].chatId, hit.results[0].messageId, 5);
      expect(window).not.toBeNull();
      expect(window!.messages).toHaveLength(11);
      expect(window!.messages.map((item) => item.sourceMessageId)).toContain("M20");
      // 40 messages: window covers M15..M25, so 14 newer remain beyond it.
      expect(window!.newerCount).toBe(14);
      expect(window!.anchorMessageId).toBe(hit.results[0].messageId);
      // Unknown anchors resolve to null, never a mispositioned window.
      expect(await repository.listMessagesAround(hit.results[0].chatId, 999_999, 5)).toBeNull();
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mirrors search behavior in the in-memory repository", async () => {
    const repository = new MemoryArchiveRepository();
    await seedArchive(repository);
    const { index, results } = await repository.searchMessages({ query: "apartment", limit: 10, offset: 0 });
    expect(index.state).toBe("ready");
    expect(results.map((hit) => hit.sourceMessageId)).toContain("A1");
    const byName = await repository.searchMessages({ query: "riya", limit: 10, offset: 0 });
    expect(byName.results.length).toBeGreaterThan(0);
    const window = await repository.listMessagesAround(results[0].chatId, results[0].messageId, 3);
    expect(window?.messages.some((item) => item.id === results[0].messageId)).toBe(true);
  });

  it("keeps message bodies out of search status and reindex diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-search-privacy-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      await seedArchive(repository, { canaryBody: "FAKE_SECRET_DO_NOT_LOG canary body" });
      const status = JSON.stringify(await repository.getSearchIndexStatus());
      expect(status).not.toContain("FAKE_SECRET_DO_NOT_LOG");
      const progressPayloads: string[] = [];
      await repository.rebuildSearchIndex((processed, total) => progressPayloads.push(JSON.stringify({ processed, total })));
      expect(progressPayloads.join("")).not.toContain("FAKE_SECRET_DO_NOT_LOG");
    } finally {
      await repository.close?.();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
