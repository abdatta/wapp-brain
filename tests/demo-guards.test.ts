// A demo-mode server must refuse every endpoint that would start an external
// side effect — live pairing/resume, Google OAuth, model-provider enablement —
// with the stable `{ demo: true }` shape, report `demo` in its status DTO, and
// keep the effective brain provider extractive. A normal-mode server must not
// refuse the same endpoints with that shape. Both servers run as spawned
// children against temp workspaces.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Child = ReturnType<typeof spawn>;

async function startServer(env: Record<string, string>, port: number): Promise<Child> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, APP_HOST: "127.0.0.1", APP_PORT: String(port), ...env },
    stdio: "ignore"
  });
  await waitForHttp(`http://127.0.0.1:${port}/api/status`);
  return child;
}

async function stopServer(child: Child | null): Promise<void> {
  if (!child) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("demo-mode server guards", () => {
  it("refuses external side effects in demo mode and reports demo status", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wapp-demo-guards-"));
    const demoDir = path.join(directory, "demo-workspace");
    const port = 6100 + Math.floor(Math.random() * 300);
    let child: Child | null = null;
    try {
      child = await startServer(
        {
          WAPP_DEMO: "1",
          WAPP_DEMO_DIR: demoDir,
          // Isolation rule: these must be ignored by the demo pivot.
          WAPP_WORK_DIR: path.join(directory, "pretend-real"),
          ARCHIVE_DB_PATH: path.join(directory, "pretend-real", "archive.sqlite")
        },
        port
      );
      const base = `http://127.0.0.1:${port}`;

      const status = await (await fetch(`${base}/api/status`)).json() as { demo?: boolean; demoWorkspacePath?: string | null };
      expect(status.demo).toBe(true);
      expect(status.demoWorkspacePath).toBe(path.resolve(demoDir));

      const guarded: Array<{ method: "POST" | "GET"; url: string; body?: unknown }> = [
        { method: "POST", url: "/api/live/link", body: {} },
        { method: "POST", url: "/api/live/resume" },
        { method: "POST", url: "/api/live/stop" },
        { method: "POST", url: "/api/live/unlink" },
        { method: "POST", url: "/api/live/gaps/1/retry" },
        { method: "GET", url: "/api/google-contacts/oauth/start" },
        { method: "POST", url: "/api/google-contacts/sync" },
        { method: "POST", url: "/api/brain/provider", body: { action: "enable", provider: "codex" } },
        { method: "POST", url: "/api/brain/provider", body: { action: "set-model", provider: "codex", model: "gpt-5.6-terra" } },
        { method: "POST", url: "/api/memory/provider/enable-codex" }
      ];
      for (const request of guarded) {
        const response = await fetch(`${base}${request.url}`, {
          method: request.method,
          redirect: "manual",
          headers: request.body !== undefined ? { "content-type": "application/json" } : undefined,
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined
        });
        expect(response.status, `${request.method} ${request.url}`).toBe(409);
        const payload = await response.json() as { demo?: boolean; error?: string };
        expect(payload.demo, `${request.method} ${request.url}`).toBe(true);
        expect(payload.error, `${request.method} ${request.url}`).toContain("demo");
      }

      // The effective provider stays extractive after the refused enablement.
      const provider = await (await fetch(`${base}/api/brain/provider`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "status" })
      })).json() as { provider: { provider: string; modelBacked: boolean } };
      expect(provider.provider.provider).toBe("extractive");
      expect(provider.provider.modelBacked).toBe(false);
    } finally {
      await stopServer(child);
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("does not use the demo refusal shape in normal mode", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wapp-normal-guards-"));
    const port = 6400 + Math.floor(Math.random() * 300);
    let child: Child | null = null;
    try {
      child = await startServer(
        {
          ARCHIVE_DB_PATH: path.join(directory, "archive.sqlite"),
          WAPP_WORK_DIR: path.join(directory, "work"),
          LIVE_AUTO_RESUME: "0"
        },
        port
      );
      const base = `http://127.0.0.1:${port}`;

      const status = await (await fetch(`${base}/api/status`)).json() as { demo?: boolean };
      expect(status.demo).toBe(false);

      // Normal mode refuses live linking for its own reason (no baseline), not
      // as a demo refusal.
      const link = await fetch(`${base}/api/live/link`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(link.status).toBe(400);
      const payload = await link.json() as { demo?: boolean };
      expect(payload.demo).toBeUndefined();
    } finally {
      await stopServer(child);
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The loopback TypeScript server may take a few seconds to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
