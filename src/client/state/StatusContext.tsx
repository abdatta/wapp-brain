import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type {
  ArchiveChangeEvent,
  BrainOverview,
  BrainRunProgress,
  LiveGapWindowRecord,
  LivePairingSummary,
  LiveSyncProgress,
  SearchIndexStatus,
  SearchReindexProgress,
  StatusSummary
} from "../../shared/types";
import {
  getBrainOverview,
  getBrainRunProgress,
  getLivePairing,
  getLiveProgress,
  getSearchStatus,
  getStatus,
  linkLiveSession,
  listLiveGaps,
  resumeLiveSession
} from "../api";
import { useToast } from "./ToastContext";

// The single home for cross-cutting live state. It owns the one SSE connection
// to /api/archive/events plus the status / brain-run / reindex / live-progress
// polls that must run regardless of which surface is visible, so a background
// job's progress and completion toast follow the user across routes. Pages read
// values through useStatus() and subscribe to archive changes through
// useArchiveEvents(); page-local state stays in the pages.
type ArchiveListener = (change: ArchiveChangeEvent) => void;

interface StatusContextValue {
  status: StatusSummary | null;
  statusError: string | null;
  setStatus: Dispatch<SetStateAction<StatusSummary | null>>;
  refreshStatus: () => Promise<void>;
  liveGaps: LiveGapWindowRecord[];
  refreshLiveGaps: () => Promise<void>;
  liveProgress: LiveSyncProgress | null;
  brainOverview: BrainOverview | null;
  setBrainOverview: Dispatch<SetStateAction<BrainOverview | null>>;
  refreshBrainOverview: () => Promise<void>;
  brainRun: BrainRunProgress | null;
  setBrainRun: Dispatch<SetStateAction<BrainRunProgress | null>>;
  // Live-session link/pairing flow, owned here because it is triggered from both
  // the shell's onboarding banner and the settings live panel.
  pairing: LivePairingSummary | null;
  pairingOpen: boolean;
  openLink: () => Promise<void>;
  openResume: () => Promise<void>;
  closePairing: () => void;
  searchIndex: SearchIndexStatus | null;
  setSearchIndex: Dispatch<SetStateAction<SearchIndexStatus | null>>;
  reindexProgress: SearchReindexProgress | null;
  setReindexProgress: Dispatch<SetStateAction<SearchReindexProgress | null>>;
  refreshSearchStatus: () => Promise<void>;
  subscribeArchive: (listener: ArchiveListener) => () => void;
}

