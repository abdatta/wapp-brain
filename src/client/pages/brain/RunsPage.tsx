import { AlertTriangle, ArrowLeft, BookOpenText, CheckCircle2, FileText, RefreshCcw, ScrollText, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { BrainLifecycleItemDetail, BrainRunEffectCounts, BrainRunEffects, BrainRunListItem } from "../../../shared/types";
import { applyBrainLifecycleTransition, getBrainDoc, getBrainLifecycleItemDetail, getBrainRunEffects, listBrainRuns } from "../../api";
import { buildChatDeepLink } from "../../lib/deepLinks";
import { useToast } from "../../state/ToastContext";
import { LifecycleDetailModal } from "./LifecycleDetailModal";

// Run history + the per-run audit (semantic-rollups). The question this answers
// is "what did this run durably change?" — with emphasis on effects OUTSIDE the
// artifact it was asked to produce: a rollup writes a page, but may also close
// commitments and supersede claims, and that must never be invisible.
//
// `?doc=` scopes the history to one page, which is how a page asks "show my
// runs" — the same list and the same audit, filtered to the runs that touched
// it, so there is one audit surface rather than a second one per artifact.

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

// Effects a run had BEYOND the artifact it was asked for. Separated from the
// artifact counts because this is the class of change that used to be
// invisible — a rollup asked for a page also closes commitments.
function beyondArtifactChips(effects: BrainRunEffectCounts): Array<{ key: string; label: string; title: string }> {
  const chips: Array<{ key: string; label: string; title: string }> = [];
  if (effects.lifecycleChanges > 0) {
    chips.push({
      key: "lifecycle",
      label: plural(effects.lifecycleChanges, "commitment/question change"),
      title: "Commitments or open questions this run moved to a new status — durable, and independent of any page it wrote."
    });
  }
  if (effects.claimsSuperseded > 0) {
    chips.push({
      key: "superseded",
      label: plural(effects.claimsSuperseded, "claim") + " superseded",
      title: "Claims this run declared out of date, replaced by newer evidence."
    });
  }
  return chips;
}

function artifactChips(effects: BrainRunEffectCounts): Array<{ key: string; label: string; title: string }> {
  const chips: Array<{ key: string; label: string; title: string }> = [];
  if (effects.pagesWritten > 0) {
    chips.push({ key: "pages", label: plural(effects.pagesWritten, "page") + " written", title: "Page revisions this run committed." });
  }
  if (effects.pagesRefused > 0) {
    chips.push({
      key: "refused",
      label: plural(effects.pagesRefused, "page") + " refused",
      title: "Consolidations the regression guard rejected — the prior revision stayed current."
    });
  }
  if (effects.episodesCommitted > 0) {
    chips.push({ key: "episodes", label: plural(effects.episodesCommitted, "episode"), title: "Episodes this run committed." });
  }
  if (effects.issues > 0) {
    chips.push({ key: "issues", label: plural(effects.issues, "issue"), title: "Validation issues this run recorded." });
  }
  return chips;
}

const STATUS_ICON: Record<string, ReactNode> = {
  completed: <CheckCircle2 size={12} />,
  failed: <XCircle size={12} />,
  interrupted: <AlertTriangle size={12} />,
  budget_exceeded: <AlertTriangle size={12} />
};

function RunSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <ul className="lifecycleSkeletonList" aria-label="loading runs" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <li key={index} className="lifecycleSkeletonRow" style={{ animationDelay: `${index * 60}ms` }}>
          <div className={`lifecycleSkel lifecycleSkelText${index % 2 === 0 ? "" : " short"}`} />
          <div className="lifecycleSkel lifecycleSkelMeta" />
        </li>
      ))}
    </ul>
  );
}

