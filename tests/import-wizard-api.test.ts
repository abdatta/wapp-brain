import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { createCrypt15Fixture } from "../src/server/import/decrypt";
import { createSyntheticFixture } from "../src/server/import/fixtures";
import { runImport } from "../src/server/import/importer";
import {
  cancelImportJob,
  getCurrentImportJob,
  getImportJob,
  setImportJobLoggerForTests,
  setImportTerminalProgressFactoryForTests,
  startImportJob
} from "../src/server/import/staging";
import type { BackupDetectionManifest, ImportJobSummary, ImportVerificationSummary, StatusSummary } from "../src/shared/types";

describe("import wizard local API", () => {
  it("detects a backup folder, verifies the text key, imports in place, and exposes picker availability", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-import-wizard-"));
    const archivePath = path.join(tempDir, "archive.sqlite");
    const workDir = path.join(tempDir, "work");
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const rootKey = randomBytes(32);
      // Lay the encrypted databases out as a real backup folder.
      const backupDir = path.join(tempDir, "backup");
      await mkdir(backupDir, { recursive: true });
      const encryptedPath = path.join(backupDir, "msgstore.db.crypt15");
      await writeFile(encryptedPath, createCrypt15Fixture(rootKey, await readFile(fixture.msgstorePath)));
      const encryptedWaPath = path.join(backupDir, "wa.db.crypt15");
      await writeFile(encryptedWaPath, createCrypt15Fixture(rootKey, await readFile(fixture.waPath)));

      const port = 5600 + Math.floor(Math.random() * 1000);
      const child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          APP_PORT: String(port),
          APP_HOST: "127.0.0.1",
          ARCHIVE_DB_PATH: archivePath,
          WAPP_WORK_DIR: workDir,
          WAPP_PICK_FAKE_MS: "400"
        },
        stdio: "ignore"
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        await waitForHttp(`${base}/api/status`);

        // Auto-detection resolves the core inputs from the one folder.
        const detected = await fetchJson<{ manifest: BackupDetectionManifest }>(`${base}/api/import/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: backupDir })
        });
        expect(detected.manifest.valid).toBe(true);
        expect(detected.manifest.msgstore?.name).toBe("msgstore.db.crypt15");
        expect(detected.manifest.wa?.name).toBe("wa.db.crypt15");

        // A non-local/empty folder path is rejected.
        const badDetect = await fetch(`${base}/api/import/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: "" })
        });
        expect(badDetect.ok).toBe(false);

        // The removed byte-upload staging route no longer exists.
        const stagingGone = await fetch(`${base}/api/import/staging`, { method: "POST" });
        expect(stagingGone.status).toBe(404);

        // An invalid picker kind is rejected (a valid kind would open a real dialog).
        const badPick = await fetch(`${base}/api/import/pick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "nonsense" })
        });
        expect(badPick.ok).toBe(false);

        // Regression: a pending pick must survive the request's own "close"
        // event (which fires as soon as the consumed body ends on modern Node);
        // only a real client disconnect may abort the dialog. The fake runner
        // (WAPP_PICK_FAKE_MS) resolves after a delay unless aborted.
        const picked = await fetchJson<{ ok: boolean; path?: string; cancelled?: boolean }>(`${base}/api/import/pick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "backup-root" })
        });
        expect(picked.cancelled).toBeUndefined();
        expect(picked.path).toBe("fake-pick:folder");

        // Text key only: wrong key fails, correct key verifies against the detected msgstore.
        const failedVerify = await fetch(`${base}/api/import/verify-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgstorePath: detected.manifest.msgstore?.path, key: "0".repeat(64) })
        });
        expect(failedVerify.ok).toBe(false);

        const verified = await fetchJson<{ verification: ImportVerificationSummary }>(`${base}/api/import/verify-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msgstorePath: detected.manifest.msgstore?.path,
            waPath: detected.manifest.wa?.path,
            key: rootKey.toString("hex")
          })
        });
        expect(verified.verification.ok).toBe(true);

        // Import runs from the detected paths — nothing uploaded.
        const started = await fetchJson<{ job: ImportJobSummary }>(`${base}/api/import/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "merge",
            key: rootKey.toString("hex"),
            paths: { msgstorePath: detected.manifest.msgstore?.path, waPath: detected.manifest.wa?.path }
          })
        });
        const job = await waitForImportJob(base, started.job.id);
        const status = await fetchJson<StatusSummary>(`${base}/api/status`);

        expect(job.status).toBe("completed");
        expect(job.events.some((event) => event.type === "message-progress")).toBe(true);
        expect(job.totals?.messages).toBe(7);
        expect(status.counts.messages).toBe(7);
        expect(typeof status.pickerAvailable).toBe("boolean");
      } finally {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90000);

  it("cancels a running import and rolls back archive changes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-import-cancel-"));
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const inner = new MemoryArchiveRepository();
      await runImport(inner, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath, mode: "merge" });
      expect((await inner.getStatus()).counts.messages).toBe(7);

      let unblockMessages!: () => void;
      const messagesBlocked = new Promise<void>((resolve) => {
        let blocked = false;
        const unblock = new Promise<void>((release) => {
          unblockMessages = release;
        });
        const repository = new Proxy(inner, {
          get(target, property, receiver) {
            if (property === "upsertMessages") {
              return async (...args: Parameters<ArchiveRepository["upsertMessages"]>) => {
                if (!blocked) {
                  blocked = true;
                  resolve();
                  await unblock;
                }
                return target.upsertMessages(...args);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        }) as ArchiveRepository;

        const started = startImportJob(repository, {
          paths: { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath },
          mode: "replace"
        });
        expect(started.status).toBe("queued");
      });

      await messagesBlocked;
      const active = await waitForLocalImportJob((job) => job.status === "running");
      expect(active.mode).toBe("replace");
      const cancelling = cancelImportJob(active.id);
      expect(cancelling.status).toBe("cancelling");
      unblockMessages();

      const cancelled = await waitForLocalImportJob((job) => job.id === active.id && job.status === "cancelled");
      expect(cancelled.error).toContain("rolled back");
      expect((await inner.getStatus()).counts.messages).toBe(7);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);

  it("logs privacy-safe progress for UI import jobs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-import-logs-"));
    const logs: string[] = [];
    const restoreLogger = setImportJobLoggerForTests({
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`)
    });
    try {
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const repository = new MemoryArchiveRepository();
      const started = startImportJob(repository, {
        paths: { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath },
        mode: "merge"
      });
      const completed = await waitForLocalImportJobById(started.id, (job) => job.status === "completed");

      expect(completed.totals?.messages).toBe(7);
      expect(logs.some((line) => line.includes(`[import:${started.id.slice(0, 8)}] started mode=merge`))).toBe(true);
      expect(logs.some((line) => line.includes("step=messages"))).toBe(true);
      expect(logs.some((line) => line.includes("messages processed="))).toBe(true);
      expect(logs.some((line) => line.includes("completed messages=7 warnings=0"))).toBe(true);
      expect(logs.join("\n")).not.toContain(fixture.msgstorePath);
      expect(logs.join("\n")).not.toContain(fixture.waPath);
    } finally {
      restoreLogger();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);

  it("sends UI import progress to terminal bars when enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-import-terminal-"));
    const previousProgressSetting = process.env.WAPP_IMPORT_PROGRESS;
    const progressEvents: string[] = [];
    const restoreTerminalFactory = setImportTerminalProgressFactoryForTests((label) => {
      progressEvents.push(`label:${label}`);
      return {
        handle: (event) => progressEvents.push(`event:${event.type}`),
        fail: (message) => progressEvents.push(`fail:${message}`),
        stop: (message) => progressEvents.push(`stop:${message ?? ""}`)
      };
    });
    try {
      process.env.WAPP_IMPORT_PROGRESS = "bars";
      const fixture = await createSyntheticFixture(path.join(tempDir, "fixture"));
      const repository = new MemoryArchiveRepository();
      const started = startImportJob(repository, {
        paths: { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath },
        mode: "merge"
      });
      await waitForLocalImportJobById(started.id, (job) => job.status === "completed");

      expect(progressEvents).toContain("label:Starting UI import.");
      expect(progressEvents).toContain("event:step");
      expect(progressEvents).toContain("event:message-progress");
      expect(progressEvents).toContain("event:complete");
    } finally {
      if (previousProgressSetting === undefined) {
        delete process.env.WAPP_IMPORT_PROGRESS;
      } else {
        process.env.WAPP_IMPORT_PROGRESS = previousProgressSetting;
      }
      restoreTerminalFactory();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);
});

async function waitForHttp(url: string): Promise<void> {
  // tsx cold-compiles the whole server graph on spawn; allow generous headroom.
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForImportJob(base: string, jobId: string): Promise<ImportJobSummary> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const job = await fetchJson<ImportJobSummary>(`${base}/api/import/jobs/${jobId}`);
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for import job ${jobId}`);
}

async function waitForLocalImportJob(predicate: (job: ImportJobSummary) => boolean): Promise<ImportJobSummary> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const latest = getCurrentImportJob();
      if (latest && predicate(latest)) {
        return latest;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for local import job");
}

async function waitForLocalImportJobById(jobId: string, predicate: (job: ImportJobSummary) => boolean): Promise<ImportJobSummary> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = getImportJob(jobId);
    if (predicate(job)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for local import job ${jobId}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}
