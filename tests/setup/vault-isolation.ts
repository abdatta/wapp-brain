// Global test isolation for every filesystem path the app projects into.
//
// `config.brain.rootDir` / `config.memory.*` default to the user's real work
// directory (`.wapp-brain/…`). Any test that commits an episode, repairs
// identity prose, or opens a pre-v2 database therefore wrote — or DELETED —
// files in the user's actual Obsidian vault. That is exactly what happened:
// the contract-v2 rebuild guard (which wipes every projected episode file)
// fires in a test that regresses the schema, so `npm test` silently emptied
// the user's episodes/ directory on every run, and concurrent test files
// racing on that shared directory produced intermittent failures.
//
// This setup runs before every test file, in every worker, so the default is
// isolation. Individual tests may still override config.brain.rootDir for
// their own assertions; they just no longer have to remember to.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { config } from "../../src/server/config";

const vaultRoot = mkdtempSync(path.join(os.tmpdir(), "wapp-test-vault-"));

Object.assign(config.brain, {
  rootDir: path.join(vaultRoot, "brain"),
  providerConfigPath: path.join(vaultRoot, "brain", "provider.json")
});
// The media store matters for the same reason: status excision is the first code
// path that UNLINKS content-addressed blobs, so an un-isolated test could delete
// real archived media — the one class of data the project must never lose.
Object.assign(config.media, {
  rootDir: path.join(vaultRoot, "media")
});
Object.assign(config.memory, {
  rootDir: path.join(vaultRoot, "memory"),
  pagesDir: path.join(vaultRoot, "memory", "pages"),
  citationsDir: path.join(vaultRoot, "memory", "citations"),
  runsDir: path.join(vaultRoot, "memory", "runs"),
  providerConfigPath: path.join(vaultRoot, "memory", "provider.json")
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});
