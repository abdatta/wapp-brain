import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDialogEnv,
  dialogSpecForKind,
  interpretPickOutput,
  isPickerAvailable,
  pickImportPath,
  resolveStartIn,
  setPickRunnerForTests
} from "../src/server/import/nativePicker";
import type { PickResult } from "../src/shared/types";

describe("nativePicker", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("maps each kind to a fixed dialog spec", () => {
    expect(dialogSpecForKind("backup-root").mode).toBe("folder");
    expect(dialogSpecForKind("media").mode).toBe("folder");
    expect(dialogSpecForKind("msgstore").mode).toBe("file");
    expect(dialogSpecForKind("wa").mode).toBe("file");
    expect(dialogSpecForKind("msgstore").filter).toContain(".crypt15");
  });

  it("passes parameters through environment variables, never inline", () => {
    const env = buildDialogEnv(dialogSpecForKind("msgstore"), "C:/backups");
    expect(env.WAPP_PICK_MODE).toBe("file");
    expect(env.WAPP_PICK_TITLE).toBeTruthy();
    expect(env.WAPP_PICK_FILTER).toContain(".crypt15");
    expect(env.WAPP_PICK_STARTIN).toBe("C:/backups");
    // Folder kinds carry no filter, and no start-in when none is given.
    expect(buildDialogEnv(dialogSpecForKind("backup-root")).WAPP_PICK_FILTER).toBeUndefined();
    expect(buildDialogEnv(dialogSpecForKind("backup-root")).WAPP_PICK_STARTIN).toBeUndefined();
  });

  it("interprets stdout as a path or a cancellation", () => {
    expect(interpretPickOutput("  D:/Backups/WhatsApp  ")).toEqual({ path: "D:/Backups/WhatsApp" });
    expect(interpretPickOutput("")).toEqual({ cancelled: true });
    expect(interpretPickOutput("\r\n")).toEqual({ cancelled: true });
  });

  it("validates the startIn hint against a real directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wapp-startin-"));
    const file = path.join(dir, "f.txt");
    await writeFile(file, "x");
    expect(resolveStartIn(dir)).toBe(dir);
    expect(resolveStartIn(file)).toBeUndefined();
    expect(resolveStartIn(path.join(dir, "missing"))).toBeUndefined();
    expect(resolveStartIn(null)).toBeUndefined();
  });

  it("reports availability honestly without an injected runner", () => {
    expect(isPickerAvailable()).toBe(process.platform === "win32");
  });

  it("returns the runner's result and is available once a runner is injected", async () => {
    restore = setPickRunnerForTests(async () => ({ path: "D:/picked" }));
    expect(isPickerAvailable()).toBe(true);
    await expect(pickImportPath("backup-root")).resolves.toEqual({ path: "D:/picked" });
  });

  it("is single-flight and non-blocking: a second pick returns busy while one is pending", async () => {
    let releaseFirst!: (result: PickResult) => void;
    restore = setPickRunnerForTests(() => new Promise<PickResult>((resolve) => {
      releaseFirst = resolve;
    }));
    const first = pickImportPath("backup-root");
    // The pending dialog must not block: this second call resolves immediately.
    await expect(pickImportPath("media")).resolves.toEqual({ unavailable: true, reason: "busy" });
    releaseFirst({ path: "D:/done" });
    await expect(first).resolves.toEqual({ path: "D:/done" });
  });
});
