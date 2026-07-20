import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Filter,
  HelpCircle,
  Loader2,
  MessageSquare,
  Play,
  RotateCcw,
  Smile,
  Square,
  X,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  BrainLifecycleChatFacet,
  BrainLifecycleItemDetail,
  BrainLifecycleListResponse,
  BrainLifecycleSort,
  BrainLifecycleStatus,
  BrainLifecycleView,
  BrainOverview,
  BrainProviderName,
  BrainRunProgress
} from "../../../shared/types";
import {
  applyBrainLifecycleTransition,
  brainProviderAction,
  cancelBrainRun,
  getBrainLifecycleItemDetail,
  getBrainOverview,
  getBrainRunProgress,
  listBrainLifecycleItems,
  startBrainLifecycleSweep
} from "../../api";
import { useToast } from "../../state/ToastContext";

// The L0 commitments surface (commitment-lifecycle): status-driven open items
// independent of salience/dormancy, overdue/stale flagged server-side, with
// user close/cancel/reopen and the manual-first model closure sweep. Count
// chips filter; items select for a subset sweep; Hide + Groups exclude; a
// detail modal shows why each item exists and every piece of context we have.

const formatDay = (ms: number | null): string =>
  ms == null ? "—" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const formatDateTime = (ms: number | null): string =>
  ms == null ? "—" : new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const SORTS: Array<{ value: BrainLifecycleSort; label: string }> = [
  { value: "smart", label: "Smart (overdue first)" },
  { value: "due_asc", label: "Due date — soonest" },
  { value: "due_desc", label: "Due date — latest" },
  { value: "opened_desc", label: "Opened — newest" },
  { value: "opened_asc", label: "Opened — oldest" },
  { value: "evidence_desc", label: "Most evidence" },
  { value: "recent_activity", label: "Recent activity" }
];

type HideState = { overdue: boolean; stale: boolean; fulfilled: boolean; dismissed: boolean };
const NO_HIDE: HideState = { overdue: false, stale: false, fulfilled: false, dismissed: false };
type GroupMode = "off" | "only" | "hide";
const CANDIDATE_LABEL: Record<"reaction" | "reply" | "claim", string> = {
  reaction: "Reaction on the promise",
  reply: "Reply quoting it",
  claim: "Later statement"
};

function viewToQuery(view: BrainLifecycleView): {
  status?: "open" | "fulfilled" | "dismissed" | "all";
  flag?: "overdue" | "stale" | "sweep_due";
} {
  switch (view) {
    case "overdue":
      return { status: "open", flag: "overdue" };
    case "stale":
      return { status: "open", flag: "stale" };
    case "sweep_due":
      return { status: "open", flag: "sweep_due" };
    case "fulfilled":
      return { status: "fulfilled" };
    case "dismissed":
      return { status: "dismissed" };
    case "all":
      return { status: "all" };
    default:
      return { status: "open" };
  }
}

// --- Group include/exclude filter popover -----------------------------------

