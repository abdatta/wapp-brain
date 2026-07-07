import type { GuidedSetupSummary, LiveMaintainerStatusSummary, StatusSummary } from "../shared/types";

export function withGuidedSetup(status: StatusSummary): StatusSummary {
  return {
    ...status,
    setup: deriveGuidedSetup(status)
  };
}

export function deriveGuidedSetup(status: StatusSummary): GuidedSetupSummary {
  const live = status.live;
  const baseline = live?.baseline;
  const sessionStatus = live?.session?.status ?? "not_configured";
  const hasArchiveMessages = status.counts.messages > 0;
  const hasImport = Boolean(status.latestImport);
  // Only actionable gaps drive attention; grouped uncertainty is informational.
  const actionableGapCount = live?.gapGroups
    ? live.gapGroups.filter((group) => group.status !== "uncertain").reduce((sum, group) => sum + group.count, 0)
    : live?.openGapCount ?? 0;

  if (!hasArchiveMessages || !hasImport || baseline?.status === "missing_archive" || baseline?.status === "missing_messages") {
    return summary({
      state: "empty_archive",
      label: "Import your WhatsApp backup",
      description: "Start with an Android backup so live sync has a reliable baseline to catch up from.",
      primaryAction: "import_backup",
      phase: "backup",
      canImport: true,
      blockingReason: baseline?.warning ?? "No imported archive baseline exists yet."
    });
  }

  if (sessionStatus === "logged_out") {
    return summary({
      state: "logged_out",
      label: "Re-pair WhatsApp",
      description: "WhatsApp unlinked this device. Your archive is intact; re-pair from Linked devices to resume live sync.",
      primaryAction: "repair_link",
      phase: "live",
      canImport: true,
      canLink: true,
      canUnlink: true,
      blockingReason: live?.session?.lastError ?? "The linked device was logged out remotely."
    });
  }

  // A stale baseline blocks first-time linking only; an existing paired session
  // resumes and represents long downtime as honest gaps instead.
  if (baseline && !baseline.ready && baseline.status === "too_old" && sessionStatus === "not_configured") {
    return summary({
      state: "baseline_too_old",
      label: "Import a fresher backup",
      description: "The archive exists, but the latest message is outside the configured live recovery window.",
      primaryAction: "import_backup",
      phase: "archive",
      canImport: true,
      blockingReason: baseline.warning
    });
  }

  // Connection state always outranks gap review: a disconnected or pairing
  // session is the thing the user must fix first, and gap counts must never
  // mask it.
  if (sessionStatus === "pairing") {
    return summary({
      state: "linking",
      label: "Link WhatsApp",
      description: "Scan the QR code or enter the pairing code from WhatsApp Linked devices.",
      primaryAction: "link_whatsapp",
      phase: "live",
      canImport: true,
      canLink: true,
      canUnlink: true
    });
  }

  if (sessionStatus === "disconnected" || sessionStatus === "error") {
    return summary({
      state: "disconnected",
      label: "Reconnect live sync",
      description: live?.session?.lastError ?? "The linked live session is disconnected.",
      primaryAction: "reconnect",
      phase: "live",
      canImport: true,
      canLink: true,
      canUnlink: true,
      blockingReason: live?.session?.lastError ?? null
    });
  }

  if (sessionStatus === "connected" && actionableGapCount > 0) {
    return summary({
      state: "needs_attention",
      label: "Review live sync gaps",
      description: "Live sync is connected, but some chats still need recovery or a retry.",
      primaryAction: "review_gaps",
      phase: "live",
      canImport: true,
      canPause: true,
      canUnlink: true,
      blockingReason: `${actionableGapCount} live gap${actionableGapCount === 1 ? "" : "s"} need attention.`
    });
  }

  if (sessionStatus === "connected") {
    return summary({
      state: "syncing",
      label: "Live sync is active",
      description: "New WhatsApp data is being maintained locally from the linked read-only session.",
      primaryAction: "monitor_sync",
      phase: "live",
      canImport: true,
      canPause: true,
      canUnlink: true
    });
  }

  if (sessionStatus === "stopped") {
    return summary({
      state: "paused",
      label: "Live sync is paused",
      description: "The linked device credentials are present, but the maintainer is not running.",
      primaryAction: "resume_sync",
      phase: "live",
      canImport: true,
      canResume: true,
      canUnlink: true
    });
  }

  return summary({
    state: "baseline_ready_unlinked",
    label: "Link WhatsApp live sync",
    description: "Your imported backup is ready. Link WhatsApp next to keep the archive current.",
    primaryAction: "link_whatsapp",
    phase: "live",
    canImport: true,
    canLink: Boolean(baseline?.ready)
  });
}

function summary(overrides: Partial<GuidedSetupSummary> & Pick<GuidedSetupSummary, "state" | "label" | "description" | "primaryAction" | "phase">): GuidedSetupSummary {
  return {
    canImport: false,
    canLink: false,
    canPause: false,
    canResume: false,
    canUnlink: false,
    blockingReason: null,
    ...overrides
  };
}

export function activeLiveState(live: LiveMaintainerStatusSummary | null | undefined): "healthy" | "attention" | "blocked" | "idle" {
  const sessionStatus = live?.session?.status ?? "not_configured";
  if (sessionStatus === "logged_out") return "attention";
  if (!live?.baseline.ready && sessionStatus === "not_configured") return "blocked";
  const actionableGaps = live?.gapGroups
    ? live.gapGroups.filter((group) => group.status !== "uncertain").reduce((sum, group) => sum + group.count, 0)
    : live?.openGapCount ?? 0;
  if (actionableGaps > 0) return "attention";
  if (sessionStatus === "connected") return "healthy";
  return "idle";
}
