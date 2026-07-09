import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectBackupFolder } from "../src/server/import/detectBackup";

async function touch(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "x");
}

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("detectBackupFolder", () => {
  it("detects the core inputs from a standard flat backup folder", async () => {
    const root = await tempRoot("wapp-detect-flat-");
    await touch(path.join(root, "msgstore.db.crypt15"));
    await touch(path.join(root, "wa.db.crypt15"));
    await mkdir(path.join(root, "Media"), { recursive: true });
    const manifest = await detectBackupFolder(root);
    expect(manifest.valid).toBe(true);
    expect(manifest.msgstore?.name).toBe("msgstore.db.crypt15");
    expect(manifest.msgstore?.encrypted).toBe(true);
    expect(manifest.wa?.name).toBe("wa.db.crypt15");
    expect(manifest.media?.name).toBe("Media");
  });

  it("finds databases under Databases/ and media under Media/", async () => {
    const root = await tempRoot("wapp-detect-sub-");
    await touch(path.join(root, "Databases", "msgstore.db.crypt15"));
    await touch(path.join(root, "Databases", "wa.db.crypt15"));
    await mkdir(path.join(root, "Media"), { recursive: true });
    const manifest = await detectBackupFolder(root);
    expect(manifest.valid).toBe(true);
    expect(manifest.msgstore?.path).toContain("Databases");
    expect(manifest.media?.name).toBe("Media");
  });

  it("is invalid when no msgstore is present", async () => {
    const root = await tempRoot("wapp-detect-empty-");
    await touch(path.join(root, "wa.db.crypt15"));
    const manifest = await detectBackupFolder(root);
    expect(manifest.valid).toBe(false);
    expect(manifest.msgstore).toBeNull();
  });

  it("allows missing optional inputs", async () => {
    const root = await tempRoot("wapp-detect-min-");
    await touch(path.join(root, "msgstore.db.crypt15"));
    const manifest = await detectBackupFolder(root);
    expect(manifest.valid).toBe(true);
    expect(manifest.wa).toBeNull();
    expect(manifest.media).toBeNull();
  });

  it("prefers the canonical msgstore, else the newest dated rotation", async () => {
    const root = await tempRoot("wapp-detect-dated-");
    await touch(path.join(root, "msgstore-2024-01-01.1.db.crypt15"));
    await touch(path.join(root, "msgstore-2024-03-05.1.db.crypt15"));
    const dated = await detectBackupFolder(root);
    expect(dated.msgstore?.name).toBe("msgstore-2024-03-05.1.db.crypt15");
    expect(dated.notes.join(" ")).toContain("most recent");

    await touch(path.join(root, "msgstore.db.crypt15"));
    const canonical = await detectBackupFolder(root);
    expect(canonical.msgstore?.name).toBe("msgstore.db.crypt15");
  });

  it("recognizes auxiliary files and reserves them", async () => {
    const root = await tempRoot("wapp-detect-aux-");
    await touch(path.join(root, "msgstore.db.crypt15"));
    await touch(path.join(root, "chatsettingsbackup.db.crypt15"));
    await touch(path.join(root, "status_backup.db.crypt15"));
    await touch(path.join(root, "stickers_db.bak.crypt15"));
    const manifest = await detectBackupFolder(root);
    const kinds = manifest.auxiliary.map((file) => file.kind).sort();
    expect(kinds).toEqual(["chatsettingsbackup", "status_backup", "stickers_db"]);
  });

  it("scans shallowly — files inside Media/ are not treated as inputs", async () => {
    const root = await tempRoot("wapp-detect-shallow-");
    await touch(path.join(root, "msgstore.db.crypt15"));
    // A decoy inside Media must be ignored: only the root and Databases/ are scanned.
    await touch(path.join(root, "Media", "wa.db.crypt15"));
    const manifest = await detectBackupFolder(root);
    expect(manifest.wa).toBeNull();
    expect(manifest.media?.name).toBe("Media");
  });
});
