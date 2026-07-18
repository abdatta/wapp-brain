import { useCallback, useEffect, useState } from "react";
import type { BrainGraphStats, BrainProviderName, MemoryCitationResolution, MemoryQueryResult } from "../../../shared/types";
import {
  brainProviderAction,
  disableMemoryProvider,
  enableCodexMemoryProvider,
  getBrainGraphStats,
  getOwnerIdentitySuggestions,
  queryMemory,
  rebuildBrainGraph,
  recomputeBrainGraph,
  resetBrainData,
  resolveMemoryCitation,
  setBrainOwner,
  startBrainRegenerate,
  startBrainRun,
  startMemoryRun
} from "../../api";
import { BrainPanel, MemoryPanel, RunConsoleModal } from "../../panels";
import { useArchiveEvents, useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

// Knowledge-graph strip (knowledge-graph-foundation): counts by kind, dormancy
// state, and the two deterministic maintenance jobs. Everything here is zero
// model calls; rebuild replays committed episodes, so it is safe to run any
// time a brain run is not writing. The full explorer surface is a later change
// (graph-explorer) — this is the substrate's health line.
function BrainGraphSection({ running }: { running: boolean }) {
  const { setNotice, setError } = useToast();
  const [stats, setStats] = useState<BrainGraphStats | null>(null);
  const [graphBusy, setGraphBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(await getBrainGraphStats());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load graph stats.");
    }
  }, []);

  // Stay current without a reload: mount and every run-terminal transition
  // re-fetch (a finishing run just committed graph rows in its transactions),
  // and the archive-updated SSE covers reset/regenerate/import — the same
  // 1s-throttled stream the rest of the app refreshes on.
  useEffect(() => {
    if (!running) {
      void refresh();
    }
  }, [running, refresh]);
  useArchiveEvents(useCallback(() => void refresh(), [refresh]));

  async function handleRebuild() {
    setGraphBusy("Rebuilding the knowledge graph");
    setError(null);
    try {
      const result = await rebuildBrainGraph();
      setNotice(
        `Graph rebuilt: ${result.nodes.toLocaleString()} nodes, ${result.edges.toLocaleString()} edges from ${result.episodesReplayed.toLocaleString()} episode(s) in ${(result.durationMs / 1000).toFixed(1)}s — no model calls.`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Graph rebuild failed.");
    } finally {
      setGraphBusy(null);
    }
  }

  async function handleRecompute() {
    setGraphBusy("Recomputing salience");
    setError(null);
    try {
      const result = await recomputeBrainGraph();
      setNotice(
        `Salience recomputed over ${result.nodes.toLocaleString()} nodes: ${result.dormant} newly dormant, ${result.revived} revived, ${result.exemptOpenLifecycle} open commitment(s)/question(s) kept awake.`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salience recompute failed.");
    } finally {
      setGraphBusy(null);
    }
  }

  const persons = stats?.nodesByKind.person ?? 0;
  const topics = stats?.nodesByKind.topic ?? 0;
  const dormant = stats?.nodesByStatus.dormant ?? 0;
  // Until the first stats answer arrives, values are UNKNOWN — shimmer, never
  // placeholder zeros that read as data.
  const loading = !stats && !loadError;
  const metricValue = (text: string) => (loading ? <strong className="metricSkeleton" aria-label="loading" /> : <strong>{text}</strong>);
  return (
    <section className="memoryPanel">
      <div className="panelToggle" role="heading" aria-level={2}>
        <span className="panelTitle">
          <span>Knowledge graph</span>
        </span>
      </div>
      {loadError ? (
        <div className="brainDueAlert">
          <span>Graph stats unavailable: {loadError}</span>
        </div>
      ) : (
        <>
          <div className="statusGrid">
            <div className="metric" title="Typed nodes derived from claim entities, chats, topics, and lifecycle claims">
              <span>Nodes</span>
              {metricValue((stats?.nodeCount ?? 0).toLocaleString())}
            </div>
            <div className="metric" title="Typed edges — every one traceable to its citing claims, messages, or captured signals">
              <span>Edges</span>
              {metricValue((stats?.edgeCount ?? 0).toLocaleString())}
            </div>
            <div className="metric" title={`People (${persons.toLocaleString()}) and topics (${topics.toLocaleString()}) in the graph`}>
              <span>People · topics</span>
              {metricValue(`${persons.toLocaleString()} · ${topics.toLocaleString()}`)}
            </div>
            <div className="metric" title="Open commitments and questions — exempt from dormancy until closed">
              <span>Open commitments</span>
              {metricValue((stats?.openLifecycleNodes ?? 0).toLocaleString())}
            </div>
            {(stats?.unresolvedPersonNodes ?? 0) > 0 && (
              <div className="metric" title="Chat-scoped people the model named but pack-local resolution could not anchor to an identity">
                <span>Unresolved entities</span>
                <strong>{(stats?.unresolvedPersonNodes ?? 0).toLocaleString()}</strong>
              </div>
            )}
            {dormant > 0 && (
              <div className="metric" title="Low-salience nodes hidden from ranked surfaces — still searchable, never deleted">
                <span>Dormant</span>
                <strong>{dormant.toLocaleString()}</strong>
              </div>
            )}
          </div>
          <div className="brainHint">
            {loading ? (
              <span className="metricSkeleton lineSkeleton short" aria-label="loading" />
            ) : stats && stats.nodeCount === 0 ? (
              "No graph yet — Rebuild derives it from committed episodes and captured signals with zero model calls."
            ) : (
              `Salience last recomputed ${stats?.lastRecomputeAt ? new Date(stats.lastRecomputeAt).toLocaleString() : "never"}.`
            )}
          </div>
          <div className="brainProviderControls">
            <button
              className="primaryButton"
              type="button"
              disabled={Boolean(graphBusy) || running || loading}
              title={
                loading
                  ? "Waiting for graph stats…"
                  : "Wipe and re-derive the whole graph from current model episodes + captured signals (deterministic, no model calls)"
              }
              onClick={() => void handleRebuild()}
            >
              {graphBusy === "Rebuilding the knowledge graph" ? "Rebuilding…" : "Rebuild graph"}
            </button>
            <button
              className="miniButton"
              type="button"
              disabled={Boolean(graphBusy) || running || loading}
              title={loading ? "Waiting for graph stats…" : "Recompute evidence-derived salience and dormancy (open commitments never go dormant)"}
              onClick={() => void handleRecompute()}
            >
              {graphBusy === "Recomputing salience" ? "Recomputing…" : "Recompute salience"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// The brain surface: coverage/runs/provider control (BrainPanel) plus the
// second-brain memory panel, which is slated for teardown (change #15) and lives
// here as a section until then. Run progress and completion toasts are owned by
// the status provider so they persist across surfaces.
export function BrainPage() {
  const { setNotice, setError } = useToast();
  const { status, refreshStatus, brainOverview, setBrainOverview, refreshBrainOverview, brainRun, setBrainRun } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
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

  async function handleStartBrainRun(body: {
    mode: "model" | "extractive";
    model?: string | null;
    maxChats?: number;
    maxModelCalls?: number;
    maxTokens?: number | null;
  }): Promise<boolean> {
    setError(null);
    try {
      const response = await startBrainRun({ ...body, maxChats: body.maxChats ?? 10 });
      setBrainRun(response.progress);
      setNotice("Brain run started — progress shows below and in the nav.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the brain run.");
      return false;
    }
  }

  async function handleStartBrainRegenerate(body: { model?: string | null }): Promise<boolean> {
    setError(null);
    try {
      const response = await startBrainRegenerate(body);
      setBrainRun(response.progress);
      setNotice("Regeneration started — stale/extractive episodes are re-derived under the current contract and superseded.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the regeneration run.");
      return false;
    }
  }

  // Identity (name + self numbers) saves as one unit from the run console; the
  // self numbers get owner-label precedence in every future evidence pack.
  async function handleSaveIdentity(displayName: string, selfJids: string[]): Promise<boolean> {
    setError(null);
    try {
      const saved = await setBrainOwner(displayName || null, selfJids);
      setNotice(
        saved.ownerName
          ? `Saved: your messages will be labeled "${saved.ownerName} (me)"${saved.selfIdentities.length ? ` — including ${saved.selfIdentities.length} other number${saved.selfIdentities.length === 1 ? "" : "s"} of yours` : ""}.`
          : "Owner name cleared."
      );
      void refreshBrainOverview();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your identity.");
      return false;
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
        onOpenConsole={() => setConsoleOpen(true)}
        onReset={() => void handleResetBrain()}
      />
      {consoleOpen && (
        <RunConsoleModal
          overview={brainOverview}
          busy={busy}
          running={brainRun?.state === "running"}
          onClose={() => setConsoleOpen(false)}
          onProviderAction={(body) => void handleBrainProviderAction(body)}
          onSaveIdentity={handleSaveIdentity}
          onStartRun={handleStartBrainRun}
          onStartRegenerate={handleStartBrainRegenerate}
          suggest={getOwnerIdentitySuggestions}
        />
      )}
      <BrainGraphSection running={brainRun?.state === "running"} />
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