export function BrainRunsPage() {
  const [searchParams] = useSearchParams();
  const docId = searchParams.get("doc");
  const [runs, setRuns] = useState<BrainRunListItem[] | null>(null);
  const [docTitle, setDocTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [effects, setEffects] = useState<BrainRunEffects | null>(null);
  const [effectsLoading, setEffectsLoading] = useState(false);
  // Acting on one lifecycle item WITHOUT leaving the audit: reviewing what a
  // run changed and undoing part of it is one task, not two pages.
  const [itemClaimId, setItemClaimId] = useState<string | null>(null);
  const [itemDetail, setItemDetail] = useState<BrainLifecycleItemDetail | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [itemBusy, setItemBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const { setNotice, setError: toastError } = useToast();

  const openItem = useCallback(
    async (claimId: string) => {
      setItemClaimId(claimId);
      setItemDetail(null);
      setItemLoading(true);
      try {
        setItemDetail(await getBrainLifecycleItemDetail(claimId));
      } catch (err) {
        toastError(err instanceof Error ? err.message : "Could not load item context.");
      } finally {
        setItemLoading(false);
      }
    },
    [toastError]
  );

  const refresh = useCallback(async () => {
    try {
      const response = await listBrainRuns({ limit: 100, docId: docId ?? undefined });
      setRuns(response.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load run history.");
      setRuns([]);
    }
  }, [docId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Scoped header names the page, not its opaque doc id.
    setDocTitle(null);
    setSelected(null);
    if (!docId) {
      return;
    }
    let cancelled = false;
    void getBrainDoc(docId)
      .then((detail) => {
        if (!cancelled) {
          setDocTitle(detail.title);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const openRun = useCallback(async (runId: string) => {
    setSelected(runId);
    setEffectsLoading(true);
    setEffects(null);
    try {
      setEffects(await getBrainRunEffects(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the run audit.");
    } finally {
      setEffectsLoading(false);
    }
  }, []);

  const closeAudit = useCallback(() => {
    setSelected(null);
    setEffects(null);
  }, []);

  // Escape closes the audit — but only when it is the top dialog, so the item
  // detail opened from inside it dismisses first.
  useEffect(() => {
    if (!selected || itemClaimId != null) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAudit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, itemClaimId, closeAudit]);

  async function transitionItem(claimId: string, action: "fulfilled" | "dismissed" | "reopened") {
    setItemBusy(claimId);
    try {
      await applyBrainLifecycleTransition({ claimId, action, note: null });
      setNotice(
        action === "reopened"
          ? "Reopened. The audit still records that the run closed it — history is never rewritten."
          : `Marked ${action}.`
      );
      setItemDetail(await getBrainLifecycleItemDetail(claimId));
      // The audit's "now" chip reads the item's CURRENT status, so it must
      // re-read after an undo or it keeps implying the run's change still holds.
      if (selected) {
        setEffects(await getBrainRunEffects(selected));
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Could not apply the change.");
    } finally {
      setItemBusy(null);
    }
  }

  return (
    <div className="evalPage">
      <header className="evalHeader">
        <Link className="evalBackLink" to={docId ? `/brain/pages/${encodeURIComponent(docId)}` : "/brain"}>
          <ArrowLeft size={14} /> {docId ? docTitle ?? "Page" : "Brain"}
        </Link>
        <h2>{docId ? `Runs for ${docTitle ?? "this page"}` : "Runs"}</h2>
        <p className="brainHint">
          {docId
            ? "Every run that touched this page — including consolidations the guard refused. Each entry lists what the run durably changed, so a run that closed a commitment while writing the page says so here."
            : "Every brain run and what it durably changed. A run is asked for one artifact — episodes, closures, a page — but may also change things alongside it: a rollup can close commitments and mark claims superseded. Those effects are listed here so nothing a model did is only visible as a counter."}
        </p>
        <div className="lifecycleCounts">
          {docId && (
            <Link className="chip lifecycleFilterChip" to="/brain/runs">
              Show all runs
            </Link>
          )}
          <button className="iconButton" onClick={() => void refresh()} title="Refresh" aria-label="Refresh">
            <RefreshCcw size={16} />
          </button>
        </div>
      </header>

      {error && (
        <section className="evalCard">
          <p className="errorText">{error}</p>
        </section>
      )}

      <section className="evalCard">
        <h3>
          <ScrollText size={14} /> History
        </h3>
        {runs == null && <RunSkeleton />}
        {runs != null && runs.length === 0 && (
          <p className="brainHint">
            {docId
              ? "No run has written or been refused a revision of this page yet. Roll it up from the page to create one."
              : "No runs recorded yet."}
          </p>
        )}
        <ul className="lifecycleList">
          {runs?.map(({ run, effects: counts, docEffect }) => {
            const beyond = beyondArtifactChips(counts);
            const artifacts = artifactChips(counts);
            return (
              <li key={run.id} className={`lifecycleItem${selected === run.id ? " lifecycleItemSelected" : ""}`}>
                <div className="lifecycleItemMain">
                  <button type="button" className="lifecycleItemText linkButton" onClick={() => void openRun(run.id)}>
                    <strong>{run.kind}</strong> · {formatWhen(run.startedAt)}
                  </button>{" "}
                  <span className={`chip${run.status === "completed" ? "" : " lifecycleOverdue"}`}>
                    {STATUS_ICON[run.status] ?? null} {run.status}
                  </span>
                  {docEffect && (
                    <span
                      className={`chip${docEffect.status === "rejected" ? " lifecycleOverdue" : docEffect.isCurrent ? " active" : ""}`}
                      title={
                        docEffect.status === "rejected"
                          ? "The guard refused this consolidation — the prior revision stayed current."
                          : docEffect.isCurrent
                            ? "This revision is what the page shows today."
                            : "Superseded by a later revision."
                      }
                    >
                      rev {docEffect.revision} · {docEffect.isCurrent ? "current" : docEffect.status}
                      {docEffect.status !== "rejected" ? ` · ${plural(docEffect.statementCount, "statement")}` : ""}
                    </span>
                  )}
                  {/* What the run changed, on the row itself — an effect that
                      only appears after opening the audit is an effect the
                      user has to already suspect to find. */}
                  <span className="brainHint">
                    {artifacts.length === 0 && beyond.length === 0 ? (
                      "no durable changes"
                    ) : (
                      <>
                        {artifacts.map((chip) => (
                          <span key={chip.key} className="chip" title={chip.title}>
                            {chip.label}
                          </span>
                        ))}
                        {beyond.map((chip) => (
                          <span key={chip.key} className="chip active" title={chip.title}>
                            {chip.label}
                          </span>
                        ))}
                      </>
                    )}
                  </span>
                  {docEffect?.errors && docEffect.errors.length > 0 && (
                    <span className="errorText">refused: {docEffect.errors.join("; ")}</span>
                  )}
                  {run.errorMessage && <span className="brainHint lifecycleOverdue">{run.errorMessage}</span>}
                </div>
                <div className="lifecycleItemActions">
                  <button type="button" className="chip lifecycleFilterChip" onClick={() => void openRun(run.id)}>
                    Audit
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* The audit is a dialog, not a trailing section: with a long run list an
          inline panel opens below the fold and reads as nothing happening. */}
      {selected && (
        <div className="lifecycleModalOverlay" onClick={() => itemClaimId == null && closeAudit()}>
          <div className="lifecycleModal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <header className="lifecycleModalHead">
              <div className="lifecycleModalTitle">
                <ScrollText size={16} />
                <span>What this run changed</span>
              </div>
              <button type="button" className="lifecycleModalClose" onClick={closeAudit} title="Close">
                <X size={16} />
              </button>
            </header>
            <div className="lifecycleModalBody">
              {effectsLoading && <RunSkeleton rows={3} />}
              {effects && !effectsLoading && (
            <>
              <p className="brainHint">
                {effects.run.kind} run · {formatWhen(effects.run.startedAt)} → {formatWhen(effects.run.finishedAt)} · {effects.run.status}
              </p>

              {effects.lifecycle.length > 0 && (
                <>
                  <h4>
                    <CheckCircle2 size={13} /> Commitments &amp; questions changed ({effects.lifecycle.length})
                  </h4>
                  <p className="brainHint">
                    Durable lifecycle changes — these persist independently of the page or episode the run produced.
                  </p>
                  <ul className="lifecycleList">
                    {effects.lifecycle.map((entry) => (
                      <li key={entry.eventId} className="lifecycleItem">
                        <div className="lifecycleItemMain">
                          <span className="chip">{entry.toStatus}</span>{" "}
                          <span className="chip">{entry.source === "model" ? entry.model ?? "model" : "you"}</span>{" "}
                          {entry.currentStatus !== entry.toStatus && entry.toStatus !== "still_open" && (
                            <span className="chip lifecycleOverdue">now {entry.currentStatus}</span>
                          )}
                          {/* Opens the item in place — undoing what a run did
                              belongs in the audit, not a page away. */}
                          {entry.itemExists ? (
                            <button
                              type="button"
                              className="lifecycleItemText lifecycleTextButton"
                              title="Open this item: full context, history, and actions — including undoing this change"
                              onClick={() => void openItem(entry.claimId)}
                            >
                              {entry.itemText}
                            </button>
                          ) : (
                            <span className="lifecycleItemText">{entry.itemText}</span>
                          )}
                          <span className="brainHint">
                            {entry.chatDisplayName ?? entry.chatSourceId ?? "unknown chat"} · {formatWhen(new Date(entry.atMs).toISOString())}
                            {entry.note ? ` · ${entry.note}` : ""}
                          </span>
                          {entry.cites.length > 0 && (
                            <span className="brainHint">
                              evidence:{" "}
                              {entry.cites.map((cite) =>
                                cite.chatId != null ? (
                                  <button
                                    key={cite.sourceMessageKey}
                                    type="button"
                                    className="chip lifecycleFilterChip"
                                    title={cite.snippet ?? "Open the cited message"}
                                    onClick={() => navigate(buildChatDeepLink(cite.chatId!, cite.messageId))}
                                  >
                                    ↳ {cite.senderLabel ?? "message"}
                                  </button>
                                ) : (
                                  <span key={cite.sourceMessageKey} className="chip">
                                    {cite.sourceMessageKey.slice(0, 10)}…
                                  </span>
                                )
                              )}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {effects.revisions.length > 0 && (
                <>
                  <h4>
                    <BookOpenText size={13} /> Pages written ({effects.revisions.length})
                  </h4>
                  <ul className="lifecycleList">
                    {effects.revisions.map((revision) => (
                      <li key={`${revision.docId}-${revision.revision}`} className="lifecycleItem">
                        <div className="lifecycleItemMain">
                          <Link to={`/brain/pages/${encodeURIComponent(revision.docId)}`} className="lifecycleItemText">
                            <strong>{revision.title}</strong>
                          </Link>{" "}
                          <span className="chip">rev {revision.revision}</span>{" "}
                          <span className={`chip${revision.status === "rejected" ? " lifecycleOverdue" : ""}`}>{revision.status}</span>
                          {/* status is the revision's own field; isCurrent comes from the
                              doc's pointer. They must agree — show a chip only when they
                              DON'T, so drift is visible instead of duplicated noise. */}
                          {revision.isCurrent !== (revision.status === "current") && (
                            <span className="chip lifecycleOverdue">
                              pointer says {revision.isCurrent ? "current" : "not current"}
                            </span>
                          )}
                          <span className="brainHint">
                            {revision.statementCount} statement(s) over {revision.referencedClaimCount} claim(s)
                            {revision.supersededClaims.length > 0
                              ? ` · ${revision.supersededClaims.length} claim(s) marked superseded`
                              : ""}
                          </span>
                          {revision.errors && revision.errors.length > 0 && (
                            <span className="errorText">refused: {revision.errors.join("; ")}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {effects.episodesCommitted > 0 && (
                <p className="brainHint">
                  <FileText size={13} /> {effects.episodesCommitted.toLocaleString()} episode(s) committed by this run.
                </p>
              )}

              {effects.issues.length > 0 && (
                <>
                  <h4>
                    <AlertTriangle size={13} /> Issues raised ({effects.issues.length})
                  </h4>
                  <ul className="lifecycleList">
                    {effects.issues.slice(0, 40).map((issue) => (
                      <li key={issue.id} className="lifecycleItem">
                        <div className="lifecycleItemMain">
                          <span className="chip">{issue.severity}</span> <span className="chip">{issue.code}</span>{" "}
                          <span className="lifecycleItemText">{issue.detail}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {effects.lifecycle.length === 0 &&
                effects.revisions.length === 0 &&
                effects.episodesCommitted === 0 &&
                effects.issues.length === 0 && (
                  <p className="brainHint">This run made no durable changes — nothing committed, nothing closed.</p>
                )}
            </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Rendered after the audit so it stacks above it: opening an item from
          the audit layers the detail on top rather than replacing it. */}
      {itemClaimId && (
        <LifecycleDetailModal
          detail={itemDetail}
          loading={itemLoading}
          busyClaim={itemBusy}
          canSweep={false}
          onClose={() => {
            setItemClaimId(null);
            setItemDetail(null);
          }}
          onTransition={(claimId, action) => void transitionItem(claimId, action)}
        />
      )}
    </div>
  );
}
