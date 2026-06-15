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
  const hasOpenGaps = Boolean(live?.openGapCount);

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

  if (baseline && !baseline.ready && baseline.status === "too_old") {
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

  if (hasOpenGaps) {
    return summary({
      state: "needs_attention",
      label: "Review live sync gaps",
      description: "Live sync is connected, but some chats still need recovery or a retry.",
      primaryAction: "review_gaps",
      phase: "live",
      canImport: true,
      canPause: sessionStatus === "connected",
      canResume: sessionStatus === "stopped",
      canUnlink: sessionStatus !== "not_configured",
      blockingReason: `${live?.openGapCount ?? 0} live gap${live?.openGapCount === 1 ? "" : "s"} need attention.`
    });
  }

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
  if (!live?.baseline.ready) return "blocked";
  if (live.openGapCount > 0) return "attention";
  if (live.session?.status === "connected") return "healthy";
  return "idle";
}
