import { readFile, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExactTraceRecorder } from "../src/server/diagnostics/traceRecorder";

describe("exact diagnostic trace recorder", () => {
  it("records exact local payloads and archive snapshots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-trace-"));
    try {
      const archivePath = path.join(tempDir, "archive.sqlite");
      await writeFile(archivePath, "sqlite bytes with private ids and message bodies", "utf8");

      const recorder = new ExactTraceRecorder("jid merge debug", tempDir);
      await recorder.record("baileys.raw_event", {
        message: { conversation: "hello exact recorder" },
        remoteJid: "244543240839423@lid",
        mediaKey: Buffer.from("private-bytes")
      });
      const snapshotPath = await recorder.snapshotArchive("after import", archivePath);
      await recorder.close();

      const manifest = JSON.parse(await readFile(path.join(recorder.directory, "manifest.json"), "utf8"));
      const lines = (await readFile(recorder.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const snapshot = await stat(snapshotPath ?? "");

      expect(manifest.name).toBe("jid merge debug");
      expect(lines.some((line) => JSON.stringify(line).includes("hello exact recorder"))).toBe(true);
      expect(lines.some((line) => JSON.stringify(line).includes("244543240839423@lid"))).toBe(true);
      expect(lines.some((line) => line.kind === "archive.snapshot" && line.data.sha256)).toBe(true);
      expect(snapshot.size).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
