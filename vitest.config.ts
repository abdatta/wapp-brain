import { defineConfig } from "vitest/config";

// The setup file redirects every vault/projection path at a per-worker temp
// directory. Without it, tests write and delete files in the user's REAL
// `.wapp-brain` vault (see tests/setup/vault-isolation.ts for the incident
// this prevents).
export default defineConfig({
  test: {
    setupFiles: ["./tests/setup/vault-isolation.ts"]
  }
});
