import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleanupDecryptedWorkDir, ensureManagedWorkDir } from "../src/server/cleanup";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { createCrypt15Fixture, decryptCrypt15 } from "../src/server/import/decrypt";
import { createModernSyntheticFixture, createSyntheticFixture } from "../src/server/import/fixtures";
import { inspectArchive } from "../src/server/import/inspect";
import { runImport } from "../src/server/import/importer";
import { parseWhatsAppSource } from "../src/server/import/parser";
import { openReadableSQLite } from "../src/server/import/sqlite";
import { verifyImportKey } from "../src/server/import/staging";

describe("WhatsApp import MVP", () => {
  it("cleans only app-managed decrypted working files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-cleanup-"));
    try {
      const empty = await cleanupDecryptedWorkDir(tempDir);
      expect(empty).toEqual({ removedFiles: 0, removedDirectories: 0 });

      await ensureManagedWorkDir(tempDir);
      const decryptedDir = path.join(tempDir, "decrypted");
      await mkdir(path.join(decryptedDir, "nested"), { recursive: true });
      await writeFile(path.join(decryptedDir, "msgstore-test.db"), "synthetic");
      await writeFile(path.join(decryptedDir, "nested", "leftover.raw"), "synthetic");

      const cleaned = await cleanupDecryptedWorkDir(tempDir);
      await expect(stat(decryptedDir)).rejects.toThrow();

      expect(cleaned.removedFiles).toBe(2);
      expect(cleaned.removedDirectories).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses cleanup for unmanaged decrypted directories", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-unmanaged-"));
    try {
      const decryptedDir = path.join(tempDir, "decrypted");
      await mkdir(decryptedDir, { recursive: true });
      await writeFile(path.join(decryptedDir, "unknown.db"), "synthetic");

      await expect(cleanupDecryptedWorkDir(tempDir)).rejects.toThrow("managed work directory");
      await expect(stat(path.join(decryptedDir, "unknown.db"))).resolves.toBeTruthy();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("imports synthetic chats, contacts, participants, and messages idempotently", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-import-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const repository = new MemoryArchiveRepository();

      const first = await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      const second = await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      const status = await repository.getStatus();
      const chats = await repository.listChats({ limit: 20, offset: 0 });
      const group = chats.find((chat) => chat.chatType === "group");

      expect(first.messages).toBe(7);
      expect(second.messages).toBe(7);
      expect(status.counts.messages).toBe(7);
      expect(status.counts.chats).toBe(2);
      expect(status.counts.contacts).toBeGreaterThanOrEqual(4);
      expect(group?.participantCount).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists imports idempotently in a local SQLite archive file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-sqlite-"));
    let repository: SqliteArchiveRepository | null = null;
    let reopened: SqliteArchiveRepository | null = null;
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const archivePath = path.join(tempDir, "archive.sqlite");
      repository = new SqliteArchiveRepository(archivePath);

      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      await repository.close();
      repository = null;

      reopened = new SqliteArchiveRepository(archivePath);
      const status = await reopened.getStatus();
      const chats = await reopened.listChats({ limit: 20, offset: 0, search: "Weekend Plans" });
      const messages = chats[0] ? await reopened.listMessages(chats[0].id, { limit: 20, offset: 0, order: "desc" }) : [];

      expect(status.database.adapter).toBe("sqlite");
      expect(status.database.initialized).toBe(true);
      expect(status.counts.messages).toBe(7);
      expect(status.counts.chats).toBe(2);
      expect(chats[0]?.chatType).toBe("group");
      expect(messages.some((message) => message.messageType === "unknown_999")).toBe(true);
      expect(messages[0]?.body).toBeNull();
    } finally {
      await repository?.close();
      await reopened?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspects supported archives without exposing message bodies", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-inspect-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"), { privacyCanary: true });

      const summary = await inspectArchive({
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });

      expect(summary.supported).toBe(true);
      expect(summary.schemaKind).toBe("legacy");
      expect(summary.counts.chats).toBe(2);
      expect(summary.tables.some((table) => table.name === "messages")).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("FAKE_SECRET_DO_NOT_LOG");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("inspects unsupported archives with schema warnings but no row dumps", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-inspect-unsupported-"));
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      const db = new Database(msgstorePath);
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO unrelated (note) VALUES ('not chat data');");
      db.close();

      const summary = await inspectArchive({ msgstorePath });

      expect(summary.supported).toBe(false);
      expect(summary.schemaKind).toBe("unsupported");
      expect(summary.warnings.some((warning) => warning.code === "UNSUPPORTED_MSGSTORE_SCHEMA")).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("not chat data");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps import summaries free of message-body canaries", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-privacy-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"), { privacyCanary: true });
      const repository = new MemoryArchiveRepository();
      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      const status = await repository.getStatus();

      expect(JSON.stringify(status)).not.toContain("FAKE_SECRET_DO_NOT_LOG");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("imports a modern chat/jid/message schema with mapped group senders", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-modern-"));
    try {
      const fixture = await createModernSyntheticFixture(path.join(tempDir, "fixture"));
      const repository = new MemoryArchiveRepository();

      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      const status = await repository.getStatus();
      const chats = await repository.listChats({ limit: 20, offset: 0 });
      const group = chats.find((chat) => chat.chatType === "group");
      const groupMessages = group ? await repository.listMessages(group.id, { limit: 20, offset: 0 }) : [];

      expect(status.counts.messages).toBe(5);
      expect(status.counts.chats).toBe(2);
      expect(group?.displayName).toBe("Modern Group");
      expect(group?.participantCount).toBe(2);
      expect(groupMessages.some((message) => message.senderDisplayName === "Blake Example")).toBe(true);
      expect(groupMessages.some((message) => message.messageType === "document")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles large-ish histories with idempotent reruns and newest paging", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-large-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"), { large: true });
      const repository = new MemoryArchiveRepository();

      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      const status = await repository.getStatus();
      const chats = await repository.listChats({ limit: 20, offset: 0 });
      const direct = chats.find((chat) => chat.chatType === "dm");
      const newest = direct ? await repository.listMessages(direct.id, { limit: 3, offset: 0, order: "desc" }) : [];
      const older = direct ? await repository.listMessages(direct.id, { limit: 3, offset: 3, order: "desc" }) : [];

      expect(status.counts.messages).toBe(10007);
      expect(direct?.messageCount).toBe(10003);
      expect(newest[0]?.body).toBe("Synthetic bulk message 9999");
      expect(newest[2]?.body).toBe("Synthetic bulk message 9997");
      expect(older[0]?.body).toBe("Synthetic bulk message 9996");
      expect(new Set([...newest, ...older].map((message) => message.id)).size).toBe(6);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("yields during message batch import so UI polling can observe progress", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-import-yield-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"), { large: true });
      const repository = new MemoryArchiveRepository();
      let timerScheduled = false;
      let importFinished = false;
      let timerFiredBeforeImportFinished = false;

      await runImport(
        repository,
        {
          msgstorePath: fixture.msgstorePath,
          waPath: fixture.waPath
        },
        {
          onProgress: (event) => {
            if (event.type === "message-progress" && event.processedMessages > 0 && !timerScheduled) {
              timerScheduled = true;
              setImmediate(() => {
                if (!importFinished) {
                  timerFiredBeforeImportFinished = true;
                }
              });
            }
          }
        }
      );
      importFinished = true;

      expect(timerScheduled).toBe(true);
      expect(timerFiredBeforeImportFinished).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles 1000+ chats with idempotent reruns and chat pagination", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-many-chats-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"), { manyChats: 1005 });
      const repository = new MemoryArchiveRepository();

      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: fixture.waPath
      });
      const status = await repository.getStatus();
      const firstPage = await repository.listChats({ limit: 60, offset: 0 });
      const secondPage = await repository.listChats({ limit: 60, offset: 60 });
      const searched = await repository.listChats({ limit: 5, offset: 0, search: "Synthetic Contact 1004" });
      const firstPageIds = new Set(firstPage.map((chat) => chat.id));

      expect(status.counts.chats).toBe(1007);
      expect(status.counts.messages).toBe(1012);
      expect(firstPage).toHaveLength(60);
      expect(secondPage).toHaveLength(60);
      expect(secondPage.some((chat) => firstPageIds.has(chat.id))).toBe(false);
      expect(searched[0]?.displayName).toBe("Synthetic Contact 1004");
      expect(searched[0]?.messageCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("hides event-only chats by default while preserving opt-in access and filtered pagination", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-event-only-"));
    let sqliteRepository: SqliteArchiveRepository | null = null;
    try {
      const memoryRepository = new MemoryArchiveRepository();
      sqliteRepository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));

      for (const repository of [memoryRepository, sqliteRepository]) {
        await seedEventOnlyChatScenario(repository);

        const defaultChats = await repository.listChats({ limit: 10, offset: 0 });
        const includedChats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
        const searchedEvent = await repository.listChats({ limit: 10, offset: 0, search: "Only Events", includeEventOnly: true });
        const defaultEventSearch = await repository.listChats({ limit: 10, offset: 0, search: "Only Events" });
        const statusEvents = await repository.listChats({ limit: 10, offset: 0, type: "status", includeEventOnly: true });
        const firstPage = await repository.listChats({ limit: 1, offset: 0 });
        const secondPage = await repository.listChats({ limit: 1, offset: 1 });

        expect(defaultChats.map((chat) => chat.displayName)).toEqual(["Visible Latest", "Visible Earlier"]);
        expect(includedChats.map((chat) => chat.displayName)).toContain("Only Events");
        expect(searchedEvent[0]?.displayName).toBe("Only Events");
        expect(defaultEventSearch).toHaveLength(0);
        expect(statusEvents[0]?.displayName).toBe("Status Events");
        expect(firstPage[0]?.displayName).toBe("Visible Latest");
        expect(secondPage[0]?.displayName).toBe("Visible Earlier");
      }
    } finally {
      await sqliteRepository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips malformed message rows with privacy-safe warnings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-malformed-"));
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      const waPath = path.join(tempDir, "wa.db");
      const msgstore = new Database(msgstorePath);
      msgstore.exec(`
        CREATE TABLE chat_list (
          key_remote_jid TEXT PRIMARY KEY,
          subject TEXT,
          sort_timestamp INTEGER
        );
        CREATE TABLE messages (
          _id INTEGER PRIMARY KEY,
          key_remote_jid TEXT,
          key_from_me INTEGER,
          key_id TEXT,
          remote_resource TEXT,
          data TEXT,
          timestamp INTEGER,
          media_wa_type INTEGER
        );
        INSERT INTO chat_list (key_remote_jid, subject, sort_timestamp)
          VALUES ('15550000001@s.whatsapp.net', NULL, 1712000001000);
        INSERT INTO messages (_id, key_remote_jid, key_from_me, key_id, remote_resource, data, timestamp, media_wa_type)
          VALUES (1, '15550000001@s.whatsapp.net', 0, 'good-1', NULL, 'Good synthetic row', 1712000001000, 0);
        INSERT INTO messages (_id, key_remote_jid, key_from_me, key_id, remote_resource, data, timestamp, media_wa_type)
          VALUES (2, NULL, 0, 'bad-1', NULL, 'FAKE_SKIP_SECRET_DO_NOT_LOG', 1712000002000, 0);
      `);
      msgstore.close();
      const wa = new Database(waPath);
      wa.exec(`
        CREATE TABLE wa_contacts (
          _id INTEGER PRIMARY KEY,
          jid TEXT,
          display_name TEXT
        );
        INSERT INTO wa_contacts (jid, display_name) VALUES ('15550000001@s.whatsapp.net', 'Avery Example');
      `);
      wa.close();
      const repository = new MemoryArchiveRepository();

      await runImport(repository, { msgstorePath, waPath });
      const status = await repository.getStatus();

      expect(status.counts.messages).toBe(1);
      expect(status.latestImport?.totals.skipped).toBe(1);
      expect(status.latestWarnings.some((warning) => warning.code === "MESSAGE_CHAT_MISSING")).toBe(true);
      expect(JSON.stringify(status)).not.toContain("FAKE_SKIP_SECRET_DO_NOT_LOG");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails clearly for valid SQLite files without a supported WhatsApp schema", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-unsupported-"));
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      const db = new Database(msgstorePath);
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO unrelated (note) VALUES ('not chat data');");
      db.close();
      const repository = new MemoryArchiveRepository();

      await expect(runImport(repository, { msgstorePath })).rejects.toThrow("supported WhatsApp message schema");
      const status = await repository.getStatus();

      expect(status.latestImport?.status).toBe("failed");
      expect(status.latestWarnings.some((warning) => warning.code === "UNSUPPORTED_MSGSTORE_SCHEMA")).toBe(true);
      expect(JSON.stringify(status)).not.toContain("not chat data");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("decrypts a synthetic crypt15 backup with a fake 64-character key", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-crypt15-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const sqliteBytes = await readFile(fixture.msgstorePath);
      const rootKey = randomBytes(32);
      const encrypted = createCrypt15Fixture(rootKey, sqliteBytes);
      const encryptedPath = path.join(tempDir, "msgstore.db.crypt15");
      await writeFile(encryptedPath, encrypted);

      const result = await decryptCrypt15({
        encryptedPath,
        key: rootKey.toString("hex"),
        outputDir: path.join(tempDir, "work")
      });
      const db = openReadableSQLite(result.sqlitePath, "decrypted msgstore");
      try {
        const count = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
        expect(count.count).toBe(7);
      } finally {
        db.close();
        await result.cleanup();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("decrypts an encrypted wa.db.crypt15 sidecar before parsing contacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-wa-crypt15-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const rootKey = randomBytes(32);
      const encryptedWaPath = path.join(tempDir, "wa.db.crypt15");
      await writeFile(encryptedWaPath, createCrypt15Fixture(rootKey, await readFile(fixture.waPath)));
      const repository = new MemoryArchiveRepository();

      const totals = await runImport(repository, {
        msgstorePath: fixture.msgstorePath,
        waPath: encryptedWaPath,
        key: rootKey.toString("hex")
      });
      const chats = await repository.listChats({ limit: 20, offset: 0, search: "Avery Example" });

      expect(totals.messages).toBe(7);
      expect(totals.contacts).toBeGreaterThanOrEqual(4);
      expect(chats[0]?.displayName).toBe("Avery Example");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies plaintext sidecars even when another input is encrypted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-verify-sidecar-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const rootKey = randomBytes(32);
      const encryptedMsgstorePath = path.join(tempDir, "msgstore.db.crypt15");
      const invalidWaPath = path.join(tempDir, "wa.db");
      await writeFile(encryptedMsgstorePath, createCrypt15Fixture(rootKey, await readFile(fixture.msgstorePath)));
      await writeFile(invalidWaPath, "not sqlite", "utf8");

      await expect(
        verifyImportKey({
          msgstorePath: encryptedMsgstorePath,
          waPath: invalidWaPath,
          key: rootKey.toString("hex")
        })
      ).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects encrypted backups other than crypt15", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-crypt14-reject-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const encryptedPath = path.join(tempDir, "msgstore.db.crypt14");
      await writeFile(encryptedPath, await readFile(fixture.msgstorePath));
      const repository = new MemoryArchiveRepository();

      await expect(
        runImport(repository, {
          msgstorePath: encryptedPath,
          waPath: fixture.waPath
        })
      ).rejects.toThrow("Only msgstore.db.crypt15 encrypted backups are supported");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("msgstore LID identity resolution", () => {
  it("reads jid_map links and lid_display_name names, and skips silently when absent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-lid-parser-"));
    try {
      const withTablesPath = path.join(tempDir, "msgstore-lid.db");
      createLidMsgstoreDb(withTablesPath, { withLidTables: true });
      const withTables = new Database(withTablesPath, { readonly: true });
      try {
        const parsed = parseWhatsAppSource(withTables);
        expect(parsed.identityLinks).toContainEqual({
          lid: "987654321000001@lid",
          pn: "15550000001@s.whatsapp.net",
          source: "msgstore.jid_map"
        });
        const mapped = parsed.contacts.find((contact) => contact.sourceJid === "987654321000001@lid");
        const cacheNamed = parsed.contacts.find((contact) => contact.sourceJid === "987654321000002@lid");
        expect(mapped?.displayName).toBe("Mapped Person");
        expect(cacheNamed?.displayName).toBe("Cache-Named Person");
        expect(cacheNamed?.rawMetadata?.source).toBe("lid_display_name");
      } finally {
        withTables.close();
      }

      const plainPath = path.join(tempDir, "msgstore-plain.db");
      createLidMsgstoreDb(plainPath, { withLidTables: false });
      const plain = new Database(plainPath, { readonly: true });
      try {
        const parsed = parseWhatsAppSource(plain);
        expect(parsed.identityLinks).toHaveLength(0);
        expect(parsed.contacts.every((contact) => contact.rawMetadata?.source !== "lid_display_name")).toBe(true);
        expect(parsed.warnings.map((warning) => warning.code)).toEqual(["WA_DB_NOT_PROVIDED"]);
      } finally {
        plain.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers wa.db address-book names over the msgstore LID display cache", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-lid-precedence-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      createLidMsgstoreDb(msgstorePath, { withLidTables: true });
      const waPath = path.join(tempDir, "wa.db");
      const wa = new Database(waPath);
      wa.exec(`
        CREATE TABLE wa_contacts (
          _id INTEGER PRIMARY KEY,
          jid TEXT,
          lid_jid TEXT,
          display_name TEXT
        );
        INSERT INTO wa_contacts (jid, lid_jid, display_name)
          VALUES ('15550000001@s.whatsapp.net', '987654321000001@lid', 'AddressBook Name');
      `);
      wa.close();
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));

      await runImport(repository, { msgstorePath, waPath });
      const chats = await repository.listChats({ limit: 20, offset: 0 });

      expect(chats.some((chat) => chat.displayName === "AddressBook Name")).toBe(true);
      expect(chats.some((chat) => chat.displayName === "Mapped Person")).toBe(false);
      expect(chats.some((chat) => chat.displayName === "Cache-Named Person")).toBe(true);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("heals a LID-keyed archive in place when a later backup carries jid_map", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-lid-heal-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      // First import simulates the pre-jid_map archive: LID-keyed chats, no links.
      const beforePath = path.join(tempDir, "msgstore-before.db");
      createLidMsgstoreDb(beforePath, { withLidTables: false });
      const afterPath = path.join(tempDir, "msgstore-after.db");
      createLidMsgstoreDb(afterPath, { withLidTables: true });
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));

      await runImport(repository, { msgstorePath: beforePath });
      const beforeChats = await repository.listChats({ limit: 20, offset: 0 });
      expect(beforeChats.some((chat) => chat.jid === "987654321000001@lid")).toBe(true);

      const healed = await runImport(repository, { msgstorePath: afterPath });
      const status = await repository.getStatus();
      const chats = await repository.listChats({ limit: 20, offset: 0 });
      const pnChat = chats.find((chat) => chat.jid === "15550000001@s.whatsapp.net");
      const pnMessages = pnChat ? await repository.listMessages(pnChat.id, { limit: 20, offset: 0 }) : [];

      expect(healed.messages).toBe(3);
      expect(status.counts.messages).toBe(3);
      expect(status.counts.chats).toBe(2);
      expect(chats.some((chat) => chat.jid === "987654321000001@lid")).toBe(false);
      expect(pnChat?.displayName).toBe("Mapped Person");
      expect(pnMessages).toHaveLength(2);
      expect(new Set(pnMessages.map((message) => message.sourceMessageId)).size).toBe(2);

      // Post-heal re-import is a no-op: nothing split, nothing merged, no new rows.
      await runImport(repository, { msgstorePath: afterPath });
      const finalStatus = await repository.getStatus();
      const enrichment = finalStatus.latestWarnings.find((warning) => warning.code === "CONTACT_ENRICHMENT");
      expect(finalStatus.counts.messages).toBe(3);
      expect(finalStatus.counts.chats).toBe(2);
      expect(enrichment?.context?.identityMerges).toBe(0);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports msgstore-derived enrichment even when wa.db is empty", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-lid-enrichment-"));
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      createLidMsgstoreDb(msgstorePath, { withLidTables: true });
      const waPath = path.join(tempDir, "wa.db");
      const wa = new Database(waPath);
      wa.exec("CREATE TABLE wa_contacts (_id INTEGER PRIMARY KEY, jid TEXT, display_name TEXT);");
      wa.close();
      const repository = new MemoryArchiveRepository();

      await runImport(repository, { msgstorePath, waPath });
      const status = await repository.getStatus();
      const enrichment = status.latestWarnings.find((warning) => warning.code === "CONTACT_ENRICHMENT");

      expect(enrichment).toBeTruthy();
      expect(enrichment?.context?.jidMapLinks).toBe(1);
      expect(enrichment?.context?.waDbLinks).toBe(0);
      expect(enrichment?.context?.lidNamesRead).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Modern msgstore schema plus the LID identity tables (jid_map, lid_display_name).
// jid row 2 is a LID mapped to the phone row 1; jid row 3 is a LID the phone can
// name but not map — the two coverage classes measured on the real archive.
function createLidMsgstoreDb(filePath: string, options: { withLidTables: boolean }): void {
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE jid (
        _id INTEGER PRIMARY KEY,
        raw_string TEXT,
        user TEXT,
        server TEXT
      );

      CREATE TABLE chat (
        _id INTEGER PRIMARY KEY,
        jid_row_id INTEGER NOT NULL,
        subject TEXT,
        display_name TEXT,
        sort_timestamp INTEGER
      );

      CREATE TABLE message (
        _id INTEGER PRIMARY KEY,
        chat_row_id INTEGER NOT NULL,
        sender_jid_row_id INTEGER,
        from_me INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        timestamp INTEGER,
        message_type INTEGER,
        status INTEGER,
        starred INTEGER,
        forwarded INTEGER
      );

      CREATE TABLE message_text (
        message_row_id INTEGER PRIMARY KEY,
        text_data TEXT
      );
    `);
    const insertJid = db.prepare("INSERT INTO jid (_id, raw_string, user, server) VALUES (?, ?, ?, ?)");
    insertJid.run(1, "15550000001@s.whatsapp.net", "15550000001", "s.whatsapp.net");
    insertJid.run(2, "987654321000001@lid", "987654321000001", "lid");
    insertJid.run(3, "987654321000002@lid", "987654321000002", "lid");

    const insertChat = db.prepare("INSERT INTO chat (_id, jid_row_id, subject, display_name, sort_timestamp) VALUES (?, ?, ?, ?, ?)");
    insertChat.run(10, 2, null, null, 1711000002000);
    insertChat.run(20, 3, null, null, 1711000004000);

    const insertMessage = db.prepare(`
      INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, status, starred, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertText = db.prepare("INSERT INTO message_text (message_row_id, text_data) VALUES (?, ?)");
    insertMessage.run(100, 10, 2, 0, "lid-m1", 1711000001000, 0, 0, 0, 0);
    insertText.run(100, "Hello from a departed number");
    insertMessage.run(101, 10, null, 1, "lid-m2", 1711000002000, 0, 0, 0, 0);
    insertText.run(101, "My reply");
    insertMessage.run(102, 20, 3, 0, "lid-m3", 1711000003000, 0, 0, 0, 0);
    insertText.run(102, "From the cache-named contact");

    if (options.withLidTables) {
      db.exec(`
        CREATE TABLE jid_map (
          _id INTEGER PRIMARY KEY,
          lid_row_id INTEGER,
          jid_row_id INTEGER,
          sort_id INTEGER
        );

        CREATE TABLE lid_display_name (
          lid_row_id INTEGER PRIMARY KEY,
          display_name TEXT,
          username TEXT
        );
      `);
      db.prepare("INSERT INTO jid_map (lid_row_id, jid_row_id, sort_id) VALUES (?, ?, ?)").run(2, 1, 1);
      const insertLidName = db.prepare("INSERT INTO lid_display_name (lid_row_id, display_name, username) VALUES (?, ?, ?)");
      insertLidName.run(2, "Mapped Person", null);
      insertLidName.run(3, "Cache-Named Person", null);
    }
  } finally {
    db.close();
  }
}

