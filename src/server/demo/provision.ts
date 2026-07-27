// Demo workspace provisioning: one command takes an empty checkout to a
// browsable, populated demo instance using only the real pipelines — the
// curated fixture is imported by the real importer, the brain pass is the real
// extractive assimilation, and the search index is the real index build. No
// model calls, no external side effects, and never a byte outside the demo
// workspace (config.demo guarantees every path already points there).

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config";
import { createArchiveRepository } from "../db/archive";
import type { ArchiveRepository } from "../db/repository";
import { createDemoFixture } from "../import/fixtures";
import { runImport } from "../import/importer";
import { ImportTerminalProgress } from "../import/progress";

// Bump when the curated fixture changes meaningfully; `demo status` shows it
// and a stale manifest is a hint to `demo reset`.
export const DEMO_FIXTURE_VERSION = 1;

// The demo archive's owner ("me" in episodes and search) — part of the same
// fictional universe as the fixture contacts.
const DEMO_OWNER_NAME = "Jordan Lee";

function manifestPath(): string {
  return path.join(config.workDir, "demo-manifest.json");
}

function assertDemoMode(): void {
  // Belt and braces before any destructive or workspace-creating step: these
  // helpers only ever run under the demo pivot.
  if (!config.demo) {
    throw new Error("Demo provisioning invoked without WAPP_DEMO — refusing to touch a non-demo workspace.");
  }
}

async function demoArchiveMessageCount(repository: ArchiveRepository): Promise<number> {
  const status = await repository.getStatus();
  return status.counts.messages;
}

export async function provisionDemoWorkspaceIfNeeded(): Promise<void> {
  assertDemoMode();
  const repository = createArchiveRepository();
  try {
    const existing = await demoArchiveMessageCount(repository);
    if (existing > 0) {
      console.log(`Demo workspace ready (${existing} messages) — skipping provisioning. Use \`npm run demo:reset\` to rebuild.`);
      return;
    }

    console.log(`Provisioning demo workspace at ${path.resolve(config.workDir)}`);
    console.log("[1/4] Generating the curated synthetic backup…");
    const fixture = await createDemoFixture(path.join(config.workDir, "source"));

    console.log("[2/4] Importing it with the real importer…");
    const progress = new ImportTerminalProgress();
    const totals = await runImport(
      repository,
      { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath },
      { onProgress: (event) => progress.handle(event) }
    );
    console.log(`      Imported ${totals.messages} messages across ${totals.chats} chats (${totals.contacts} contacts).`);

    console.log("[3/4] Running the extractive brain pass (no model, no external calls)…");
    await repository.setArchiveOwnerName(DEMO_OWNER_NAME);
    const { runBrainMaintenancePass } = await import("../brain/scheduler");
    const pass = await runBrainMaintenancePass(repository, { force: true });
    const episodes = await repository.listBrainEpisodes({ limit: 100 });
    console.log(
      pass.ran
        ? `      Brain pass complete — ${episodes.length} episode(s) committed.`
        : `      Brain pass skipped (${pass.reason}); episodes: ${episodes.length}.`
    );

    console.log("[4/4] Building the search index…");
    const index = await repository.rebuildSearchIndex();
    console.log(`      Indexed ${index.indexedMessages} messages.`);

    const manifest = {
      fixtureVersion: DEMO_FIXTURE_VERSION,
      owner: DEMO_OWNER_NAME,
      counts: { chats: totals.chats, contacts: totals.contacts, messages: totals.messages, episodes: episodes.length }
    };
    await writeFile(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log("Demo workspace provisioned.");
  } finally {
    await repository.close?.();
  }
}

export async function printDemoStatus(): Promise<void> {
  assertDemoMode();
  if (!existsSync(config.archive.sqlitePath)) {
    console.log(`Demo workspace not provisioned (no archive at ${config.archive.sqlitePath}). Run \`npm run demo\`.`);
    return;
  }
  const repository = createArchiveRepository();
  try {
    const status = await repository.getStatus();
    const episodes = await repository.listBrainEpisodes({ limit: 500 });
    let manifest: string | null = null;
    try {
      manifest = (await readFile(manifestPath(), "utf8")).trim();
    } catch {
      manifest = null;
    }
    console.log(`Demo workspace: ${path.resolve(config.workDir)}`);
    console.log(
      `Archive: ${status.counts.messages} messages, ${status.counts.chats} chats, ${status.counts.contacts} contacts; episodes: ${episodes.length}.`
    );
    console.log(manifest ? `Manifest: ${manifest}` : "Manifest: missing (older provisioning or partial state).");
  } finally {
    await repository.close?.();
  }
}

export async function resetDemoWorkspace(options: { assumeYes: boolean }): Promise<void> {
  assertDemoMode();
  const target = path.resolve(config.workDir);
  if (!existsSync(target)) {
    console.log(`Nothing to reset — ${target} does not exist.`);
    return;
  }
  if (!options.assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Delete the demo workspace at ${target}? Only demo data is removed. [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Reset cancelled.");
      return;
    }
  }
  await rm(target, { recursive: true, force: true });
  console.log(`Demo workspace removed: ${target}`);
}

export async function assertDistBuilt(): Promise<boolean> {
  const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist");
  if (existsSync(path.join(distDir, "index.html"))) {
    return true;
  }
  console.error("The client build is missing (dist/index.html). Run `npm run build` once, then `npm run demo` again.");
  console.error("(For development against demo data, `WAPP_DEMO=1 npm run dev` with APP_PORT=3600 also works.)");
  return false;
}