function GroupFilter({
  facets,
  mode,
  chats,
  onChange
}: {
  facets: BrainLifecycleChatFacet[];
  mode: GroupMode;
  chats: Set<string>;
  onChange: (mode: GroupMode, chats: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const shown = facets.filter((facet) => (facet.chatDisplayName ?? facet.chatSourceId).toLowerCase().includes(query.toLowerCase()));
  const active = mode !== "off" && chats.size > 0;
  const label = !active ? "Groups: all" : mode === "only" ? `Groups: only ${chats.size}` : `Groups: hiding ${chats.size}`;

  function toggleChat(id: string) {
    const next = new Set(chats);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next.size === 0 ? "off" : mode === "off" ? "only" : mode, next);
  }

  return (
    <div className="lifecycleGroupFilter" ref={ref}>
      <button type="button" className={`chip${active ? " active" : ""}`} onClick={() => setOpen((value) => !value)}>
        <Filter size={12} /> {label}
      </button>
      {open && (
        <div className="lifecycleGroupPanel">
          <div className="lifecycleGroupModes">
            {(["off", "only", "hide"] as GroupMode[]).map((entry) => (
              <button
                key={entry}
                type="button"
                className={`chip${mode === entry ? " active" : ""}`}
                onClick={() => onChange(entry, entry === "off" ? new Set() : chats)}
              >
                {entry === "off" ? "all groups" : entry === "only" ? "only selected" : "hide selected"}
              </button>
            ))}
          </div>
          <input type="text" className="lifecycleGroupSearch" placeholder="Filter groups…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="lifecycleGroupList">
            {shown.length === 0 ? (
              <div className="lifecycleGroupEmpty">No groups match.</div>
            ) : (
              shown.map((facet) => (
                <label key={facet.chatSourceId} className="lifecycleGroupRow">
                  <input type="checkbox" checked={chats.has(facet.chatSourceId)} onChange={() => toggleChat(facet.chatSourceId)} disabled={mode === "off"} />
                  <span className="lifecycleGroupName">{facet.chatDisplayName ?? facet.chatSourceId}</span>
                  <span className="lifecycleGroupCount">{facet.count}</span>
                </label>
              ))
            )}
          </div>
          {active && (
            <button type="button" className="evalButton lifecycleGroupClear" onClick={() => onChange("off", new Set())}>
              Clear group filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- List loading shimmer ---------------------------------------------------

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="lifecycleSkeletonList" aria-label="loading" aria-busy="true">
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

// --- Item detail modal ------------------------------------------------------

function DetailModal({
  detail,
  loading,
  busyClaim,
  canSweep,
  onClose,
  onTransition,
  onSweep,
  onStartNote
}: {
  detail: BrainLifecycleItemDetail | null;
  loading: boolean;
  busyClaim: string | null;
  canSweep: boolean;
  onClose: () => void;
  onTransition: (claimId: string, action: "fulfilled" | "dismissed" | "reopened") => void;
  onSweep: (claimId: string) => void;
  onStartNote: (claimId: string, action: "fulfilled" | "dismissed") => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const item = detail?.item ?? null;
  return (
    <div className="lifecycleModalOverlay" onClick={onClose}>
      <div className="lifecycleModal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header className="lifecycleModalHead">
          <div className="lifecycleModalTitle">
            {item ? (item.kind === "commitment" ? <CircleDot size={16} /> : <HelpCircle size={16} />) : null}
            <span>{item?.text ?? (loading ? "Loading…" : "Item")}</span>
          </div>
          <button type="button" className="lifecycleModalClose" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>

        {!detail ? (
          <div className="lifecycleModalBody">
            {loading ? (
              <div className="lifecycleModalSection">
                <div className="lifecycleSkel lifecycleSkelText" style={{ marginBottom: 10 }} />
                <div className="lifecycleSkel lifecycleSkelMeta" style={{ marginBottom: 10 }} />
                <div className="lifecycleSkel lifecycleSkelText short" />
              </div>
            ) : (
              <p className="brainHint">Not found.</p>
            )}
          </div>
        ) : (
          <div className="lifecycleModalBody">
            <div className="lifecycleMeta">
              <span className={`chip lifecycleStatus-${item!.status}`}>
                {item!.status === "fulfilled" && item!.kind === "question" ? "answered" : item!.status}
              </span>
              {item!.overdue && <span className="chip lifecycleOverdue">overdue</span>}
              {item!.stale && <span className="chip">stale</span>}
              {item!.chatDisplayName && <span>{item!.chatDisplayName}</span>}
              {item!.holderLabel && <span>holder: {item!.holderLabel}</span>}
              <span>opened {formatDay(item!.openedAtMs)}</span>
              {item!.dueMs != null && <span>due {formatDay(item!.dueMs)}</span>}
            </div>

            <section className="lifecycleModalSection">
              <h4>Why this exists</h4>
              <p className="lifecycleModalNote">The messages this {item!.kind} was extracted from:</p>
              {detail.origin.length === 0 ? (
                <p className="brainHint">No origin messages resolved.</p>
              ) : (
                <ul className="lifecycleEvidenceList">
                  {detail.origin.map((cite) => (
                    <li key={cite.sourceMessageKey}>
                      <span className="lifecycleEvidenceWhen">{formatDateTime(cite.timestampMs)}</span>
                      {cite.chatId != null && cite.messageId != null ? (
                        <Link className="lifecycleCite" to={`/chats/${cite.chatId}?at=${cite.messageId}`}>
                          {cite.senderLabel ? `${cite.senderLabel}: ` : ""}
                          {cite.snippet ?? "view message"}
                        </Link>
                      ) : (
                        <span className="lifecycleCite">
                          {cite.senderLabel ? `${cite.senderLabel}: ` : ""}
                          {cite.snippet ?? cite.sourceMessageKey}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="lifecycleModalSection">
              <h4>Later evidence ({detail.candidates.length})</h4>
              <p className="lifecycleModalNote">Signals gathered deterministically that a closure sweep would judge:</p>
              {detail.candidates.length === 0 ? (
                <p className="brainHint">No later evidence yet — nothing has referenced this since it was made.</p>
              ) : (
                <ul className="lifecycleEvidenceList">
                  {detail.candidates.map((candidate) => (
                    <li key={`${candidate.kind}:${candidate.sourceMessageKey}`}>
                      <span className="lifecycleEvidenceKind">
                        {candidate.kind === "reaction" ? <Smile size={12} /> : <MessageSquare size={12} />} {CANDIDATE_LABEL[candidate.kind]}
                      </span>
                      <span className="lifecycleEvidenceWhen">{formatDateTime(candidate.timestampMs)}</span>
                      {candidate.chatId != null && candidate.messageId != null ? (
                        <Link className="lifecycleCite" to={`/chats/${candidate.chatId}?at=${candidate.messageId}`}>
                          {candidate.senderLabel ? `${candidate.senderLabel}: ` : ""}
                          {candidate.text}
                        </Link>
                      ) : (
                        <span className="lifecycleCite">
                          {candidate.senderLabel ? `${candidate.senderLabel}: ` : ""}
                          {candidate.text}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {(detail.events.length > 0 || item!.resolution) && (
              <section className="lifecycleModalSection">
                <h4>History</h4>
                <ul className="lifecycleHistory">
                  <li>
                    <span className="lifecycleEvidenceWhen">{formatDay(item!.openedAtMs)}</span> opened
                  </li>
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      <span className="lifecycleEvidenceWhen">{formatDay(event.evidenceAtMs ?? event.createdAtMs)}</span>{" "}
                      {event.toStatus === "still_open" ? "reviewed — still open" : event.toStatus} by {event.source === "user" ? "you" : event.model ?? "model"}
                      {event.orphanedAtMs != null ? " (orphaned)" : ""}
                      {event.note ? ` — ${event.note}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {item && (
          <footer className="lifecycleModalFooter">
            {item.status === "open" ? (
              <>
                <button type="button" className="evalButton" disabled={busyClaim === item.claimId} onClick={() => onStartNote(item.claimId, "fulfilled")}>
                  <CheckCircle2 size={13} /> {item.kind === "question" ? "Answered" : "Done"}
                </button>
                <button type="button" className="evalButton" disabled={busyClaim === item.claimId} onClick={() => onStartNote(item.claimId, "dismissed")} title="Not relevant, withdrawn, or a bad extraction — hide it (reversible via Reopen).">
                  <XCircle size={13} /> Dismiss
                </button>
                <button
                  type="button"
                  className="evalButton"
                  disabled={busyClaim === item.claimId || !canSweep}
                  title={canSweep ? "Judge just this item against its evidence (one model call)." : "Provider not ready for a model sweep."}
                  onClick={() => onSweep(item.claimId)}
                >
                  <Play size={13} /> Sweep this item
                </button>
              </>
            ) : (
              <button type="button" className="evalButton" disabled={busyClaim === item.claimId} onClick={() => onTransition(item.claimId, "reopened")}>
                <RotateCcw size={13} /> {item.status === "dismissed" ? "Restore" : "Reopen"}
              </button>
            )}
            <button type="button" className="evalButton" onClick={onClose}>
              Close
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

export function CommitmentsPage() {
  const { setNotice, setError } = useToast();
  const [data, setData] = useState<BrainLifecycleListResponse | null>(null);
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [view, setView] = useState<BrainLifecycleView>("open");
  const [kind, setKind] = useState<"all" | "commitment" | "question">("all");
  const [sort, setSort] = useState<BrainLifecycleSort>("smart");
  const [hide, setHide] = useState<HideState>(NO_HIDE);
  const [dueUpcoming, setDueUpcoming] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("off");
  const [groupChats, setGroupChats] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<{ claimId: string; action: "fulfilled" | "dismissed" } | null>(null);
  const [note, setNote] = useState("");
  const [runProgress, setRunProgress] = useState<BrainRunProgress | null>(null);
  const [detailClaimId, setDetailClaimId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrainLifecycleItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef({ view, kind, sort, hide, dueUpcoming, groupMode, groupChats });
  filterRef.current = { view, kind, sort, hide, dueUpcoming, groupMode, groupChats };

  const refresh = useCallback(
    async (
      next?: Partial<{ view: BrainLifecycleView; kind: typeof kind; sort: BrainLifecycleSort; hide: HideState; dueUpcoming: boolean; groupMode: GroupMode; groupChats: Set<string> }>,
      // Silent reconcile (after an optimistic action): refetch without the
      // skeleton flash so the list stays interactive and just updates in place.
      opts?: { silent?: boolean }
    ) => {
      const active = { ...filterRef.current, ...next };
      const chats = [...active.groupChats];
      if (!opts?.silent) setRefreshing(true);
      try {
        const [list, status] = await Promise.all([
          listBrainLifecycleItems({
            ...viewToQuery(active.view),
            hideOverdue: active.hide.overdue,
            hideStale: active.hide.stale,
            hideFulfilled: active.hide.fulfilled,
            hideDismissed: active.hide.dismissed,
            dueUpcoming: active.dueUpcoming,
            includeChats: active.groupMode === "only" ? chats : undefined,
            excludeChats: active.groupMode === "hide" ? chats : undefined,
            kind: active.kind === "all" ? undefined : active.kind,
            sort: active.sort,
            limit: 300
          }),
          getBrainOverview()
        ]);
        setData(list);
        setOverview(status);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the commitments surface.");
      } finally {
        if (!opts?.silent) setRefreshing(false);
      }
    },
    [setError]
  );

  // Debounced background reconcile: after a burst of optimistic actions, one
  // silent refetch (no skeleton) fixes any count drift once the user pauses.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReconcile = useCallback(() => {
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    reconcileTimer.current = setTimeout(() => void refresh(undefined, { silent: true }), 1200);
  }, [refresh]);

  const pollRun = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    void getBrainRunProgress()
      .then((progress) => {
        setRunProgress(progress);
        if (progress.state === "running" && progress.kind === "lifecycle") {
          pollTimer.current = setTimeout(pollRun, 1000);
        } else if (progress.kind === "lifecycle") {
          void refresh();
        }
      })
      .catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void getBrainRunProgress()
      .then((progress) => {
        setRunProgress(progress);
        if (progress.state === "running" && progress.kind === "lifecycle") pollRun();
      })
      .catch(() => undefined);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectView(next: BrainLifecycleView) {
    setView(next);
    setSelected(new Set());
    // Choosing a count-chip view is an explicit filter — it exits the preset.
    setDueUpcoming(false);
    await refresh({ view: next, dueUpcoming: false });
  }

  // One-click "upcoming deadlines": open items with a future due date, soonest
  // first. Leaves the group filter untouched. Toggles off on a second click.
  async function toggleUpcomingPreset() {
    if (dueUpcoming) {
      setDueUpcoming(false);
      await refresh({ dueUpcoming: false });
      return;
    }
    setView("open");
    setSort("due_asc");
    setHide(NO_HIDE);
    setDueUpcoming(true);
    setSelected(new Set());
    await refresh({ view: "open", sort: "due_asc", hide: NO_HIDE, dueUpcoming: true });
  }
  async function selectKind(next: typeof kind) {
    setKind(next);
    setSelected(new Set());
    await refresh({ kind: next });
  }
  async function selectSort(next: BrainLifecycleSort) {
    setSort(next);
    await refresh({ sort: next });
  }
  async function toggleHide(key: keyof HideState) {
    const next = { ...hide, [key]: !hide[key] };
    setHide(next);
    setSelected(new Set());
    await refresh({ hide: next });
  }
  async function changeGroupFilter(mode: GroupMode, chats: Set<string>) {
    setGroupMode(mode);
    setGroupChats(chats);
    setSelected(new Set());
    await refresh({ groupMode: mode, groupChats: chats });
  }

  function toggleSelect(claimId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(claimId)) next.delete(claimId);
      else next.add(claimId);
      return next;
    });
  }

  const loadDetail = useCallback(async (claimId: string) => {
    setDetailClaimId(claimId);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await getBrainLifecycleItemDetail(claimId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load item context.");
    } finally {
      setDetailLoading(false);
    }
  }, [setError]);
  function closeDetail() {
    setDetailClaimId(null);
    setDetail(null);
  }

  // Does an item with this status still belong in the currently-shown view?
  function statusInView(status: BrainLifecycleStatus): boolean {
    switch (view) {
      case "fulfilled":
        return status === "fulfilled";
      case "dismissed":
        return status === "dismissed";
      case "all":
        return true;
      default:
        // open / overdue / stale / sweep_due are all open-only views.
        return status === "open";
    }
  }

  // Update the list + counts in place after a transition — no refetch, no
  // skeleton — so serial actions feel instant. A debounced silent reconcile
  // (scheduleReconcile) fixes any drift once the user pauses.
  function applyOptimisticTransition(claimId: string, action: "fulfilled" | "dismissed" | "reopened") {
    const newStatus: BrainLifecycleStatus = action === "reopened" ? "open" : action;
    setSelected((prev) => {
      if (!prev.has(claimId)) return prev;
      const nextSel = new Set(prev);
      nextSel.delete(claimId);
      return nextSel;
    });
    setData((prev) => {
      if (!prev) return prev;
      const idx = prev.items.findIndex((entry) => entry.claimId === claimId);
      const known = idx >= 0 ? prev.items[idx] : detail?.item.claimId === claimId ? detail.item : null;
      const counts = { ...prev.counts };
      if (known) {
        if (action === "reopened") {
          if (known.status === "fulfilled") counts.fulfilled = Math.max(0, counts.fulfilled - 1);
          else if (known.status === "dismissed") counts.dismissed = Math.max(0, counts.dismissed - 1);
          counts.open += 1;
          // overdue/stale/sweepDue for the now-open item need a recompute — the
          // silent reconcile fills them in.
        } else if (known.status === "open") {
          counts.open = Math.max(0, counts.open - 1);
          if (known.overdue) counts.overdue = Math.max(0, counts.overdue - 1);
          if (known.stale) counts.stale = Math.max(0, counts.stale - 1);
          if (known.candidateCount > 0) counts.sweepDue = Math.max(0, counts.sweepDue - 1);
          if (action === "fulfilled") counts.fulfilled += 1;
          else counts.dismissed += 1;
        }
      }
      let items = prev.items;
      if (idx >= 0) {
        if (statusInView(newStatus)) {
          const updated = {
            ...prev.items[idx],
            status: newStatus,
            overdue: newStatus === "open" ? prev.items[idx].overdue : false,
            stale: newStatus === "open" ? prev.items[idx].stale : false
          };
          items = [...prev.items.slice(0, idx), updated, ...prev.items.slice(idx + 1)];
        } else {
          items = [...prev.items.slice(0, idx), ...prev.items.slice(idx + 1)];
        }
      }
      return { ...prev, items, counts };
    });
  }

  async function handleTransition(claimId: string, action: "fulfilled" | "dismissed" | "reopened", withNote?: string | null) {
    setBusy(claimId);
    try {
      await applyBrainLifecycleTransition({ claimId, action, note: withNote ?? null });
      setNoteFor(null);
      setNote("");
      // Instant local update instead of a blocking full refetch; reconcile
      // quietly after the user stops acting.
      applyOptimisticTransition(claimId, action);
      scheduleReconcile();
      if (detailClaimId === claimId) void loadDetail(claimId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the transition.");
      void refresh(undefined, { silent: true });
    } finally {
      setBusy(null);
    }
  }

  async function switchProvider(value: BrainProviderName) {
    setBusy("provider");
    try {
      const result = value === "extractive" ? await brainProviderAction({ action: "disable" }) : await brainProviderAction({ action: "enable", provider: value });
      setOverview((prev) => (prev ? { ...prev, provider: result.provider } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch the provider.");
    } finally {
      setBusy(null);
    }
  }
  async function selectModel(model: string) {
    const activeProvider = overview?.provider;
    if (!activeProvider || activeProvider.provider === "extractive") return;
    setBusy("model");
    try {
      const result = await brainProviderAction({ action: "set-model", provider: activeProvider.provider, model });
      setOverview((prev) => (prev ? { ...prev, provider: result.provider } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the model.");
    } finally {
      setBusy(null);
    }
  }

  async function runSweep(claimIds: string[] | null) {
    setBusy("sweep");
    try {
      const result = await startBrainLifecycleSweep({ claimIds: claimIds && claimIds.length > 0 ? claimIds : null });
      setRunProgress(result.progress);
      setNotice(
        claimIds && claimIds.length > 0
          ? `Sweeping ${claimIds.length} selected item(s) against their gathered evidence.`
          : "Closure sweep started — judging sweep-due items against their gathered evidence."
      );
      setSelected(new Set());
      pollRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the closure sweep.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCancelSweep() {
    try {
      await cancelBrainRun();
      setNotice("Cancelling — applied transitions are kept.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the sweep.");
    }
  }

  const counts = data?.counts ?? null;
  const provider = overview?.provider ?? null;
  const modelBacked = Boolean(provider && provider.provider !== "extractive");
  const modelOptions = provider && provider.provider !== "extractive" ? provider.models[provider.provider] ?? [] : [];
  const providerBlocked = !provider || !provider.modelBacked || !provider.enabled || provider.degraded || provider.sessionMissing;
  const sweepDisabledReason = !provider
    ? "Loading provider status…"
    : !provider.modelBacked || !provider.enabled
      ? provider.message
      : provider.degraded || provider.sessionMissing
        ? provider.message
        : counts && counts.sweepDue === 0
          ? "Nothing is sweep-due: no open item has new evidence or a newly passed due date."
          : null;
  const sweepRunning = runProgress?.state === "running" && runProgress.kind === "lifecycle";
  const otherRunActive = runProgress?.state === "running" && runProgress.kind !== "lifecycle";

  const shownItems = data?.items ?? [];
  const shownOpen = useMemo(() => shownItems.filter((item) => item.status === "open"), [shownItems]);
  const allShownSelected = shownOpen.length > 0 && shownOpen.every((item) => selected.has(item.claimId));
  function toggleSelectAllShown() {
    setSelected((prev) => {
      if (shownOpen.every((item) => prev.has(item.claimId))) {
        const next = new Set(prev);
        for (const item of shownOpen) next.delete(item.claimId);
        return next;
      }
      const next = new Set(prev);
      for (const item of shownOpen) next.add(item.claimId);
      return next;
    });
  }

  const chips: Array<{ view: BrainLifecycleView; label: string; value: number; icon?: ReactNode; danger?: boolean }> = counts
    ? [
        { view: "open", label: "open", value: counts.open, icon: <CircleDot size={12} /> },
        { view: "overdue", label: "overdue", value: counts.overdue, icon: <AlertTriangle size={12} />, danger: counts.overdue > 0 },
        { view: "stale", label: "stale", value: counts.stale },
        { view: "sweep_due", label: "sweep-due", value: counts.sweepDue },
        { view: "fulfilled", label: "fulfilled", value: counts.fulfilled, icon: <CheckCircle2 size={12} /> },
        { view: "dismissed", label: "dismissed", value: counts.dismissed, icon: <XCircle size={12} /> }
      ]
    : [];

  const hideToggles: Array<{ key: keyof HideState; label: string }> =
    view === "all"
      ? [
          { key: "overdue", label: "overdue" },
          { key: "stale", label: "stale" },
          { key: "fulfilled", label: "fulfilled" },
          { key: "dismissed", label: "dismissed" }
        ]
      : view === "open"
        ? [
            { key: "overdue", label: "overdue" },
            { key: "stale", label: "stale" }
          ]
        : [];

  return (
    <div className="evalPage">
      {detailClaimId && (
        <DetailModal
          detail={detail}
          loading={detailLoading}
          busyClaim={busy}
          canSweep={!providerBlocked && !sweepRunning && !otherRunActive}
          onClose={closeDetail}
          onTransition={(claimId, action) => void handleTransition(claimId, action)}
          onSweep={(claimId) => void runSweep([claimId])}
          onStartNote={(claimId, action) => {
            setNoteFor({ claimId, action });
            setNote("");
            closeDetail();
            document.getElementById(`lifecycle-item-${claimId}`)?.scrollIntoView({ block: "center" });
          }}
        />
      )}

      <header className="evalHeader">
        <Link className="evalBackLink" to="/brain">
          <ArrowLeft size={14} /> Brain
        </Link>
        <h2>Commitments &amp; questions</h2>
        <p className="brainHint">
          Open items surface by status — never by salience — so a quiet chat's unresolved promise stays visible. Click a count to
          filter, a group to focus, or an item to see why it exists and every piece of context we have. Tick items to sweep a subset.
        </p>
      </header>

      {counts && (
        <section className="evalCard">
          <div className="lifecycleCounts">
            {chips.map((chip) => (
              <button
                key={chip.view}
                type="button"
                className={`chip lifecycleFilterChip${view === chip.view && !dueUpcoming ? " active" : ""}${chip.danger ? " lifecycleOverdue" : ""}`}
                onClick={() => void selectView(chip.view)}
                aria-pressed={view === chip.view && !dueUpcoming}
              >
                {chip.icon} {chip.value.toLocaleString()} {chip.label}
              </button>
            ))}
            <button
              type="button"
              className={`chip lifecycleFilterChip${view === "all" && !dueUpcoming ? " active" : ""}`}
              onClick={() => void selectView("all")}
              aria-pressed={view === "all" && !dueUpcoming}
            >
              all
            </button>
            <span className="lifecycleChipDivider" aria-hidden="true" />
            <button
              type="button"
              className={`chip lifecycleFilterChip lifecyclePresetChip${dueUpcoming ? " active" : ""}`}
              onClick={() => void toggleUpcomingPreset()}
              aria-pressed={dueUpcoming}
              title="Open items with a future due date, soonest first (excludes overdue and undated). Your group filter is left as-is."
            >
              <CalendarClock size={12} /> Upcoming deadlines
            </button>
            {counts.orphanedEvents > 0 && (
              <span
                className="chip lifecycleOverdue"
                title="Resolutions whose commitment claim was regenerated without an unambiguous replacement — the new item is open again; re-sweep or close manually."
              >
                {counts.orphanedEvents} orphaned resolution(s)
              </span>
            )}
          </div>
        </section>
      )}

      <section className="evalCard">
        <div className="evalCardHeader">
          <h3>Closure sweep</h3>
          {sweepRunning ? (
            <button type="button" className="evalButton" onClick={() => void handleCancelSweep()}>
              <Square size={14} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              className="evalButton"
              onClick={() => void runSweep(null)}
              disabled={busy === "sweep" || Boolean(sweepDisabledReason) || otherRunActive}
              title={otherRunActive ? "Another brain run is in progress." : sweepDisabledReason ?? "Judge every sweep-due item against its gathered evidence (model calls)."}
            >
              {busy === "sweep" ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Run sweep (all due)
            </button>
          )}
        </div>
        <p className="brainHint">
          A model reviews each item with its deterministically gathered later evidence and closes only on explicit, postdating
          citations. Failed validations leave items open — there is no fallback closure. Runs at high reasoning effort.
        </p>
        <div className="lifecycleSweepControls">
          <label className="lifecycleControl">
            <span>Provider</span>
            <select value={provider?.provider ?? "extractive"} disabled={sweepRunning || busy === "provider"} onChange={(event) => void switchProvider(event.target.value as BrainProviderName)}>
              <option value="extractive">extractive (no model)</option>
              <option value="claude-cli">claude (WSL CLI)</option>
              <option value="codex">codex (GPT OAuth)</option>
            </select>
          </label>
          <label className="lifecycleControl" title={!modelBacked ? "Pick a model provider first." : undefined}>
            <span>Model</span>
            <select value={provider?.model ?? modelOptions[0] ?? ""} disabled={!modelBacked || sweepRunning || busy === "model"} onChange={(event) => void selectModel(event.target.value)}>
              {(modelBacked ? modelOptions : ["—"]).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <span className="lifecycleEffortNote" title="Closure judgment is rollup-class work; it always runs at high reasoning effort.">
            Effort: high
          </span>
        </div>
        {provider && <div className={`brainHint${provider.degraded ? " lifecycleOverdue" : ""}`}>{provider.message}</div>}
        {runProgress?.kind === "lifecycle" && runProgress.lifecycle && (
          <div className="lifecycleSweepProgress">
            {sweepRunning ? <Loader2 className="spin" size={13} /> : null}
            <span>
              {runProgress.state === "running" ? "Sweeping" : `Sweep ${runProgress.state}`}
              {runProgress.currentChat ? ` — ${runProgress.currentChat}` : ""}: {runProgress.lifecycle.nodesOffered} offered ·{" "}
              {runProgress.lifecycle.fulfilled} fulfilled · {runProgress.lifecycle.dismissed} dismissed ·{" "}
              {runProgress.lifecycle.stillOpen} still open
              {runProgress.lifecycle.failedCalls > 0 ? ` · ${runProgress.lifecycle.failedCalls} failed call(s)` : ""} ·{" "}
              {runProgress.modelCalls} call(s)
            </span>
            {runProgress.error && <span className="lifecycleOverdue">{runProgress.error}</span>}
          </div>
        )}
      </section>

      <section className="evalCard">
        <div className="evalCardHeader">
          <h3>
            Items
            {refreshing && data && (
              <span className="lifecycleUpdating">
                <Loader2 className="spin" size={12} /> updating…
              </span>
            )}
          </h3>
          <div className="lifecycleFilters">
            {(["all", "commitment", "question"] as const).map((entry) => (
              <button key={`kind-${entry}`} type="button" className={`chip${kind === entry ? " active" : ""}`} onClick={() => void selectKind(entry)}>
                {entry === "all" ? "both kinds" : `${entry}s`}
              </button>
            ))}
            <GroupFilter facets={data?.chatFacets ?? []} mode={groupMode} chats={groupChats} onChange={(mode, chats) => void changeGroupFilter(mode, chats)} />
            {hideToggles.length > 0 && (
              <span className="lifecycleHideGroup">
                <span className="lifecycleHideLabel">Hide:</span>
                {hideToggles.map((toggle) => (
                  <button
                    key={toggle.key}
                    type="button"
                    className={`chip lifecycleHideChip${hide[toggle.key] ? " active" : ""}`}
                    onClick={() => void toggleHide(toggle.key)}
                    aria-pressed={hide[toggle.key]}
                    title={`Exclude ${toggle.label} items from the list (counts stay full)`}
                  >
                    {toggle.label}
                  </button>
                ))}
              </span>
            )}
            <label className="lifecycleControl lifecycleSortControl">
              <span>Sort</span>
              <select value={sort} onChange={(event) => void selectSort(event.target.value as BrainLifecycleSort)}>
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {!refreshing && shownOpen.length > 0 && (
          <div className="lifecycleSelectBar">
            <label className="lifecycleSelectAll">
              <input type="checkbox" checked={allShownSelected} onChange={toggleSelectAllShown} />
              <span>Select all shown ({shownOpen.length})</span>
            </label>
            {selected.size > 0 && (
              <>
                <span className="lifecycleSelectedCount">{selected.size} selected</span>
                <button
                  type="button"
                  className="evalButton"
                  disabled={busy === "sweep" || sweepRunning || otherRunActive || providerBlocked}
                  title={providerBlocked ? provider?.message ?? "Provider not ready." : otherRunActive ? "Another brain run is in progress." : "Sweep exactly the selected items (overrides the sweep-due heuristic)."}
                  onClick={() => void runSweep([...selected])}
                >
                  {busy === "sweep" ? <Loader2 className="spin" size={13} /> : <Play size={13} />} Sweep {selected.size} selected
                </button>
                <button type="button" className="evalButton" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </>
            )}
          </div>
        )}

        {refreshing || !data ? (
          <ListSkeleton />
        ) : shownItems.length === 0 ? (
          <p className="brainHint">{view === "open" ? "No open commitments or questions match this filter." : "Nothing matches this filter."}</p>
        ) : (
          <ul className="lifecycleList">
            {shownItems.map((item) => (
              <li key={item.nodeId} id={`lifecycle-item-${item.claimId}`} className={`lifecycleItem${selected.has(item.claimId) ? " lifecycleItemSelected" : ""}`}>
                <div className="lifecycleItemHead">
                  {item.status === "open" && (
                    <input
                      type="checkbox"
                      className="lifecycleCheckbox"
                      checked={selected.has(item.claimId)}
                      onChange={() => toggleSelect(item.claimId)}
                      title="Select to sweep this item"
                    />
                  )}
                  {item.kind === "commitment" ? <CircleDot size={14} /> : <HelpCircle size={14} />}
                  <button type="button" className="lifecycleTextButton" onClick={() => void loadDetail(item.claimId)} title="Open details">
                    {item.text}
                  </button>
                </div>
                <div className="lifecycleMeta">
                  <span className={`chip lifecycleStatus-${item.status}`}>{item.status === "fulfilled" && item.kind === "question" ? "answered" : item.status}</span>
                  {item.overdue && <span className="chip lifecycleOverdue">overdue</span>}
                  {item.stale && <span className="chip">stale</span>}
                  {item.chatDisplayName && <span>{item.chatDisplayName}</span>}
                  {item.holderLabel && <span>holder: {item.holderLabel}</span>}
                  <span>opened {formatDay(item.openedAtMs)}</span>
                  {item.dueMs != null && <span>due {formatDay(item.dueMs)}</span>}
                  {item.status === "open" && item.candidateCount > 0 && (
                    <button
                      type="button"
                      className="chip lifecycleEvidenceChip"
                      onClick={() => void loadDetail(item.claimId)}
                      title="Show the gathered evidence and full context."
                    >
                      +{item.candidateCount} evidence
                    </button>
                  )}
                </div>
                {item.resolution && (
                  <div className="lifecycleResolution">
                    <span>
                      {item.resolution.status === "fulfilled" ? "Done" : "Dismissed"} {formatDay(item.resolution.atMs)} by{" "}
                      {item.resolution.source === "user" ? "you" : item.resolution.model ?? "the model"}
                      {item.resolution.note ? ` — ${item.resolution.note}` : ""}
                    </span>
                    {item.resolution.cites.map((cite) =>
                      cite.chatId != null && cite.messageId != null ? (
                        <Link key={cite.sourceMessageKey} className="lifecycleCite" to={`/chats/${cite.chatId}?at=${cite.messageId}`}>
                          {cite.senderLabel ? `${cite.senderLabel}: ` : ""}
                          {cite.snippet ?? "view message"}
                        </Link>
                      ) : (
                        <span key={cite.sourceMessageKey} className="lifecycleCite">
                          {cite.senderLabel ? `${cite.senderLabel}: ` : ""}
                          {cite.snippet ?? cite.sourceMessageKey}
                        </span>
                      )
                    )}
                  </div>
                )}
                <div className="lifecycleActions">
                  {item.status === "open" ? (
                    noteFor?.claimId === item.claimId ? (
                      <>
                        <input type="text" value={note} placeholder="Optional note (why)" onChange={(event) => setNote(event.target.value)} />
                        <button
                          type="button"
                          className="evalButton"
                          disabled={busy === item.claimId}
                          onClick={() => void handleTransition(item.claimId, noteFor.action, note.trim() || null)}
                        >
                          {busy === item.claimId ? <Loader2 className="spin" size={13} /> : <CheckCircle2 size={13} />} Confirm {noteFor.action === "fulfilled" ? "done" : "dismiss"}
                        </button>
                        <button type="button" className="evalButton" onClick={() => setNoteFor(null)}>
                          Back
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="evalButton"
                          disabled={busy === item.claimId}
                          onClick={() => {
                            setNoteFor({ claimId: item.claimId, action: "fulfilled" });
                            setNote("");
                          }}
                          title={item.kind === "question" ? "Mark answered" : "Mark done"}
                        >
                          <CheckCircle2 size={13} /> {item.kind === "question" ? "Answered" : "Done"}
                        </button>
                        <button
                          type="button"
                          className="evalButton"
                          disabled={busy === item.claimId}
                          onClick={() => {
                            setNoteFor({ claimId: item.claimId, action: "dismissed" });
                            setNote("");
                          }}
                          title="Not relevant, withdrawn, or a bad extraction — hide it (reversible via Reopen)."
                        >
                          <XCircle size={13} /> Dismiss
                        </button>
                      </>
                    )
                  ) : (
                    <button
                      type="button"
                      className="evalButton"
                      disabled={busy === item.claimId}
                      onClick={() => void handleTransition(item.claimId, "reopened")}
                      title="Bring it back to open (and sweepable); the history keeps every transition."
                    >
                      {busy === item.claimId ? <Loader2 className="spin" size={13} /> : <RotateCcw size={13} />} {item.status === "dismissed" ? "Restore" : "Reopen"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default CommitmentsPage;
