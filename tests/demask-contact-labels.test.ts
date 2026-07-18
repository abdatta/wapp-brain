import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRecord, MessageRecord } from "../src/shared/types";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import {
  displayPhoneFromJid,
  formatE164,
  isMaskedNumberLabel,
  resolveDisplayLabel
} from "../src/server/import/jid";

const PN = "919051167186@s.whatsapp.net";
const LID = "244543240839423@lid";
const GROUP = "12036000000000@g.us";
const MASK = "+91∙∙∙∙∙∙∙∙86";

// 1.2 — the shared predicate is the choke point for every demask decision.
describe("isMaskedNumberLabel", () => {
  it("recognizes WhatsApp masked-number placeholders across glyph and spacing variants", () => {
    expect(isMaskedNumberLabel("+91∙∙∙∙∙∙∙∙86")).toBe(true); // U+2219 bullet operator
    expect(isMaskedNumberLabel("+1∙∙∙∙∙∙∙∙12")).toBe(true);
    expect(isMaskedNumberLabel("+91 ∙∙∙∙∙∙ 86")).toBe(true); // spaced
    expect(isMaskedNumberLabel("91••••••86")).toBe(true); // U+2022 bullet
    expect(isMaskedNumberLabel("91······86")).toBe(true); // U+00B7 middle dot
  });

  it("never flags a real name, even one containing digits or a dot", () => {
    expect(isMaskedNumberLabel("Asha")).toBe(false);
    expect(isMaskedNumberLabel("John 3.16")).toBe(false);
    expect(isMaskedNumberLabel("Room 4.5")).toBe(false);
    expect(isMaskedNumberLabel("Dr. Rao")).toBe(false);
  });

  it("never flags a full or partial real number (no mask glyph)", () => {
    expect(isMaskedNumberLabel("+919051167186")).toBe(false);
    expect(isMaskedNumberLabel("9051167186")).toBe(false);
    expect(isMaskedNumberLabel("+91 90511 67186")).toBe(false);
  });

  it("is null/empty safe", () => {
    expect(isMaskedNumberLabel(null)).toBe(false);
    expect(isMaskedNumberLabel(undefined)).toBe(false);
    expect(isMaskedNumberLabel("")).toBe(false);
    expect(isMaskedNumberLabel("   ")).toBe(false);
  });
});

describe("phone display formatting", () => {
  it("formats stored digits as +E.164, stripping separators", () => {
    expect(formatE164("919051167186")).toBe("+919051167186");
    expect(formatE164("+91 90511-67186")).toBe("+919051167186");
    expect(formatE164("")).toBeNull();
    expect(formatE164(null)).toBeNull();
  });

  it("derives +E.164 from a phone-form JID but not from a LID", () => {
    expect(displayPhoneFromJid(PN)).toBe("+919051167186");
    expect(displayPhoneFromJid("919051167186:12@s.whatsapp.net")).toBe("+919051167186");
    expect(displayPhoneFromJid(LID)).toBeNull();
    expect(displayPhoneFromJid(GROUP)).toBeNull();
  });
});

// 5.3 (unit) — the display chain in one place: name → push → +E.164 (number or JID).
describe("resolveDisplayLabel", () => {
  it("prefers a real name and ignores a masked name in either slot", () => {
    expect(resolveDisplayLabel({ displayName: "Asha" })).toBe("Asha");
    expect(resolveDisplayLabel({ displayName: MASK, phoneNumber: "919051167186" })).toBe("+919051167186");
    expect(resolveDisplayLabel({ pushName: MASK, jid: PN })).toBe("+919051167186");
  });

  it("falls through to +E.164 from the stored number, then the phone-form JID", () => {
    expect(resolveDisplayLabel({ phoneNumber: "919051167186" })).toBe("+919051167186"); // number present
    expect(resolveDisplayLabel({ jid: PN })).toBe("+919051167186"); // JID only
  });

  it("reads an unmapped LID as unresolved (null), never a fabricated number", () => {
    expect(resolveDisplayLabel({ displayName: MASK, jid: LID })).toBeNull();
    expect(resolveDisplayLabel({ jid: LID })).toBeNull();
  });
});

