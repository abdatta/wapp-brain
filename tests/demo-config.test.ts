// Demo-mode config pivot: `WAPP_DEMO=1` must move every path the app owns
// under the demo workspace and drop path-bearing env overrides, so a demo
// process cannot be pointed at the real workspace. Real mode must keep
// honoring the same overrides unchanged. The config module is re-imported per
// case because it parses the environment at import time.

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const mod = await import("../src/server/config");
  return mod.config;
}

function collectPaths(config: Record<string, unknown>): string[] {
  // Every string leaf that looks like a filesystem path the app would touch.
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(config);
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("demo-mode config pivot", () => {
  it("resolves every configured path under the demo workspace and ignores real-path overrides", async () => {
    const config = await loadConfig({
      WAPP_DEMO: "1",
      WAPP_WORK_DIR: ".wapp-brain",
      ARCHIVE_DB_PATH: path.join(".wapp-brain", "archive.sqlite"),
      WAPP_MEMORY_DIR: path.join(".wapp-brain", "memory"),
      WAPP_MEMORY_CODEX_SESSION_PATH: path.join(".wapp-brain", "memory", "codex-session.json")
    });

    expect(config.demo).toBe(true);
    expect(config.workDir).toBe(".wapp-brain-demo");
    expect(config.archive.sqlitePath).toBe(path.join(".wapp-brain-demo", "archive.sqlite"));
    expect(config.media.rootDir).toBe(path.join(".wapp-brain-demo", "media"));
    expect(config.live.authDir).toBe(path.join(".wapp-brain-demo", "live", "baileys-auth"));
    expect(config.brain.rootDir).toBe(path.join(".wapp-brain-demo", "brain"));
    expect(config.memory.rootDir).toBe(path.join(".wapp-brain-demo", "memory"));
    expect(config.memory.codexSessionPath).toBe(path.join(".wapp-brain-demo", "memory", "codex-session.json"));
    expect(config.diagnostics.traceRootDir).toBe(path.join(".wapp-brain-demo", "traces"));
    expect(config.googleContacts.credentialsPath).toBe(path.join(".wapp-brain-demo", "google-contacts-auth.json"));

    // No configured path may reach into the real workspace. The callback URL
    // is the only `.wapp-brain`-free string that could false-positive, so the
    // check is on path values: nothing starts with or contains `.wapp-brain`
    // unless it is the demo directory itself.
    for (const value of collectPaths(config as unknown as Record<string, unknown>)) {
      if (value.includes(".wapp-brain")) {
        expect(value.includes(".wapp-brain-demo")).toBe(true);
      }
    }
  });

  it("forces no-side-effect providers and a distinct default port in demo mode", async () => {
    const config = await loadConfig({
      WAPP_DEMO: "1",
      WAPP_BRAIN_PROVIDER: "codex",
      WAPP_MEMORY_PROVIDER: "codex",
      WAPP_MEMORY_REMOTE_MODEL_ENABLED: "1",
      LIVE_AUTO_RESUME: "1"
    });

    expect(config.brain.provider).toBe("extractive");
    expect(config.memory.provider).toBe("local");
    expect(config.memory.remoteModelEnabled).toBe(false);
    expect(config.live.autoResume).toBe(false);
    expect(config.app.port).toBe(3610);
  });

  it("keeps an explicit port override in demo mode", async () => {
    const config = await loadConfig({ WAPP_DEMO: "1", APP_PORT: "4123" });
    expect(config.app.port).toBe(4123);
  });

  it("honors WAPP_DEMO_DIR but refuses a collision with the real workspace", async () => {
    const relocated = await loadConfig({ WAPP_DEMO: "1", WAPP_DEMO_DIR: path.join("elsewhere", "demo") });
    expect(relocated.workDir).toBe(path.join("elsewhere", "demo"));
    expect(relocated.archive.sqlitePath).toBe(path.join("elsewhere", "demo", "archive.sqlite"));

    await expect(loadConfig({ WAPP_DEMO: "1", WAPP_DEMO_DIR: ".wapp-brain" })).rejects.toThrow(/real workspace/);
    await expect(
      loadConfig({ WAPP_DEMO: "1", WAPP_DEMO_DIR: "custom-real", WAPP_WORK_DIR: "custom-real" })
    ).rejects.toThrow(/real workspace/);
  });

  it("honors real-mode path overrides unchanged when the flag is absent", async () => {
    const config = await loadConfig({
      WAPP_DEMO: "",
      WAPP_WORK_DIR: "custom-workdir",
      ARCHIVE_DB_PATH: path.join("elsewhere", "archive.sqlite")
    });

    expect(config.demo).toBe(false);
    expect(config.workDir).toBe("custom-workdir");
    expect(config.archive.sqlitePath).toBe(path.join("elsewhere", "archive.sqlite"));
    expect(config.app.port).toBe(3600);
  });
});
