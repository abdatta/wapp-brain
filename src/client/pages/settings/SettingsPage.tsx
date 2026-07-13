import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { cleanupTempFiles, initDatabase, retryLiveGap, retryStuckMedia, stopLiveSession, unlinkLiveSession } from "../../api";
import { LivePanel, StatusPanel } from "../../panels";
import { useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

// Settings surface: archive maintenance (init / cleanup, counts) and live-sync
// session management (link/pause/resume/unlink, gaps, media retry). The
// link/resume pairing flow is owned by the status provider so it is reachable
// from the onboarding banner too; the pairing modal renders from the shell.
export function SettingsPage() {
  const navigate = useNavigate();
  const { setNotice, setError } = useToast();
  const { status, statusError, setStatus, refreshStatus, liveGaps, refreshLiveGaps, liveProgress, openLink, openResume } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);

  async function handleInit() {
    setBusy("Initializing database");
    setError(null);
    try {
      const result = await initDatabase();
      setStatus(result.status);
      setNotice("Archive database initialized.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not initialize database.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCleanup() {
    setBusy("Cleaning temp files");
    setError(null);
    try {
      const result = await cleanupTempFiles();
      setNotice(`Cleanup complete: ${result.summary.removedFiles.toLocaleString()} files removed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRetryGap(id: number) {
    setBusy("Retrying live gap");
    setError(null);
    try {
      const result = await retryLiveGap(id);
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      await refreshLiveGaps();
      setNotice(`Live gap ${id} scheduled for retry.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry live gap.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRetryMedia() {
    setBusy("Retrying media downloads");
    setError(null);
    try {
      const result = await retryStuckMedia();
      setNotice(
        result.requeued
          ? `${result.requeued.toLocaleString()} media download(s) queued for retry.`
          : "No stuck media downloads were eligible for retry."
      );
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry media downloads.");
    } finally {
      setBusy(null);
    }
  }

  async function handleStopLive() {
    setBusy("Pausing live sync");
    setError(null);
    try {
      const result = await stopLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      await refreshStatus();
      setNotice("Live sync paused. Your linked device state is kept locally.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pause live sync.");
    } finally {
      setBusy(null);
    }
  }

  async function handleUnlinkLive() {
    if (!window.confirm("Unlinking removes local live credentials. You will need to scan or pair WhatsApp again.")) {
      return;
    }
    setBusy("Unlinking live session");
    setError(null);
    try {
      const result = await unlinkLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      await refreshStatus();
      await refreshLiveGaps();
      setNotice("Live session state removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink live session.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settingsPage">
      <div className="toolHeader">
        <span className="eyebrow">Settings</span>
        <p>Local archive maintenance and WhatsApp live-sync session management.</p>
      </div>
      <StatusPanel
        status={status}
        statusError={statusError}
        busy={busy}
        onInit={() => void handleInit()}
        onCleanup={() => void handleCleanup()}
      />
      <LivePanel
        status={status}
        gaps={liveGaps}
        busy={busy}
        progress={liveProgress}
        onImport={() => navigate("/import")}
        onLink={() => void openLink()}
        onRetryGap={(id) => void handleRetryGap(id)}
        onRetryMedia={() => void handleRetryMedia()}
        onPause={() => void handleStopLive()}
        onResume={() => void openResume()}
        onUnlink={() => void handleUnlinkLive()}
      />
    </div>
  );
}
