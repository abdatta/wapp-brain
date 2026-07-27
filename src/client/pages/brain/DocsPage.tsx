import { AlertTriangle, ArrowLeft, BookOpenText, FileClock, Loader2, Play, RefreshCcw, Stethoscope } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  BrainDocKind,
  BrainDocsListResponse,
  BrainDocsListView,
  BrainOverview,
  BrainProviderName,
  BrainReasoningEffort,
  BrainRunProgress
} from "../../../shared/types";
import { brainProviderAction, getBrainOverview, getBrainRunProgress, listBrainDocs, startBrainRollupRun } from "../../api";
import { useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

// The semantic pages list (semantic-rollups): existing docs AND page-eligible
// nodes without a page yet, with deterministic dueness reasons computed
// server-side. Rolling up is manual-first — one doc or the top-K due — and the
// strong-tier spend is always the user's explicit click.

const KIND_LABEL: Record<BrainDocKind, string> = { entity: "entity", topic: "topic", chat: "chat" };

const DUE_REASON_LABEL: Record<string, string> = {
  never_rolled: "no page yet",
  new_claims: "new claims",
  claims_deleted: "claims regenerated",
  lifecycle_changed: "commitments changed",
  merged_scope: "merged"
};

function formatDay(ms: number | null): string {
  return ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Shimmer rows matching .lifecycleItem's box exactly, so switching views swaps
// content in place instead of collapsing the layout to a text line.
function DocsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="lifecycleSkeletonList" aria-label="loading pages" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <li key={index} className="lifecycleSkeletonRow" style={{ animationDelay: `${index * 60}ms` }}>
          <div className={`lifecycleSkel lifecycleSkelText${index % 3 === 0 ? " short" : ""}`} />
          <div className="lifecycleSkel lifecycleSkelMeta" />
          <div className="lifecycleSkel lifecycleSkelActions" />
        </li>
      ))}
    </ul>
  );
}

