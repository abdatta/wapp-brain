import { AlertTriangle, ArrowLeft, History, Loader2, Play, RotateCcw, ScrollText, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BRAIN_DOC_REVISION_NONE, type BrainDocDetail, type BrainOverview, type BrainRunProgress } from "../../../shared/types";
import { getBrainDoc, getBrainOverview, getBrainRunProgress, rollbackBrainDoc, startBrainRollupRun } from "../../api";
import { buildChatDeepLink } from "../../lib/deepLinks";
import { useToast } from "../../state/ToastContext";

// One semantic page (semantic-rollups): the rendered dossier with per-statement
// citation click-through to exact messages, the revision history with declared
// drops/supersessions, mechanical rollback, and the graph back-link — the
// trust loop in one surface.

function formatDateTime(ms: number | null): string {
  return ms == null ? "—" : new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const DROP_REASON_LABEL: Record<string, string> = {
  superseded: "superseded by a newer claim",
  stale: "no longer relevant",
  out_of_scope: "out of scope",
  claim_deleted: "claim regenerated away"
};

export function BrainDocPage() {
  const { docId: rawDocId } = useParams();
  const docId = rawDocId ? decodeURIComponent(rawDocId) : "";
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BrainDocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState<BrainRunProgress | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<number | null>(null);
  // Provider status only, read-only here — the picker lives on /brain/pages so
  // there is one place that owns the spend decision.
  const [provider, setProvider] = useState<BrainOverview["provider"] | null>(null);
  const { setError: toastError, setNotice } = useToast();
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!docId) {
        return;
      }
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        setDetail(await getBrainDoc(docId));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the page.");
      } finally {
        setLoading(false);
      }
    },
    [docId]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void getBrainOverview()
      .then((overview) => setProvider(overview.provider))
      .catch(() => undefined);
  }, []);

  useEffect(() => () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
    }
  }, []);

  function watchRun() {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
    }
    pollRef.current = window.setInterval(() => {
      void getBrainRunProgress().then((progress) => {
        if (progress.state === "running" && progress.kind === "rollup") {
          setRunning(progress);
          return;
        }
        if (pollRef.current != null) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setRunning(null);
        if (progress.kind === "rollup" && progress.rollup) {
          setNotice(
            progress.rollup.docsCommitted > 0
              ? `Page consolidated (${progress.rollup.resolutionsApplied > 0 ? `${progress.rollup.resolutionsApplied} commitment(s) closed, ` : ""}${progress.modelCalls} model call(s)).`
              : `Rollup refused — the prior revision stays current. See the issues below.`
          );
        }
        void refresh({ silent: true });
      });
    }, 1000);
  }

  async function runRollup() {
    if (!detail) {
      return;
    }
    setBusy("rollup");
    try {
      const result = await startBrainRollupRun({ nodeId: detail.doc.nodeId });
      setRunning(result.progress);
      watchRun();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not start the rollup.");
    } finally {
      setBusy(null);
    }
  }

  async function doRollback(toRevision: number | null) {
    setBusy("rollback");
    setConfirmRollback(null);
    try {
      const restored = await rollbackBrainDoc(docId, toRevision);
      setDetail(restored);
      setNotice(
        restored.current
          ? `Restored revision ${restored.current.revision} — the page file re-rendered.`
          : "Page unrolled — it is eligible again and the next rollup will generate from scratch. Every revision is still in history."
      );
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not roll back.");
    } finally {
      setBusy(null);
    }
  }

  const blockedReason = !provider
    ? null
    : !provider.modelBacked || !provider.enabled || provider.degraded || provider.sessionMissing
      ? provider.message
      : null;
  const rollupsBlocked = Boolean(blockedReason);

  return (
    <div className="evalPage">
      <header className="evalHeader">
        <Link className="evalBackLink" to="/brain/pages">
          <ArrowLeft size={14} /> Pages
        </Link>
        <h2>{detail?.title ?? docId}</h2>
        {detail && (
          <p className="brainHint">
            {detail.doc.kind} page{detail.current ? ` · revision ${detail.current.revision} · updated ${formatDateTime(detail.current.createdAtMs)}` : " · no revision yet"}
            {detail.redirected ? " · resolved through a merged redirect" : ""}
            {detail.due ? ` · due (${detail.dueReasons.join(", ")})` : ""}
          </p>
        )}
        <div className="lifecycleCounts">
          {detail && (
            <button type="button" className="chip lifecycleFilterChip" onClick={() => navigate(`/graph?node=${encodeURIComponent(detail.doc.nodeId ?? "")}`)}>
              <Share2 size={12} /> View in graph
            </button>
          )}
          <button
            type="button"
            className="chip lifecycleFilterChip"
            disabled={busy != null || running != null || !detail || rollupsBlocked}
            onClick={() => void runRollup()}
            title={blockedReason ?? `Consolidate this page now — one ${provider?.model ?? "model"} call`}
          >
            {busy === "rollup" ? <Loader2 className="spin" size={12} /> : <Play size={12} />} Roll up now
          </button>
          {/* Revisions below say what each run wrote HERE; this says what each
              run also changed elsewhere while writing it. */}
          <Link
            className="chip lifecycleFilterChip"
            to={`/brain/runs?doc=${encodeURIComponent(docId)}`}
            title="Every run that touched this page, and what each one durably changed — including commitments closed alongside the page"
          >
            <ScrollText size={12} /> Run history
          </Link>
          {detail?.current && detail.history.some((revision) => revision.status === "superseded") && (
            <button
              type="button"
              className="chip lifecycleFilterChip"
              disabled={busy != null || running != null}
              onClick={() => setConfirmRollback(-1)}
              title="Restore the previous revision mechanically (no model call)"
            >
              <RotateCcw size={12} /> Roll back
            </button>
          )}
          {detail?.current && (
            // Unroll = roll back past revision 1. Every revision stays retained
            // and restorable; the page just stops being current, so the next
            // rollup generates from scratch (the clean A/B path).
            <button
              type="button"
              className="chip lifecycleFilterChip"
              disabled={busy != null || running != null}
              onClick={() => setConfirmRollback(BRAIN_DOC_REVISION_NONE)}
              title="Unroll this page: return it to eligible-but-never-rolled so the next rollup starts from scratch. Revisions are kept and restorable."
            >
              <RotateCcw size={12} /> Unroll to no page
            </button>
          )}
        </div>
        {running && running.rollup && (
          <p className="brainHint">
            <Loader2 className="spin" size={12} /> Consolidating… {running.modelCalls} model call(s) so far.
          </p>
        )}
        {blockedReason && (
          <p className="brainHint lifecycleOverdue">
            {blockedReason} <Link to="/brain/pages">Change the provider on Pages</Link>.
          </p>
        )}
        {confirmRollback != null && (
          <p className="brainHint">
            {confirmRollback === BRAIN_DOC_REVISION_NONE
              ? "Unroll this page? It returns to eligible-but-never-rolled and the next rollup generates from scratch. Every revision stays in history and can be restored."
              : `Restore ${confirmRollback === -1 ? "the previous revision" : `revision ${confirmRollback}`}? The current revision stays in history.`}{" "}
            <button type="button" className="chip lifecycleFilterChip" onClick={() => void doRollback(confirmRollback === -1 ? null : confirmRollback)}>
              {confirmRollback === BRAIN_DOC_REVISION_NONE ? "Yes, unroll" : "Yes, restore"}
            </button>{" "}
            <button type="button" className="chip lifecycleFilterChip" onClick={() => setConfirmRollback(null)}>
              Cancel
            </button>
          </p>
        )}
      </header>

      {loading && (
        // Shimmer shaped like a real dossier section (heading + statements),
        // so the page fills its eventual box instead of collapsing to a line.
        <section className="evalCard" aria-label="loading page" aria-busy="true">
          <div className="lifecycleSkel docSkelHeading" />
          <ul className="lifecycleSkeletonList">
            {Array.from({ length: 4 }).map((_, index) => (
              <li key={index} className="lifecycleSkeletonRow" style={{ animationDelay: `${index * 70}ms` }}>
                <div className={`lifecycleSkel lifecycleSkelText${index % 2 === 0 ? "" : " short"}`} />
                <div className="lifecycleSkel lifecycleSkelMeta" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && (
        <section className="evalCard">
          <p className="errorText">{error}</p>
        </section>
      )}

      {detail && !detail.current && !loading && (
        <section className="evalCard">
          <p className="brainHint">
            No consolidation yet. {detail.due ? "This page is due — roll it up to write the first dossier." : "Not enough new material to consolidate."}
          </p>
        </section>
      )}

      {detail?.sections.map((section) => (
        <section key={section.title} className="evalCard">
          <h3>{section.title}</h3>
          <ul className="lifecycleList">
            {section.statements.map((statement, index) => (
              <li key={`${section.title}-${index}`} className="lifecycleItem">
                <div className="lifecycleItemMain">
                  <span className="lifecycleItemText">{statement.text}</span>
                  <span className="brainHint">
                    {statement.claims.map((claim) =>
                      claim.citations.length > 0 ? (
                        claim.citations.map((citation) =>
                          citation.chatId != null ? (
                            <button
                              key={`${claim.claimId}-${citation.sourceMessageKey}`}
                              type="button"
                              className="chip lifecycleFilterChip"
                              title={`Open the cited message (${formatDateTime(citation.timestampMs)})`}
                              onClick={() => navigate(buildChatDeepLink(citation.chatId!, citation.messageId))}
                            >
                              ↳ {formatDateTime(citation.timestampMs)}
                            </button>
                          ) : (
                            <span key={`${claim.claimId}-${citation.sourceMessageKey}`} className="chip">
                              {citation.sourceMessageKey.slice(0, 10)}…
                            </span>
                          )
                        )
                      ) : (
                        <span key={claim.claimId} className="chip">
                          {claim.exists ? claim.claimId.slice(0, 8) : "claim removed"}
                        </span>
                      )
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {detail && detail.issues.length > 0 && (
        <section className="evalCard">
          <h3>
            <AlertTriangle size={14} /> Issues
          </h3>
          <ul className="lifecycleList">
            {detail.issues.map((issue) => (
              <li key={issue.id} className="lifecycleItem">
                <div className="lifecycleItemMain">
                  <span className="chip">{issue.severity}</span> <span className="chip">{issue.code}</span>{" "}
                  <span className="lifecycleItemText">{issue.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail && detail.history.length > 0 && (
        <section className="evalCard">
          <h3>
            <History size={14} /> Revisions
          </h3>
          <ul className="lifecycleList">
            {detail.history.map((revision) => (
              <li key={revision.id} className="lifecycleItem">
                <div className="lifecycleItemMain">
                  <span className={`chip${revision.status === "current" ? " active" : ""}`}>rev {revision.revision}</span>{" "}
                  <span className="chip">{revision.status}</span>{" "}
                  <span className="brainHint">
                    {formatDateTime(revision.createdAtMs)} · {revision.statementCount} statement(s) over {revision.referencedClaimCount} claim(s) (
                    {revision.fedClaimCount} fed)
                    {revision.resolutionCount > 0 ? ` · ${revision.resolutionCount} commitment(s) closed` : ""}
                    {revision.model ? ` · ${revision.model}${revision.effort ? `/${revision.effort}` : ""}` : ""}
                  </span>
                  {revision.drops.length > 0 && (
                    <span className="brainHint">
                      drops:{" "}
                      {revision.drops
                        .map((drop) => `${drop.claimId.slice(0, 8)} (${DROP_REASON_LABEL[drop.reason] ?? drop.reason}${drop.byClaimId ? ` → ${drop.byClaimId.slice(0, 8)}` : ""})`)
                        .join("; ")}
                    </span>
                  )}
                  {revision.errors && revision.errors.length > 0 && <span className="errorText">refused: {revision.errors.join("; ")}</span>}
                </div>
                <div className="lifecycleItemActions">
                  {revision.status === "superseded" && (
                    <button
                      type="button"
                      className="chip lifecycleFilterChip"
                      disabled={busy != null || running != null}
                      onClick={() => setConfirmRollback(revision.revision)}
                    >
                      <RotateCcw size={12} /> Restore
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