describe("demask-contact-labels · SQLite adapter", () => {
  async function withRepo<T>(fn: (repo: SqliteArchiveRepository, dbPath: string) => Promise<T>): Promise<T> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-demask-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    let repo: SqliteArchiveRepository | null = null;
    try {
      repo = new SqliteArchiveRepository(dbPath);
      return await fn(repo, dbPath);
    } finally {
      await repo?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  // 5.1 + 5.2 — a masked value never enters the archive as a name, and resolution
  // yields the full formatted number instead.
  it("stores a masked incoming display name as null and resolves to +E.164", async () => {
    await withRepo(async (repo, dbPath) => {
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(PN), displayName: MASK }]);
      await repo.upsertContacts(runId, [{ sourceJid: PN, displayName: MASK, pushName: null, phoneNumber: "919051167186" }]);
      await repo.upsertMessages([makeMessage(PN, "m1", 1000)]);

      const chats = await repo.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const dm = chats.find((chat) => chat.sourceChatId === PN);
      expect(dm?.displayName).toBe("+919051167186"); // never the mask

      const messages = await repo.listMessages(dm!.id, { limit: 10, offset: 0 });
      expect(messages[0]?.senderDisplayName).toBe("+919051167186");

      // The masked string is not persisted in either table.
      await repo.close();
      const raw = new Database(dbPath, { readonly: true });
      const contact = raw.prepare(`SELECT display_name, phone_number FROM contacts WHERE source_jid = ?`).get(PN) as {
        display_name: string | null;
        phone_number: string | null;
      };
      const chat = raw.prepare(`SELECT display_name FROM chats WHERE source_chat_id = ?`).get(PN) as {
        display_name: string | null;
      };
      raw.close();
      expect(contact.display_name).toBeNull();
      expect(contact.phone_number).toBe("919051167186"); // raw number untouched
      expect(chat.display_name).toBeNull();
    });
  });

  // 5.3 — the JID-only case: a phone-form sender with no contact row still renders
  // its full formatted number.
  it("renders a nameless phone-form sender with no contact row as +E.164", async () => {
    await withRepo(async (repo) => {
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(GROUP), chatType: "group", displayName: "Group" }]);
      await repo.upsertMessages([
        { ...makeMessage(GROUP, "g1", 2000), senderSourceJid: "15550000002@s.whatsapp.net" }
      ]);

      const chats = await repo.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repo.listMessages(chats[0]!.id, { limit: 10, offset: 0 });
      expect(messages.find((message) => message.sourceMessageId === "g1")?.senderDisplayName).toBe("+15550000002");
    });
  });

  // 5.4 — an unmapped LID whose only label was a mask reads as unresolved and is
  // counted in identity health, never labelled with the mask.
  it("reads a masked-only unmapped LID as unresolved and counts it in identity health", async () => {
    await withRepo(async (repo) => {
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(GROUP), chatType: "group", displayName: "Group" }]);
      await repo.upsertContacts(runId, [{ sourceJid: LID, displayName: MASK, pushName: null, phoneNumber: null }]);
      await repo.upsertMessages([{ ...makeMessage(GROUP, "l1", 3000), senderSourceJid: LID }]);

      const chats = await repo.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repo.listMessages(chats[0]!.id, { limit: 10, offset: 0 });
      expect(messages.find((message) => message.sourceMessageId === "l1")?.senderDisplayName).toBeNull();

      const status = await repo.getLiveStatus();
      expect(status.identityHealth.unresolvedLids).toBeGreaterThanOrEqual(1);
    });
  });

  // 5.5 — the one-time backfill cleans pre-existing masked rows on startup, is
  // idempotent, and never touches numbers or JIDs.
  it("backfills pre-existing masked labels on open, idempotently, preserving numbers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-demask-backfill-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    try {
      // Build a clean archive, then inject masked labels directly (as a pre-fix
      // import would have) so the backfill has something to clean.
      let repo = new SqliteArchiveRepository(dbPath);
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(PN), displayName: null }]);
      await repo.upsertContacts(runId, [{ sourceJid: PN, displayName: null, pushName: null, phoneNumber: "919051167186" }]);
      await repo.upsertMessages([makeMessage(PN, "m1", 1000)]);
      await repo.close();

      const seed = new Database(dbPath);
      seed.prepare(`UPDATE contacts SET display_name = ? WHERE source_jid = ?`).run(MASK, PN);
      seed.prepare(`UPDATE chats SET display_name = ? WHERE source_chat_id = ?`).run(MASK, PN);
      seed.close();

      // Re-open → constructor backfill clears the masked labels.
      repo = new SqliteArchiveRepository(dbPath);
      await repo.close();

      const afterFirst = new Database(dbPath, { readonly: true });
      const contact = afterFirst.prepare(`SELECT display_name, phone_number FROM contacts WHERE source_jid = ?`).get(PN) as {
        display_name: string | null;
        phone_number: string | null;
      };
      const chat = afterFirst.prepare(`SELECT display_name, jid FROM chats WHERE source_chat_id = ?`).get(PN) as {
        display_name: string | null;
        jid: string;
      };
      const maskedRemaining = afterFirst
        .prepare(`SELECT COUNT(*) AS n FROM contacts WHERE display_name = ?`)
        .get(MASK) as { n: number };
      afterFirst.close();

      expect(contact.display_name).toBeNull();
      expect(contact.phone_number).toBe("919051167186"); // number intact
      expect(chat.display_name).toBeNull();
      expect(chat.jid).toBe(PN); // JID intact
      expect(maskedRemaining.n).toBe(0);

      // Idempotent: a second open finds nothing to clear and leaves state intact.
      repo = new SqliteArchiveRepository(dbPath);
      const messages = await repo.listMessages((await repo.listChats({ limit: 10, offset: 0, includeEventOnly: true }))[0]!.id, {
        limit: 10,
        offset: 0
      });
      expect(messages[0]?.senderDisplayName).toBe("+919051167186");
      await repo.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // 7.2 — self-heal: a masked-number label already stored as a display name is
  // treated as no-name by enrichment precedence, so a learned real name (here
  // from Google Contacts) overwrites the mask instead of being shadowed by it.
  // This is the gap that left phone-form contacts nameless when a sync ran
  // while the mask was still present (the mask read as a "strong" saved name).
  it("lets enrichment overwrite a masked display name with a learned real name", async () => {
    await withRepo(async (repo, dbPath) => {
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(PN), displayName: null }]);
      await repo.upsertContacts(runId, [{ sourceJid: PN, displayName: null, pushName: null, phoneNumber: "919051167186" }]);
      await repo.upsertMessages([makeMessage(PN, "m1", 1000)]);

      // Simulate the pre-fix stored state: a masked value sitting in display_name
      // as a "whatsapp_saved" name (the write-path guard nulls incoming masks, so
      // inject directly, as a pre-demask archive would have held it).
      const seed = new Database(dbPath);
      seed
        .prepare(`UPDATE contacts SET display_name = ?, display_name_source = 'whatsapp_saved' WHERE source_jid = ?`)
        .run(MASK, PN);
      seed.close();

      const result = await repo.enrichContactsFromGoogle([{ phoneNumber: "919051167186", displayName: "Asha Verma" }]);
      expect(result.improvedNames).toBe(1);

      // User-visible: the sender label and DM title now read the real name.
      const chats = await repo.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const dm = chats.find((chat) => chat.sourceChatId === PN);
      expect(dm?.displayName).toBe("Asha Verma");
      const messages = await repo.listMessages(dm!.id, { limit: 10, offset: 0 });
      expect(messages[0]?.senderDisplayName).toBe("Asha Verma"); // mask replaced, not shadowed

      const raw = new Database(dbPath, { readonly: true });
      const contact = raw.prepare(`SELECT display_name, display_name_source FROM contacts WHERE source_jid = ?`).get(PN) as {
        display_name: string | null;
        display_name_source: string | null;
      };
      raw.close();
      expect(contact.display_name).toBe("Asha Verma");
      expect(contact.display_name_source).toBe("google_contacts");
    });
  });

  // 7.2 (boundary) — a genuine saved name is never overwritten by enrichment;
  // only weak/masked labels are overwritable.
  it("does not let enrichment overwrite a real saved name", async () => {
    await withRepo(async (repo, dbPath) => {
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(PN), displayName: null }]);
      await repo.upsertContacts(runId, [{ sourceJid: PN, displayName: "Asha (school)", pushName: null, phoneNumber: "919051167186" }]);
      await repo.upsertMessages([makeMessage(PN, "m1", 1000)]);

      const seed = new Database(dbPath);
      seed.prepare(`UPDATE contacts SET display_name_source = 'whatsapp_saved' WHERE source_jid = ?`).run(PN);
      seed.close();

      const result = await repo.enrichContactsFromGoogle([{ phoneNumber: "919051167186", displayName: "Asha Verma" }]);
      expect(result.improvedNames).toBe(0);

      const chats = await repo.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const dm = chats.find((chat) => chat.sourceChatId === PN);
      const messages = await repo.listMessages(dm!.id, { limit: 10, offset: 0 });
      expect(messages[0]?.senderDisplayName).toBe("Asha (school)"); // real name preserved
    });
  });

  // 4.2 / 4.3 — after the backfill nulls a masked label, the sender's messages
  // are recomputed so the search index matches the full number and no longer
  // carries the mask.
  it("recomputes search text on backfill so a demasked sender matches its full number", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-demask-search-"));
    const dbPath = path.join(tempDir, "archive.sqlite");
    try {
      let repo = new SqliteArchiveRepository(dbPath);
      const runId = await repo.startImportRun({ fixture: "demask" });
      await repo.upsertChats(runId, [{ ...makeChat(PN), displayName: null }]);
      await repo.upsertContacts(runId, [{ sourceJid: PN, displayName: null, pushName: null, phoneNumber: "919051167186" }]);
      await repo.upsertMessages([{ ...makeMessage(PN, "m1", 1000), body: "reunion plan" }]);
      await repo.rebuildSearchIndex(); // fts_state → ready
      await repo.close();

      // Simulate the pre-fix state: a masked label that had been indexed into the
      // sender's resolved_text (the FTS update trigger carries it into the index).
      const seed = new Database(dbPath);
      seed.prepare(`UPDATE contacts SET display_name = ? WHERE source_jid = ?`).run(MASK, PN);
      seed.prepare(`UPDATE messages SET resolved_text = ? WHERE source_message_id = ?`).run(`reunion plan\n${MASK}`, "m1");
      seed.close();

      // Re-open → backfill nulls the mask and recomputes the affected message.
      repo = new SqliteArchiveRepository(dbPath);

      const raw = new Database(dbPath, { readonly: true });
      const derived = raw
        .prepare(`SELECT resolved_text, resolved_sender FROM messages WHERE source_message_id = ?`)
        .get("m1") as { resolved_text: string | null; resolved_sender: string | null };
      raw.close();
      // retrieval-hardening split the sender label into its own derived
      // column; the demasked full number must land there, mask-free.
      expect(derived.resolved_sender).toContain("+919051167186");
      expect(`${derived.resolved_text}\n${derived.resolved_sender}`).not.toContain("∙");

      const byNumber = await repo.searchMessages({ query: "919051167186", limit: 10, offset: 0 });
      expect(byNumber.results.some((result) => result.sourceMessageId === "m1")).toBe(true);
      await repo.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function makeChat(chatSourceId: string): ChatRecord {
  return {
    sourceChatId: chatSourceId,
    jid: chatSourceId,
    displayName: null,
    chatType: chatSourceId.endsWith("@g.us") ? "group" : "dm"
  };
}

function makeMessage(chatSourceId: string, id: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(chatSourceId, id),
    sourceTable: "wa-web:messages.upsert",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: chatSourceId,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    rawTypeCode: "text",
    body: `Synthetic ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}