export function BrainDocsPage() {
  const [data, setData] = useState<BrainDocsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<BrainDocKind | "all">("all");
  const [view, setView] = useState<BrainDocsListView>("all");
  const [running, setRunning] = useState<BrainRunProgress | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const demo = Boolean(useStatus().status?.demo);
  // Provider/model/effort are chosen HERE because a rollup is the most
  // expensive call the brain makes — the tier must be visible and deliberate
  // at the moment of spend, not inherited invisibly from a distant screen.
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [effort, setEffort] = useState<BrainReasoningEffort>("high");
  // Which doc THIS client asked for. `busy` only covers the in-flight POST
  // (milliseconds); a rollup then runs for minutes server-side, so the row
  // needs its own live marker or the page looks idle while it works.
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const { setError: toastError, setNotice } = useToast();
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        setData(await listBrainDocs({ kind: kind === "all" ? undefined : kind, view, limit: 300 }));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the pages list.");
      } finally {
        setLoading(false);
      }
    },
    [kind, view]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshProvider = useCallback(async () => {
    try {
      setOverview(await getBrainOverview());
    } catch {
      // Provider status is advisory here; the list still renders without it.
    }
  }, []);

  useEffect(() => {
    void refreshProvider();
  }, [refreshProvider]);

  // While a rollup run is live, poll progress and refresh the list when done.
  const watchRun = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
    }
    pollRef.current = window.setInterval(() => {
      void getBrainRunProgress().then((progress) => {
        // Any live run keeps the watch alive — the server allows only one at a
        // time, so a concurrent episode/sweep run must also gate the buttons.
        if (progress.state === "running") {
          setRunning(progress);
          return;
        }
        if (pollRef.current != null) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setRunning(null);
        setActiveDocId(null);
        if (progress.kind === "rollup" && progress.rollup) {
          const counters = progress.rollup;
          setNotice(
            `Rollup ${progress.state}: ${counters.docsCommitted}/${counters.docsPlanned} page(s) written` +
              (counters.docsRejected > 0 ? `, ${counters.docsRejected} refused (prior revision kept)` : "") +
              (counters.resolutionsApplied > 0 ? `, ${counters.resolutionsApplied} commitment(s) closed` : "")
          );
        }
        void refresh({ silent: true });
      });
    }, 1000);
  }, [refresh, setNotice]);

  useEffect(() => () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
    }
  }, []);

  // Reconnect to a run already in flight. A page refresh loses this client's
  // polling state — never the run itself, which lives in the server process
  // and keeps consolidating. Without this the page falsely reads as idle.
  useEffect(() => {
    void getBrainRunProgress()
      .then((progress) => {
        if (progress.state === "running") {
          setRunning(progress);
          watchRun();
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  async function runRollup(target: { nodeId?: string; maxDocs?: number; docId?: string }, label: string) {
    setBusy(label);
    try {
      const result = await startBrainRollupRun({
        nodeId: target.nodeId ?? null,
        maxDocs: target.maxDocs ?? null,
        effort
      });
      setRunning(result.progress);
      setActiveDocId(target.docId ?? null);
      watchRun();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not start the rollup run.");
    } finally {
      setBusy(null);
    }
  }

  async function switchProvider(value: BrainProviderName) {
    setBusy("provider");
    try {
      const result =
        value === "extractive"
          ? await brainProviderAction({ action: "disable" })
          : await brainProviderAction({ action: "enable", provider: value });
      setOverview((prev) => (prev ? { ...prev, provider: result.provider } : prev));
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not switch the provider.");
    } finally {
      setBusy(null);
    }
  }

  async function selectModel(model: string) {
    const active = overview?.provider;
    if (!active || active.provider === "extractive") {
      return;
    }
    setBusy("model");
    try {
      const result = await brainProviderAction({ action: "set-model", provider: active.provider, model });
      setOverview((prev) => (prev ? { ...prev, provider: result.provider } : prev));
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not select the model.");
    } finally {
      setBusy(null);
    }
  }

  // A degraded provider blocks every rollup; a probe is the one way back
  // (and the honest place to discover a quota that will not recover today).
  async function probeProvider() {
    setBusy("probe");
    try {
      const result = await brainProviderAction({ action: "probe" });
      setOverview((prev) => (prev ? { ...prev, provider: result.provider } : prev));
      setNotice(result.ok ? "Provider probe succeeded — rollups are unblocked." : result.provider.message);
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not probe the provider.");
    } finally {
      setBusy(null);
    }
  }

  // A row is "rolling up" when this client asked for it, or when the server
  // reports it as the doc currently being processed (title match — the run
  // progress carries the read-time label, which is what the row renders).
  function isRowRolling(docId: string, title: string): boolean {
    if (running == null || running.kind !== "rollup") {
      return false;
    }
    return activeDocId === docId || running.rollup?.currentDoc === title;
  }

  const counts = data?.counts;
  const provider = overview?.provider ?? null;
  const modelBacked = Boolean(provider && provider.provider !== "extractive");
  const modelOptions = provider && provider.provider !== "extractive" ? provider.models[provider.provider] ?? [] : [];
  // claude-cli's print mode has no reasoning-effort flag; codex does.
  const effortApplies = provider?.provider === "codex";
  const blockedReason = !provider
    ? "Loading provider status…"
    : !provider.modelBacked || !provider.enabled
      ? provider.message
      : provider.degraded || provider.sessionMissing
        ? provider.message
        : null;
  const rollupsBlocked = Boolean(blockedReason);

  return (
    <div className="evalPage">
      <header className="evalHeader">
        <Link className="evalBackLink" to="/brain">
          <ArrowLeft size={14} /> Brain
        </Link>
        <h2>Pages</h2>
        <p className="brainHint">
          Living dossiers consolidated from episode claims by a strong-model rollup — every statement cites the exact messages
          behind it, dropped claims must be declared, and every revision is kept for mechanical rollback. Rolling up spends model
          budget and is always your explicit click.
        </p>
      </header>

      <section className="evalCard">
        <div className="lifecycleCounts">
          {counts && (
            <>
              {/* Every count is a view you can open — see the note on
                  BrainDocsListView: an unclickable number is a dead end once
                  the list runs to hundreds of rows. */}
              <button
                type="button"
                className={`chip lifecycleFilterChip${view === "pages" ? " active" : ""}`}
                onClick={() => setView((prev) => (prev === "pages" ? "all" : "pages"))}
                aria-pressed={view === "pages"}
                title="Show only pages that have been consolidated at least once"
              >
                <BookOpenText size={12} /> {counts.docs.toLocaleString()} page(s)
              </button>
              <button
                type="button"
                className={`chip lifecycleFilterChip${view === "due" ? " active" : ""}${counts.due > 0 ? " lifecycleOverdue" : ""}`}
                onClick={() => setView((prev) => (prev === "due" ? "all" : "due"))}
                aria-pressed={view === "due"}
                title="Show only pages/nodes with new material worth consolidating"
              >
                <FileClock size={12} /> {counts.due.toLocaleString()} due
              </button>
              <button
                type="button"
                className={`chip lifecycleFilterChip${view === "candidates" ? " active" : ""}`}
                onClick={() => setView((prev) => (prev === "candidates" ? "all" : "candidates"))}
                aria-pressed={view === "candidates"}
                title="Show only nodes with enough claims to earn a page, but no page yet"
              >
                {counts.candidates.toLocaleString()} eligible without a page
              </button>
              {counts.issues > 0 && (
                <button
                  type="button"
                  className={`chip lifecycleFilterChip lifecycleOverdue${view === "issues" ? " active" : ""}`}
                  onClick={() => setView((prev) => (prev === "issues" ? "all" : "issues"))}
                  aria-pressed={view === "issues"}
                  title="Show only pages carrying validation issues (open a page to read them)"
                >
                  <AlertTriangle size={12} /> {counts.issues.toLocaleString()} issue(s)
                </button>
              )}
            </>
          )}
          {(["all", "entity", "topic", "chat"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`chip lifecycleFilterChip${kind === value ? " active" : ""}`}
              onClick={() => setKind(value)}
              aria-pressed={kind === value}
            >
              {value}
            </button>
          ))}
          <button className="iconButton" onClick={() => void refresh()} title="Refresh" aria-label="Refresh">
            <RefreshCcw size={16} />
          </button>
          <button
            type="button"
            className="chip lifecycleFilterChip"
            disabled={running != null || busy != null || rollupsBlocked}
            onClick={() => void runRollup({ maxDocs: 10 }, "due")}
            title={
              blockedReason ??
              `Consolidate the top due pages — one ${provider?.model ?? "model"} call per page${effortApplies ? ` at ${effort} effort` : ""}`
            }
          >
            {busy === "due" ? <Loader2 className="spin" size={12} /> : <Play size={12} />} Roll up due (top 10)
          </button>
        </div>

        <div className="lifecycleSweepControls">
          <label className="lifecycleControl" title={demo ? "Demo instance: model providers are disabled — extractive only." : undefined}>
            <span>Provider{demo ? " (demo: extractive only)" : ""}</span>
            <select
              value={provider?.provider ?? "extractive"}
              disabled={demo || running != null || busy === "provider"}
              onChange={(event) => void switchProvider(event.target.value as BrainProviderName)}
            >
              <option value="extractive">extractive (no model)</option>
              <option value="claude-cli">claude (WSL CLI)</option>
              <option value="codex">codex (GPT OAuth)</option>
            </select>
          </label>
          <label className="lifecycleControl" title={demo ? "Demo instance: model providers are disabled." : !modelBacked ? "Pick a model provider first." : undefined}>
            <span>Model</span>
            <select
              value={provider?.model ?? modelOptions[0] ?? ""}
              disabled={demo || !modelBacked || running != null || busy === "model"}
              onChange={(event) => void selectModel(event.target.value)}
            >
              {(modelBacked ? modelOptions : ["—"]).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label
            className="lifecycleControl"
            title={
              effortApplies
                ? "Consolidation is rollup-class judgment; high is the recommended floor."
                : "The claude CLI has no reasoning-effort flag — this applies to codex only."
            }
          >
            <span>Effort</span>
            <select
              value={effort}
              disabled={!effortApplies || running != null}
              onChange={(event) => setEffort(event.target.value as BrainReasoningEffort)}
            >
              {(["medium", "high", "xhigh", "max"] as const).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chip lifecycleFilterChip"
            disabled={running != null || busy != null || !modelBacked}
            onClick={() => void probeProvider()}
            title="Re-test the provider — the only way out of a degraded state"
          >
            {busy === "probe" ? <Loader2 className="spin" size={12} /> : <Stethoscope size={12} />} Probe
          </button>
        </div>
        {provider && <div className={`brainHint${provider.degraded ? " lifecycleOverdue" : ""}`}>{provider.message}</div>}

        {running && running.rollup && (
          <p className="brainHint">
            <Loader2 className="spin" size={12} /> Rolling up{running.rollup.currentDoc ? ` — ${running.rollup.currentDoc}` : ""}…{" "}
            {running.rollup.docsCommitted}/{running.rollup.docsPlanned} committed, {running.rollup.docsRejected} refused,{" "}
            {running.modelCalls} model call(s).
          </p>
        )}
      </section>

      <section className="evalCard">
        {loading && <DocsSkeleton />}
        {error && <p className="errorText">{error}</p>}
        {!loading && !error && (data?.items.length ?? 0) === 0 && (
          <p className="brainHint">
            {view === "pages"
              ? "No page has been consolidated yet — roll one up from the eligible list."
              : view === "issues"
                ? "No validation issues — every committed revision passed its guard cleanly."
                : view === "candidates"
                  ? "No eligible nodes without a page."
                  : view === "due"
                    ? "Nothing is due — every page is current with its claims."
                    : "No pages or eligible entities yet — pages become available once assimilated claims accumulate (at least a handful per person, topic, or chat)."}
          </p>
        )}
        <ul className="lifecycleList">
          {data?.items.map((item) => (
            <li key={item.docId} className="lifecycleItem">
              <div className="lifecycleItemMain">
                <Link to={`/brain/pages/${encodeURIComponent(item.docId)}`} className="lifecycleItemText">
                  <strong>{item.title}</strong>
                </Link>{" "}
                <span className="chip">{KIND_LABEL[item.kind]}</span>{" "}
                {item.status === "merged" && <span className="chip">merged</span>}
                {item.revision != null ? (
                  <span className="brainHint">
                    rev {item.revision} · rolled {formatDay(item.lastRollupAtMs)}
                  </span>
                ) : (
                  <span className="brainHint">no page yet</span>
                )}
                {item.due && (
                  <span className="chip lifecycleOverdue">
                    due: {item.dueReasons.map((reason) => DUE_REASON_LABEL[reason] ?? reason).join(", ")}
                  </span>
                )}
                <span className="brainHint">
                  {item.eligibleClaims.toLocaleString()} claim(s)
                  {item.newClaimsSinceRollup > 0 && item.revision != null ? `, ${item.newClaimsSinceRollup} new` : ""}
                  {item.openLifecycleItems > 0 ? `, ${item.openLifecycleItems} open item(s)` : ""}
                  {item.issueCount > 0 ? `, ${item.issueCount} issue(s)` : ""}
                </span>
              </div>
              <div className="lifecycleItemActions">
                {isRowRolling(item.docId, item.title) ? (
                  // Live marker for the doc actually being consolidated. Matches
                  // the server's currentDoc too, so it survives a refresh and
                  // walks down the list during a top-10 batch run.
                  <span className="chip lifecycleRunningChip" title="This page is being consolidated right now">
                    <Loader2 className="spin" size={12} /> Rolling up…
                  </span>
                ) : (
                  <button
                    type="button"
                    className="chip lifecycleFilterChip"
                    disabled={running != null || busy != null || item.status === "merged" || rollupsBlocked}
                    onClick={() => void runRollup({ nodeId: item.nodeId, docId: item.docId }, item.docId)}
                    title={
                      running != null
                        ? "A brain run is already in progress — only one runs at a time."
                        : blockedReason ??
                          `Consolidate this page now — one ${provider?.model ?? "model"} call over ${item.eligibleClaims.toLocaleString()} claim(s)`
                    }
                  >
                    {busy === item.docId ? <Loader2 className="spin" size={12} /> : <Play size={12} />} Roll up
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
