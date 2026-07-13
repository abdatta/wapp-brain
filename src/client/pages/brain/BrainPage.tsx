import { useState } from "react";
import type { BrainProviderName, MemoryCitationResolution, MemoryQueryResult } from "../../../shared/types";
import {
  brainProviderAction,
  disableMemoryProvider,
  enableCodexMemoryProvider,
  queryMemory,
  resetBrainData,
  resolveMemoryCitation,
  setBrainOwner,
  startBrainRun,
  startMemoryRun
} from "../../api";
import { BrainPanel, MemoryPanel } from "../../panels";
import { useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

// The brain surface: coverage/runs/provider control (BrainPanel) plus the
// second-brain memory panel, which is slated for teardown (change #15) and lives
// here as a section until then. Run progress and completion toasts are owned by
// the status provider so they persist across surfaces.
export function BrainPage() {
  const { setNotice, setError } = useToast();
  const { status, refreshStatus, brainOverview, setBrainOverview, refreshBrainOverview, brainRun, setBrainRun } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryResult, setMemoryResult] = useState<MemoryQueryResult | null>(null);
  const [memoryCitation, setMemoryCitation] = useState<MemoryCitationResolution | null>(null);

  async function handleBrainProviderAction(body: {
    action: "enable" | "disable" | "probe" | "set-model";
    provider?: Exclude<BrainProviderName, "extractive">;
    model?: string;
  }) {
    setBusy(body.action === "probe" ? "Probing brain provider" : "Updating brain provider");
    setError(null);
    try {
      const response = await brainProviderAction(body);
      setBrainOverview((current) => (current ? { ...current, provider: response.provider } : current));
      if (body.action === "probe") {
        if (response.ok) {
          setNotice("Provider probe succeeded — the model answered end-to-end.");
        } else {
          setError(`Provider probe failed: ${response.provider.health.lastError ?? response.provider.message}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Provider action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleStartBrainRun(body: { mode: "model" | "extractive"; model?: string | null; maxChats?: number }) {
    setError(null);
    try {
      const response = await startBrainRun({ ...body, maxChats: body.maxChats ?? 10 });
      setBrainRun(response.progress);
      setNotice("Brain run started — progress shows below and in the nav.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the brain run.");
    }
  }

  async function handleSetBrainOwner(displayName: string | null) {
    setError(null);
    try {
      await setBrainOwner(displayName);
      setNotice(
        displayName
          ? `Saved: your messages will be labeled "${displayName} (me)" in new episodes. Run a search reindex to apply it to historical search results.`
          : "Owner name cleared."
      );
      void refreshBrainOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your name.");
    }
  }

  async function handleResetBrain() {
    if (
      !window.confirm(
        "Reset all brain data? This deletes every generated episode, claim, citation, and coverage watermark (raw messages are untouched). The next run re-assimilates from scratch."
      )
    ) {
      return;
    }
    setError(null);
    try {
      const result = await resetBrainData();
      setNotice(`Brain reset: ${result.episodesRemoved} episode(s) and ${result.filesRemoved} file(s) removed; coverage back to zero.`);
      void refreshBrainOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset brain data.");
    }
  }

  async function handleMemoryRun(dryRun = false) {
    setBusy(dryRun ? "Previewing memory" : "Running memory REM");
    setError(null);
    try {
      const result = await startMemoryRun({ kind: "rem", dryRun });
      setNotice(
        dryRun
          ? `Memory evidence preview ready for ${result.result.run.messageCount.toLocaleString()} messages.`
          : `Memory run ${result.result.run.status}: ${result.result.run.pageCount.toLocaleString()} pages, ${result.result.run.citationCount.toLocaleString()} citations.`
      );
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memory run failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleMemoryQuery() {
    if (!memoryQuery.trim()) {
      return;
    }
    setBusy("Searching memory");
    setError(null);
    try {
      setMemoryResult(await queryMemory(memoryQuery));
      setMemoryCitation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memory query failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleOpenMemoryCitation(citation: string) {
    setBusy("Opening citation");
    setError(null);
    try {
      setMemoryCitation(await resolveMemoryCitation(citation));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open citation.");
    } finally {
      setBusy(null);
    }
  }

  async function handleEnableCodexMemory() {
    setBusy("Enabling Codex memory");
    setError(null);
    try {
      await enableCodexMemoryProvider();
      await refreshStatus();
      setNotice("Codex session opt-in enabled. Memory pages stay extractive; the session powers brain model runs (run the CLI login if none exists).");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable Codex memory.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDisableMemoryProvider() {
    setBusy("Disabling remote memory");
    setError(null);
    try {
      await disableMemoryProvider();
      await refreshStatus();
      setNotice("Remote memory provider disabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disable remote memory.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="brainPage">
      <BrainPanel
        overview={brainOverview}
        run={brainRun}
        busy={busy}
        onProviderAction={(body) => void handleBrainProviderAction(body)}
        onRun={(body) => void handleStartBrainRun(body)}
        onSetOwner={(displayName) => void handleSetBrainOwner(displayName)}
        onReset={() => void handleResetBrain()}
      />
      <MemoryPanel
        status={status}
        busy={busy}
        query={memoryQuery}
        result={memoryResult}
        citation={memoryCitation}
        onQueryChange={setMemoryQuery}
        onRun={() => void handleMemoryRun(false)}
        onPreview={() => void handleMemoryRun(true)}
        onQuery={() => void handleMemoryQuery()}
        onOpenCitation={(citation) => void handleOpenMemoryCitation(citation)}
        onEnableCodex={() => void handleEnableCodexMemory()}
        onDisableProvider={() => void handleDisableMemoryProvider()}
      />
    </div>
  );
}
