import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCrypt15Fixture } from "../src/server/import/decrypt";
import { listWaContacts } from "../src/server/import/waContacts";

function createWaDbWithMixedContacts(filePath: string): void {
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE wa_contacts (
        _id INTEGER PRIMARY KEY,
        jid TEXT,
        display_name TEXT,
        wa_name TEXT,
        number TEXT
      );
    `);
    const insert = db.prepare("INSERT INTO wa_contacts (jid, display_name, wa_name, number) VALUES (?, ?, ?, ?)");
    insert.run("15550000001@s.whatsapp.net", "Avery Example", "Avery", "15550000001");
    insert.run("15550000002@s.whatsapp.net", null, "Blake", "15550000002");
    insert.run("15550000003@s.whatsapp.net", null, null, "15550000003");
  } finally {
    db.close();
  }
}

describe("wa-contacts viewer", () => {
  it("lists resolved and unresolved contacts from a plaintext wa.db", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-wa-contacts-"));
    try {
      const waPath = path.join(tempDir, "wa.db");
      createWaDbWithMixedContacts(waPath);

      const summary = await listWaContacts({ waPath });

      expect(summary.totalContacts).toBe(3);
      expect(summary.resolvedCount).toBe(2);
      expect(summary.unresolvedCount).toBe(1);
      const unresolved = summary.contacts.find((contact) => !contact.resolved);
      expect(unresolved?.jid).toBe("15550000003@s.whatsapp.net");
      expect(unresolved?.number).toBe("15550000003");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("decrypts a wa.db.crypt15 sidecar and cleans up the decrypted file afterward", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-wa-contacts-crypt15-"));
    try {
      const plainWaPath = path.join(tempDir, "wa.db");
      createWaDbWithMixedContacts(plainWaPath);
      const rootKey = randomBytes(32);
      const encryptedWaPath = path.join(tempDir, "wa.db.crypt15");
      await writeFile(encryptedWaPath, createCrypt15Fixture(rootKey, await readFile(plainWaPath)));

      const summary = await listWaContacts({ waPath: encryptedWaPath, key: rootKey.toString("hex") });

      expect(summary.decryptedDuringInspect).toBe(true);
      expect(summary.totalContacts).toBe(3);
      expect(summary.resolvedCount).toBe(2);
      expect(summary.unresolvedCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