async function seedEventOnlyChatScenario(repository: ArchiveRepository): Promise<void> {
  const runId = await repository.startImportRun({ fixture: "event-only-chat-list" });
  await repository.upsertChats(runId, [
    {
      sourceChatId: "event-only@s.whatsapp.net",
      jid: "event-only@s.whatsapp.net",
      displayName: "Only Events",
      chatType: "dm"
    },
    {
      sourceChatId: "visible-latest@s.whatsapp.net",
      jid: "visible-latest@s.whatsapp.net",
      displayName: "Visible Latest",
      chatType: "dm"
    },
    {
      sourceChatId: "visible-earlier@s.whatsapp.net",
      jid: "visible-earlier@s.whatsapp.net",
      displayName: "Visible Earlier",
      chatType: "dm"
    },
    {
      sourceChatId: "status-events@status",
      jid: "status-events@status",
      displayName: "Status Events",
      chatType: "status"
    }
  ]);
  await repository.upsertMessages([
    makeSyntheticMessage("event-only@s.whatsapp.net", "event-only-1", 1710000004000, "system", "system"),
    makeSyntheticMessage("visible-latest@s.whatsapp.net", "visible-latest-1", 1710000003000, "text", "incoming", "Visible synthetic message"),
    makeSyntheticMessage("visible-earlier@s.whatsapp.net", "visible-earlier-1", 1710000002000, "text", "outgoing", "Earlier synthetic message"),
    makeSyntheticMessage("status-events@status", "status-events-1", 1710000001000, "status", "incoming", "Status event")
  ]);
  await repository.refreshChatStats();
  await repository.completeImportRun(runId, { contacts: 0, chats: 4, participants: 0, messages: 4, skipped: 0, warnings: 0 }, 0);
}

function makeSyntheticMessage(
  chatSourceId: string,
  id: string,
  timestampMs: number,
  messageType: string,
  direction: "incoming" | "outgoing" | "system" | "unknown",
  body: string | null = null
) {
  return {
    sourceMessageId: id,
    sourceMessageKey: id,
    sourceTable: "synthetic",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: direction === "incoming" ? "synthetic-sender@s.whatsapp.net" : null,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: direction === "outgoing" ? true : direction === "incoming" ? false : null,
    direction,
    messageType,
    rawTypeCode: messageType,
    body,
    caption: null,
    hasMedia: false,
    mediaMimeType: null,
    mediaName: null,
    quotedSourceMessageId: null,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    rawMetadata: null
  };
}