const StatusContext = createContext<StatusContextValue | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const { setNotice, setError } = useToast();
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [liveGaps, setLiveGaps] = useState<LiveGapWindowRecord[]>([]);
  const [liveProgress, setLiveProgress] = useState<LiveSyncProgress | null>(null);
  const [brainOverview, setBrainOverview] = useState<BrainOverview | null>(null);
  const [brainRun, setBrainRun] = useState<BrainRunProgress | null>(null);
  const [searchIndex, setSearchIndex] = useState<SearchIndexStatus | null>(null);
  const [reindexProgress, setReindexProgress] = useState<SearchReindexProgress | null>(null);
  const [pairing, setPairing] = useState<LivePairingSummary | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);

  const refreshLiveGaps = useCallback(async () => {
    setLiveGaps(await listLiveGaps().catch(() => []));
  }, []);

  const refreshBrainOverview = useCallback(async () => {
    await getBrainOverview()
      .then(setBrainOverview)
      .catch(() => undefined);
  }, []);

  const refreshSearchStatus = useCallback(async () => {
    await getSearchStatus()
      .then((search) => {
        setSearchIndex(search.index);
        setReindexProgress(search.reindex);
      })
      .catch(() => undefined);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatusError(null);
      const next = await getStatus();
      setStatus(next);
      setLiveGaps(await listLiveGaps().catch(() => []));
      // Discover index/job state independently of the search surface, so a build
      // started earlier (or before a page reload) stays visible.
      void refreshSearchStatus();
      void refreshBrainOverview();
      getBrainRunProgress()
        .then(setBrainRun)
        .catch(() => undefined);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Status unavailable.");
    }
  }, [refreshSearchStatus, refreshBrainOverview]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Poll reindex progress while the job runs; completion flips the index state.
  useEffect(() => {
    if (!reindexProgress || (reindexProgress.state !== "running" && reindexProgress.state !== "finalizing")) {
      return;
    }
    const timer = window.setInterval(() => {
      getSearchStatus()
        .then((next) => {
          setReindexProgress(next.reindex);
          setSearchIndex(next.index);
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [reindexProgress?.state]);

  // Failures are never silent: a failed index build raises the global error
  // toast no matter which surface the user is on.
  useEffect(() => {
    if (reindexProgress?.state === "failed") {
      setError(
        `Search index build failed${reindexProgress.error ? `: ${reindexProgress.error}` : "."} Retry from the search surface.`
      );
    }
  }, [reindexProgress?.state, setError]);

  // Poll brain-run progress while one executes; refresh coverage when done and
  // surface the outcome as a toast that persists across surfaces.
  useEffect(() => {
    if (brainRun?.state !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      getBrainRunProgress()
        .then((next) => {
          setBrainRun(next);
          if (next.state !== "running") {
            getBrainOverview().then(setBrainOverview).catch(() => undefined);
            if (next.state === "failed") {
              setError(`Brain run failed${next.error ? `: ${next.error}` : "."}`);
            } else if (next.state === "budget_exceeded") {
              setNotice("Brain run stopped at its model-call budget; remaining backlog stays pending.");
            } else if (next.state === "interrupted") {
              setNotice(`Brain run interrupted: ${next.episodesCommitted} episodes kept; remaining backlog stays pending.`);
            } else if (next.state === "completed") {
              const extractiveNote =
                next.extractiveEpisodes > 0 ? `, ${next.extractiveEpisodes}/${next.episodesCommitted} extractive` : "";
              setNotice(`Brain run completed: ${next.episodesCommitted} episodes (${next.claimsCommitted} claims${extractiveNote}).`);
            }
          }
        })
        .catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [brainRun?.state, setError, setNotice]);

  // Poll live sync progress only while a session is connected.
  useEffect(() => {
    if (status?.live?.session?.status !== "connected") {
      setLiveProgress(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      getLiveProgress()
        .then((next) => {
          if (!cancelled) setLiveProgress(next);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.live?.session?.status]);

  const openLink = useCallback(async () => {
    try {
      const result = await linkLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      setPairing(result.pairing);
      setPairingOpen(true);
      setNotice("Live pairing started locally.");
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start live pairing.");
    }
  }, [refreshStatus, setNotice, setError]);

  const openResume = useCallback(async () => {
    try {
      const result = await resumeLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      setPairing(result.pairing);
      setPairingOpen(true);
      setNotice("Live sync resume started.");
      void refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume live sync.");
    }
  }, [refreshStatus, setNotice, setError]);

  const closePairing = useCallback(() => setPairingOpen(false), []);

  // Poll pairing state while the pairing modal is open; a connected result
  // refreshes status so the rest of the app reflects the linked session.
  useEffect(() => {
    if (!pairingOpen) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      getLivePairing()
        .then((next) => {
          if (!cancelled) {
            setPairing(next);
            if (next.state === "connected") {
              void refreshStatus();
            }
          }
        })
        .catch(() => undefined);
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pairingOpen, refreshStatus]);

  // One SSE connection for the whole app. On an archive change we throttle a
  // status refresh (status queries are real work on the server) and notify page
  // subscribers with the triggering change so a page (chats) can refresh its own
  // list / follow the open thread without the provider knowing page state.
  const listenersRef = useRef(new Set<ArchiveListener>());
  const subscribeArchive = useCallback((listener: ArchiveListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/archive/events");
    let refreshTimer: number | null = null;

    const scheduleRefresh = (change: ArchiveChangeEvent) => {
      if (refreshTimer != null) {
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshStatus();
        for (const listener of listenersRef.current) {
          listener(change);
        }
        // 1s throttle: initial history sync fires many archive events per second.
      }, 1000);
    };

    events.addEventListener("archive-updated", (event) => {
      try {
        scheduleRefresh(JSON.parse((event as MessageEvent).data) as ArchiveChangeEvent);
      } catch {
        // Ignore malformed local stream messages; the browser keeps the stream alive.
      }
    });

    return () => {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      events.close();
    };
  }, [refreshStatus]);

  const value = useMemo<StatusContextValue>(
    () => ({
      status,
      statusError,
      setStatus,
      refreshStatus,
      liveGaps,
      refreshLiveGaps,
      liveProgress,
      brainOverview,
      setBrainOverview,
      refreshBrainOverview,
      brainRun,
      setBrainRun,
      pairing,
      pairingOpen,
      openLink,
      openResume,
      closePairing,
      searchIndex,
      setSearchIndex,
      reindexProgress,
      setReindexProgress,
      refreshSearchStatus,
      subscribeArchive
    }),
    [
      status,
      statusError,
      refreshStatus,
      liveGaps,
      refreshLiveGaps,
      liveProgress,
      brainOverview,
      refreshBrainOverview,
      brainRun,
      pairing,
      pairingOpen,
      openLink,
      openResume,
      closePairing,
      searchIndex,
      reindexProgress,
      refreshSearchStatus,
      subscribeArchive
    ]
  );

  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useStatus(): StatusContextValue {
  const value = useContext(StatusContext);
  if (!value) {
    throw new Error("useStatus must be used within a StatusProvider");
  }
  return value;
}

// Subscribe to archive-updated SSE events for the lifetime of the calling
// component. Re-subscribes when `listener` identity changes, so wrap page
// handlers in useCallback with the right deps to avoid stale closures.
export function useArchiveEvents(listener: ArchiveListener): void {
  const { subscribeArchive } = useStatus();
  useEffect(() => subscribeArchive(listener), [subscribeArchive, listener]);
}
