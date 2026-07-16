import type { PersonAutoConnectSummary, PersonScanStatus } from "../../shared/types";

// In-process freshness record for the People surface. The passes stamp it on
// every run (recovery tick, sync/import hooks, manual scans), so the UI can
// say "last scanned Xm ago" instead of leaving the user to wonder whether the
// list below is current. Deliberately in-memory: after a restart "not yet
// scanned this session" is the honest answer until the first tick fires.
const status: PersonScanStatus = {
  lastAutoConnectAtMs: null,
  lastAutoConnect: null,
  lastDetectorAtMs: null,
  lastDetectors: null
};

export function recordAutoConnectRun(summary: PersonAutoConnectSummary): void {
  status.lastAutoConnectAtMs = Date.now();
  status.lastAutoConnect = summary;
}

export function recordDetectorRun(summary: { created: number; updated: number }): void {
  status.lastDetectorAtMs = Date.now();
  status.lastDetectors = summary;
}

export function getPersonScanStatus(): PersonScanStatus {
  return {
    lastAutoConnectAtMs: status.lastAutoConnectAtMs,
    lastAutoConnect: status.lastAutoConnect ? { ...status.lastAutoConnect } : null,
    lastDetectorAtMs: status.lastDetectorAtMs,
    lastDetectors: status.lastDetectors ? { ...status.lastDetectors } : null
  };
}
