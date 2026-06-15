import { describe, expect, it } from "vitest";
import type { LiveMaintainerStatusSummary, StatusSummary } from "../src/shared/types";
import { deriveGuidedSetup } from "../src/server/onboarding";

describe("premium onboarding state", () => {
  it("maps empty archives to import-first setup", () => {
    expect(deriveGuidedSetup(status({ messages: 0 })).state).toBe("empty_archive");
  });

  it("maps stale baselines to backup refresh", () => {
    expect(deriveGuidedSetup(status({ messages: 10, baselineStatus: "too_old" })).state).toBe("baseline_too_old");
  });

  it("maps ready unlinked baselines to link action", () => {
    const setup = deriveGuidedSetup(status({ messages: 10, baselineStatus: "ready" }));

    expect(setup.state).toBe("baseline_ready_unlinked");
    expect(setup.primaryAction).toBe("link_whatsapp");
    expect(setup.canLink).toBe(true);
  });

  it("maps pairing, active, paused, disconnected, and gap states distinctly", () => {
    expect(deriveGuidedSetup(status({ messages: 10, baselineStatus: "ready", sessionStatus: "pairing" })).state).toBe("linking");
    expect(deriveGuidedSetup(status({ messages: 10, baselineStatus: "ready", sessionStatus: "connected" })).state).toBe("syncing");
    expect(deriveGuidedSetup(status({ messages: 10, baselineStatus: "ready", sessionStatus: "stopped" })).state).toBe("paused");
    expect(deriveGuidedSetup(status({ messages: 10, baselineStatus: "ready", sessionStatus: "disconnected" })).state).toBe("disconnected");
    expect(deriveGuidedSetup(status({ messages: 10, baselineStatus: "ready", sessionStatus: "connected", openGapCount: 2 })).state).toBe(
      "needs_attention"
    );
  });
});

function status(options: {
  messages: number;
  baselineStatus?: LiveMaintainerStatusSummary["baseline"]["status"];
  sessionStatus?: NonNullable<LiveMaintainerStatusSummary["session"]>["status"];
  openGapCount?: number;
}): StatusSummary {
  const baselineReady = options.baselineStatus === "ready";
  const latestMessageAt = new Date().toISOString();
  return {
    database: { configured: true, initialized: true, adapter: "memory" },
    counts: { chats: options.messages ? 1 : 0, contacts: 0, participants: 0, messages: options.messages, warnings: 0 },
    latestImport: options.messages
      ? {
          id: "import-1",
          status: "completed",
          startedAt: latestMessageAt,
          finishedAt: latestMessageAt,
          totals: { chats: 1, contacts: 0, participants: 0, messages: options.messages, skipped: 0, warnings: 0 },
          warningCount: 0
        }
      : null,
    latestWarnings: [],
    live: {
      enabled: Boolean(options.sessionStatus),
      baseline: {
        ready: baselineReady,
        messageCount: options.messages,
        latestImportAt: latestMessageAt,
        latestMessageAt,
        maxBackfillDays: 14,
        status: options.baselineStatus ?? "missing_archive",
        warning: baselineReady ? null : "Import a WhatsApp backup before linking live sync."
      },
      session: options.sessionStatus
        ? {
            id: "default",
            status: options.sessionStatus,
            clientName: "baileys",
            linkedDeviceJid: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastError: null,
            createdAt: latestMessageAt,
            updatedAt: latestMessageAt
          }
        : null,
      currentRun: null,
      totals: { contacts: 0, chats: 0, participants: 0, messages: 0, updates: 0, gapsOpened: 0, gapsClosed: 0, warnings: 0 },
      openGapCount: options.openGapCount ?? 0,
      chatHealth: []
    }
  };
}
