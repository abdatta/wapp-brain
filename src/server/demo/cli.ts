// Demo-mode entry point (`npm run demo`). The demo flag MUST be set before
// any app module loads — config resolves the demo workspace pivot at import
// time — so this file has no static app imports and pulls everything in
// dynamically after the flag is set.
process.env.WAPP_DEMO = "1";

const [command, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === "reset") {
    const { resetDemoWorkspace } = await import("./provision");
    await resetDemoWorkspace({ assumeYes: rest.includes("--yes") });
    return;
  }
  if (command === "status") {
    const { printDemoStatus } = await import("./provision");
    await printDemoStatus();
    return;
  }
  if (command !== undefined) {
    console.error(`Unknown demo command: ${command}. Usage: demo [status | reset [--yes]]`);
    process.exitCode = 1;
    return;
  }
  const { assertDistBuilt, provisionDemoWorkspaceIfNeeded } = await import("./provision");
  await provisionDemoWorkspaceIfNeeded();
  if (!(await assertDistBuilt())) {
    process.exitCode = 1;
    return;
  }
  const { config } = await import("../config");
  const path = await import("node:path");
  console.log(`Demo mode: synthetic workspace ${path.resolve(config.workDir)} — the real workspace is never read or written.`);
  console.log(`Demo UI: http://${config.app.host}:${config.app.port}`);
  // The server module listens at import time, against the demo workspace.
  await import("../server");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
