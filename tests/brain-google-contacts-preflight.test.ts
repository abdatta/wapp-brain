import { describe, expect, it, vi } from "vitest";
import { getBrainRunProgress, startBrainRun } from "../src/server/brain/runJob";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";

async function waitForBrain(): Promise<void> {
  await vi.waitFor(() => expect(getBrainRunProgress().state).not.toBe("running"), { timeout: 2_000 });
}

describe("brain Google Contacts freshness boundary", () => {
  it("finishes contact sync before creating the brain run or reading backlog", async () => {
    const repository = new MemoryArchiveRepository();
    const events: string[] = [];
    const originalStart = repository.startBrainRun.bind(repository);
    const originalBacklog = repository.getBrainChatBacklog.bind(repository);
    repository.startBrainRun = async (...args) => { events.push("run"); return originalStart(...args); };
    repository.getBrainChatBacklog = async (...args) => { events.push("backlog"); return originalBacklog(...args); };
    expect(startBrainRun(repository, { mode: "extractive" }, undefined, async () => { events.push("contacts"); }).started).toBe(true);
    await waitForBrain();
    expect(events.slice(0, 3)).toEqual(["contacts", "run", "backlog"]);
    expect(getBrainRunProgress().state).toBe("completed");
  });

  it("keeps disconnected brain runs unchanged when no preflight is supplied", async () => {
    const repository = new MemoryArchiveRepository();
    const backlog = vi.spyOn(repository, "getBrainChatBacklog");
    expect(startBrainRun(repository, { mode: "extractive" }).started).toBe(true);
    await waitForBrain();
    expect(backlog).toHaveBeenCalledOnce();
    expect(getBrainRunProgress().state).toBe("completed");
  });

  it("does not create a run or read backlog when connected contact sync fails", async () => {
    const repository = new MemoryArchiveRepository();
    const start = vi.spyOn(repository, "startBrainRun");
    const backlog = vi.spyOn(repository, "getBrainChatBacklog");
    expect(startBrainRun(repository, { mode: "extractive" }, undefined, async () => { throw new Error("Google Contacts is temporarily unavailable."); }).started).toBe(true);
    await waitForBrain();
    expect(start).not.toHaveBeenCalled();
    expect(backlog).not.toHaveBeenCalled();
    expect(getBrainRunProgress()).toMatchObject({ state: "failed", error: "Google Contacts is temporarily unavailable." });
  });
});
