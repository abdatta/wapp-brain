// Demo provisioning must build a complete workspace (archive + episodes +
// manifest) using only the real pipelines, skip provisioning when the archive
// is already populated, and reset must delete only the demo workspace. All
// paths are redirected to a per-test temp root — never the repo's demo dir,
// and never the real workspace.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { printDemoStatus, provisionDemoWorkspaceIfNeeded, resetDemoWorkspace } from "../src/server/demo/provision";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "wapp-demo-provision-"));
const demoDir = path.join(tempRoot, "demo-workspace");

// Redirect every path provisioning touches at the temp root. The vault
// isolation setup already moved brain/memory; workDir/archive/media follow.
Object.assign(config, { demo: true, workDir: demoDir });
Object.assign(config.archive, { sqlitePath: path.join(demoDir, "archive.sqlite") });
Object.assign(config.media, { rootDir: path.join(demoDir, "media") });
Object.assign(config.brain, {
  rootDir: path.join(demoDir, "brain"),
  providerConfigPath: path.join(demoDir, "brain", "provider.json"),
  provider: "extractive"
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("demo provisioning", () => {
  it("provisions archive, episodes, and manifest; skips when populated; resets only the demo dir", async () => {
    await provisionDemoWorkspaceIfNeeded();

    const manifestRaw = await readFile(path.join(demoDir, "demo-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as { fixtureVersion: number; counts: Record<string, number> };
    expect(manifest.fixtureVersion).toBeGreaterThanOrEqual(1);
    expect(manifest.counts.chats).toBe(4);
    expect(manifest.counts.messages).toBeGreaterThanOrEqual(50);
    expect(manifest.counts.episodes).toBeGreaterThan(0);

    const repository = new SqliteArchiveRepository(config.archive.sqlitePath);
    try {
      const status = await repository.getStatus();
      expect(status.counts.messages).toBe(manifest.counts.messages);
      const episodes = await repository.listBrainEpisodes({ limit: 100 });
      expect(episodes.length).toBe(manifest.counts.episodes);
      const search = await repository.getSearchIndexStatus();
      expect(search.state).toBe("ready");
      const owner = await repository.getArchiveOwnerName();
      expect(owner).toBe("Jordan Lee");
    } finally {
      await repository.close?.();
    }

    // Second run skips: the manifest is untouched byte for byte.
    const manifestBefore = await stat(path.join(demoDir, "demo-manifest.json"));
    await provisionDemoWorkspaceIfNeeded();
    const manifestAfter = await stat(path.join(demoDir, "demo-manifest.json"));
    expect(manifestAfter.mtimeMs).toBe(manifestBefore.mtimeMs);

    // Status prints without throwing on a provisioned workspace.
    await printDemoStatus();

    // Reset deletes only the demo workspace; a sibling directory survives.
    const sibling = path.join(tempRoot, "not-the-demo");
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, "keep.txt"), "untouched", "utf8");
    await resetDemoWorkspace({ assumeYes: true });
    expect(existsSync(demoDir)).toBe(false);
    expect(existsSync(path.join(sibling, "keep.txt"))).toBe(true);
  }, 60000);
});
