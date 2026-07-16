import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleStop,
  Database,
  Download,
  Eye,
  FileKey2,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  KeyRound,
  Link2,
  Loader2,
  MessageCircle,
  Moon,
  Pause,
  Play,
  QrCode,
  RefreshCcw,
  Search,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlink,
  Upload,
  Users,
  X
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { parseInlineSegments, parseWhatsAppBlocks, type InlineSegment } from "./whatsappFormat";
import type {
  ArchiveChangeEvent,
  BackupDetectionManifest,
  BrainOverview,
  BrainProviderName,
  BrainRunProgress,
  ChatListItem,
  ImportJobSummary,
  ImportMode,
  ImportProgressEvent,
  ImportVerificationSummary,
  LiveGapWindowRecord,
  LivePairingSummary,
  LiveSyncProgress,
  MemoryCitationResolution,
  MemoryQueryResult,
  MessageEditRevisionRecord,
  MessageListItem,
  PickKind,
  SearchIndexStatus,
  SearchReindexProgress,
  SearchResultItem,
  SearchTypeFilter,
  StatusSummary,
  GoogleContactsStatus
} from "../shared/types";
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "../shared/types";
import {
  brainProviderAction,
  cancelImportJob,
  cleanupTempFiles,
  detectBackupFolder,
  getBrainOverview,
  getBrainRunProgress,
  disableMemoryProvider,
  enableCodexMemoryProvider,
  getCurrentImportJob,
  getImportJob,
  getLivePairing,
  getLiveProgress,
  getMessageContext,
  getSearchStatus,
  getStatus,
  initDatabase,
  linkLiveSession,
  linkPreviewThumbnailUrl,
  listChats,
  listLiveGaps,
  listMessageRevisions,
  listMessages,
  mediaAssetUrl,
  mediaThumbnailUrl,
  pickImportPath,
  queryMemory,
  resolveMemoryCitation,
  resumeLiveSession,
  retryLiveGap,
  retryStuckMedia,
  resetBrainData,
  searchArchive,
  setBrainOwner,
  startBrainRun,
  startMemoryRun,
  startImportJob,
  startSearchReindex,
  stopLiveSession,
  unlinkLiveSession,
  verifyImportKey,
  getGoogleContactsStatus,
  syncGoogleContacts,
  disconnectGoogleContacts
} from "./api";
import { EmptyState, SkeletonRows, formatBytes, formatDate, formatTime, msToIso } from "./thread";

// Sidebar/status/live/brain/memory/onboarding panels, the import wizard, and global
// search results — extracted verbatim from the former App.tsx monolith. Presentational
// (props in, callbacks out); pages wire these to shared contexts and page-local state.
function GlobalSearchResults({
  results,
  totalMatches,
  searching,
  error,
  index,
  reindex,
  sender,
  type,
  direction,
  after,
  before,
  onSenderChange,
  onTypeChange,
  onDirectionChange,
  onAfterChange,
  onBeforeChange,
  onOpen,
  onReindex
}: {
  results: SearchResultItem[];
  totalMatches: number;
  searching: boolean;
  error: string | null;
  index: SearchIndexStatus | null;
  reindex: SearchReindexProgress | null;
  sender: string;
  type: "all" | SearchTypeFilter;
  direction: "all" | "incoming" | "outgoing";
  after: string;
  before: string;
  onSenderChange: (value: string) => void;
  onTypeChange: (value: "all" | SearchTypeFilter) => void;
  onDirectionChange: (value: "all" | "incoming" | "outgoing") => void;
  onAfterChange: (value: string) => void;
  onBeforeChange: (value: string) => void;
  onOpen: (hit: SearchResultItem) => void;
  onReindex: () => void;
}) {
  const needsRebuild = index?.state === "needs_rebuild";
  const reindexRunning = reindex?.state === "running" || reindex?.state === "finalizing";
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = [sender.trim(), type !== "all", direction !== "all", after, before].filter(Boolean).length;
  return (
    <div className="searchResultsPanel">
      <div className="searchResultsHeader">
        <span className="searchMatchCount">
          {searching
            ? "Searching…"
            : needsRebuild
              ? ""
              : `${(totalMatches ?? 0).toLocaleString()} ${totalMatches === 1 ? "match" : "matches"}${
                  totalMatches > results.length && results.length > 0 ? ` · showing top ${results.length}` : ""
                }`}
        </span>
        <button
          className={`filterToggleButton ${activeFilterCount > 0 ? "hasActive" : ""}`}
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          title={filtersOpen ? "Hide filters" : "Show filters"}
        >
          <SlidersHorizontal size={14} />
          <span>Filters</span>
          {activeFilterCount > 0 && <span className="filterBadge">{activeFilterCount}</span>}
        </button>
      </div>
      {filtersOpen && (
        <div className="searchFilters">
          <input value={sender} onChange={(event) => onSenderChange(event.target.value)} placeholder="Sender" />
          <select value={type} onChange={(event) => onTypeChange(event.target.value as "all" | SearchTypeFilter)}>
            <option value="all">All types</option>
            <option value="text">Text</option>
            <option value="media">Media</option>
            <option value="call">Calls</option>
          </select>
          <select
            value={direction}
            onChange={(event) => onDirectionChange(event.target.value as "all" | "incoming" | "outgoing")}
          >
            <option value="all">Both ways</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
          </select>
          <label className="dateFilter">
            <span>From</span>
            <input type="date" value={after} onChange={(event) => onAfterChange(event.target.value)} />
          </label>
          <label className="dateFilter">
            <span>To</span>
            <input type="date" value={before} onChange={(event) => onBeforeChange(event.target.value)} />
          </label>
        </div>
      )}
      {needsRebuild && (
        <div className="reindexBanner">
          <p>Global search needs a one-time index build for this archive.</p>
          {reindex?.state === "failed" && (
            <p className="reindexError">
              The last index build failed{reindex.error ? `: ${reindex.error}` : "."} It is safe to retry — the build
              restarts from a clean slate.
            </p>
          )}
          {reindexRunning ? (
            <p className="reindexProgress">
              <Loader2 className="spin" size={14} />
              <span>
                {reindex && reindex.totalMessages > 0
                  ? `Indexing ${reindex.processedMessages.toLocaleString()} / ${reindex.totalMessages.toLocaleString()} messages`
                  : "Preparing index build…"}
              </span>
            </p>
          ) : (
            <button type="button" onClick={onReindex}>
              {reindex?.state === "failed" ? "Retry index build" : "Build search index"}
            </button>
          )}
        </div>
      )}
      <div className="searchResults chatList" aria-live="polite">
        {searching && <SkeletonRows />}
        {!searching && error && !needsRebuild && <div className="searchError">{error}</div>}
        {!searching && !error && !needsRebuild && results.length === 0 && (
          <EmptyState icon={<Search size={20} />} text="No matching messages" />
        )}
        {!searching &&
          results.map((hit) => (
            <button key={hit.messageId} className="searchHit" type="button" onClick={() => onOpen(hit)}>
              <span className="searchHitTop">
                <span className="searchHitChat">
                  {hit.chatDisplayName ?? (hit.chatType === "group" ? "Unnamed group" : "Unresolved contact")}
                </span>
                <span className="searchHitTime">{formatDate(hit.sentAt)}</span>
              </span>
              <span className="searchHitMeta">
                {hit.direction === "outgoing" ? "You" : hit.senderDisplayName ?? "Unknown sender"}
                {hit.interpretation ? ` · ${hit.interpretation.label}` : ""}
                {hit.isDeleted ? " · deleted" : ""}
              </span>
              <span className="searchHitSnippet">{renderSearchSnippet(hit.snippet)}</span>
            </button>
          ))}
      </div>
    </div>
  );
}

// Snippets carry private-use highlight markers around matched terms; render
// them as <mark> spans without ever treating snippet text as markup.
function renderSearchSnippet(snippet: string): ReactNode {
  if (!snippet.includes(SEARCH_HIGHLIGHT_START)) {
    return snippet;
  }
  const nodes: ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (rest.length > 0) {
    const start = rest.indexOf(SEARCH_HIGHLIGHT_START);
    if (start < 0) {
      nodes.push(rest);
      break;
    }
    if (start > 0) {
      nodes.push(rest.slice(0, start));
    }
    const afterStart = rest.slice(start + SEARCH_HIGHLIGHT_START.length);
    const end = afterStart.indexOf(SEARCH_HIGHLIGHT_END);
    if (end < 0) {
      nodes.push(afterStart);
      break;
    }
    nodes.push(<mark key={key++}>{afterStart.slice(0, end)}</mark>);
    rest = afterStart.slice(end + SEARCH_HIGHLIGHT_END.length);
  }
  return nodes;
}

function GoogleContactsPanel({ status, busy, onSync, onDisconnect }: {
  status: GoogleContactsStatus | null;
  busy: boolean;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const last = status?.lastSync;
  return (
    <section className="importPanel">
      <div className="panelTitle"><Users size={16} /><span>Google Contacts</span></div>
      {!status ? <p className="muted">Loading local connection status…</p> : !status.configured ? (
        <><p className="muted">Add a Google OAuth web client to enable read-only contact enrichment.</p><small>Callback: {status.callbackUrl}</small></>
      ) : !status.connected ? (
        <><p className="muted">Connect Google to resolve phone-number contacts. Contacts stay in this local archive.</p><a className="primaryButton" href="/api/google-contacts/oauth/start">Connect Google</a></>
      ) : (
        <>
          <p className="muted">Connected{status.accountLabel ? ` as ${status.accountLabel}` : " with read-only contact access"}.</p>
          {last && <p className="muted">Last sync: {last.fetchedPeople.toLocaleString()} people, {last.matchedIdentities.toLocaleString()} matched, {last.improvedNames.toLocaleString()} improved, {last.ambiguousNumbers.toLocaleString()} ambiguous, {last.skippedNumbers.toLocaleString()} skipped{last.contactGroups != null ? `, ${last.contactGroups.toLocaleString()} contact groupings (${(last.groupedNumbers ?? 0).toLocaleString()} numbers)` : ""}{last.personsAutoConnected ? `, ${last.personsAutoConnected.toLocaleString()} auto-connected` : ""}.</p>}
          <div className="buttonRow">
            <button className="primaryButton" disabled={busy} onClick={onSync}>{busy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />} Sync contacts</button>
            <button className="secondaryButton" disabled={busy} onClick={onDisconnect}><Unlink size={16} /> Disconnect</button>
          </div>
        </>
      )}
    </section>
  );
}

function LivePanel({
  status,
  gaps,
  busy,
  progress,
  onImport,
  onLink,
  onRetryGap,
  onRetryMedia,
  onPause,
  onResume,
  onUnlink
}: {
  status: StatusSummary | null;
  gaps: LiveGapWindowRecord[];
  busy: string | null;
  progress: LiveSyncProgress | null;
  onImport: () => void;
  onLink: () => void;
  onRetryGap: (id: number) => void;
  onRetryMedia: () => void;
  onPause: () => void;
  onResume: () => void;
  onUnlink: () => void;
}) {
  const live = status?.live;
  const [livePanelOpen, setLivePanelOpen] = useState(true);
  const setup = status?.setup;
  const state = setup?.state ?? "empty_archive";
  const baselineReady = Boolean(live?.baseline.ready);
  const hasLiveSession = Boolean(live?.session && live.session.status !== "not_configured");
  const actionableGaps = gaps.filter((gap) => gap.status !== "uncertain");
  const uncertainCount = (live?.gapGroups ?? []).filter((group) => group.status === "uncertain").reduce((sum, group) => sum + group.count, 0);
  const identityHealth = live?.identityHealth;
  const identityIssues = (identityHealth?.unnamedGroups ?? 0) + (identityHealth?.unresolvedLids ?? 0);
  const health =
    live?.session?.status === "logged_out" || actionableGaps.length || identityIssues
      ? "needs_user_action"
      : live?.session?.status === "connected"
        ? "healthy"
        : baselineReady
          ? "ready"
          : "disconnected";
  return (
    <section className={`livePanel ${livePanelOpen ? "" : "collapsed"}`}>
      <button className="panelToggle" type="button" aria-expanded={livePanelOpen} onClick={() => setLivePanelOpen((current) => !current)}>
        <span className="panelTitle">
          <Signal size={16} />
          <span>Live Sync</span>
          <span className={`healthDot ${health}`} />
        </span>
        {livePanelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {livePanelOpen && (
        <>
          {progress?.active && <SyncProgress progress={progress} />}
          <div className="statusGrid">
            <Metric label="State" value={state.replaceAll("_", " ")} />
            <Metric label="Open gaps" value={String(live?.openGapCount ?? 0)} />
            <Metric label="Messages" value={live?.totals.messages.toLocaleString() ?? "0"} />
            <Metric label="Updates" value={live?.totals.updates.toLocaleString() ?? "0"} />
          </div>
          <div className="statusLine">
            {setup?.description ??
              live?.baseline.warning ??
              live?.session?.lastError ??
              (live?.currentRun ? `running | ${formatDate(live.currentRun.startedAt)}` : "Import a backup, then link WhatsApp from this app.")}
          </div>
          {live?.baseline && (
            <div className={`baselineNotice ${baselineReady ? "ready" : "blocked"}`}>
              <span>{baselineReady ? "Imported archive baseline is ready." : live.baseline.warning}</span>
              <span>
                {live.baseline.messageCount.toLocaleString()} messages
                {live.baseline.latestMessageAt ? ` | latest ${formatDate(live.baseline.latestMessageAt)}` : ""}
              </span>
            </div>
          )}
          {uncertainCount > 0 && (
            <div className="baselineNotice blocked">
              <span>
                {uncertainCount.toLocaleString()} chat window{uncertainCount === 1 ? "" : "s"} cannot be proven complete (platform history
                limits). This is informational, not actionable.
              </span>
            </div>
          )}
          {identityIssues > 0 && (
            <div className="baselineNotice blocked">
              <span>
                Identity health: {identityHealth?.unnamedGroups ? `${identityHealth.unnamedGroups.toLocaleString()} unnamed group${identityHealth.unnamedGroups === 1 ? "" : "s"}` : ""}
                {identityHealth?.unnamedGroups && identityHealth?.unresolvedLids ? ", " : ""}
                {identityHealth?.unresolvedLids ? `${identityHealth.unresolvedLids.toLocaleString()} unresolved contact identit${identityHealth.unresolvedLids === 1 ? "y" : "ies"}` : ""}.
                {" "}Look for "Unnamed group" and "Unresolved contact" entries in the chat list.
              </span>
            </div>
          )}
          {actionableGaps.length > 0 && (
            <div className="gapList">
              {actionableGaps.slice(0, 5).map((gap) => (
                <div className={`gapItem ${gap.status}`} key={gap.id ?? `${gap.chatSourceId}-${gap.startAtMs}`}>
                  <div>
                    <strong>{gap.chatSourceId}</strong>
                    <span>
                      {gap.status.replaceAll("_", " ")} | {formatDate(msToIso(gap.startAtMs))} - {formatDate(msToIso(gap.endAtMs))}
                    </span>
                  </div>
                  {gap.id && (
                    <button className="miniButton" type="button" disabled={Boolean(busy)} onClick={() => onRetryGap(gap.id!)}>
                      <RefreshCcw size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {live?.media && (live.media.assets > 0 || live.media.pending + live.media.downloading + live.media.retry + live.media.failed + live.media.expiredUnrecoverable > 0) && (
            <div className="mediaStatusRow">
              <span>
                Media: {live.media.assets.toLocaleString()} archived
                {live.media.pending + live.media.downloading + live.media.retry > 0
                  ? ` | ${(live.media.pending + live.media.downloading + live.media.retry).toLocaleString()} downloading`
                  : ""}
                {live.media.failed > 0 ? ` | ${live.media.failed.toLocaleString()} failed` : ""}
                {live.media.expiredUnrecoverable > 0 ? ` | ${live.media.expiredUnrecoverable.toLocaleString()} unrecoverable` : ""}
              </span>
              {live.media.failed + live.media.expiredUnrecoverable + live.media.retry > 0 && (
                <button className="miniButton" type="button" disabled={Boolean(busy)} onClick={onRetryMedia} title="Retry stuck media downloads">
                  <RefreshCcw size={13} />
                </button>
              )}
            </div>
          )}
          {setup?.primaryAction === "import_backup" && (
            <button className="primaryButton fullButton" onClick={onImport} disabled={Boolean(busy)} type="button">
              <Upload size={16} />
              Import backup
            </button>
          )}
          {(setup?.primaryAction === "link_whatsapp" || setup?.primaryAction === "reconnect" || setup?.primaryAction === "repair_link") && (
            <button
              className="primaryButton fullButton"
              onClick={onLink}
              disabled={Boolean(busy) || (setup.primaryAction === "link_whatsapp" && !baselineReady)}
              type="button"
            >
              <QrCode size={16} />
              {setup.primaryAction === "reconnect" ? "Reconnect" : setup.primaryAction === "repair_link" ? "Re-pair WhatsApp" : "Link WhatsApp"}
            </button>
          )}
          {setup?.primaryAction === "resume_sync" && (
            <button className="primaryButton fullButton" onClick={onResume} disabled={Boolean(busy)} type="button">
              <Play size={16} />
              Resume sync
            </button>
          )}
          {live?.session?.status === "connected" && (
            <button className="secondaryButton subtleButton" onClick={onPause} disabled={Boolean(busy)} type="button">
              <Pause size={16} />
              Pause sync
            </button>
          )}
          {hasLiveSession && (
            <button className="secondaryButton dangerButton" onClick={onUnlink} disabled={Boolean(busy)} type="button">
              <Unlink size={16} />
              Unlink device
            </button>
          )}
        </>
      )}
    </section>
  );
}

// The brain's operator panel: coverage truth, run-due alert, and full provider
// control (opt-in, model choice, probe) — manual-first, everything from the UI.
function BrainPanel({
  overview,
  run,
  busy,
  onProviderAction,
  onRun,
  onRegenerate,
  onSetOwner,
  onReset
}: {
  overview: BrainOverview | null;
  run: BrainRunProgress | null;
  busy: string | null;
  onProviderAction: (body: {
    action: "enable" | "disable" | "probe" | "set-model";
    provider?: Exclude<BrainProviderName, "extractive">;
    model?: string;
  }) => void;
  onRun: (body: { mode: "model" | "extractive"; model?: string | null; maxChats?: number }) => void;
  onRegenerate: (body: { model?: string | null }) => void;
  onSetOwner: (displayName: string | null) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [ownerDraft, setOwnerDraft] = useState("");
  // How many backlog chats one Run drains — small for a quick test, larger to
  // catch up. Model runs still stop at the daily/hourly budget regardless.
  const [chatsToRun, setChatsToRun] = useState(3);
  const provider = overview?.provider;
  const runDue = Boolean(overview?.scheduler.runDue);
  const running = run?.state === "running";
  useEffect(() => {
    setOwnerDraft(overview?.ownerName ?? "");
  }, [overview?.ownerName]);
  const activeProviderName = provider?.provider ?? "extractive";
  const modelOptions = provider && provider.provider !== "extractive" ? provider.models[provider.provider] ?? [] : [];
  return (
    <section className={`memoryPanel ${open ? "" : "collapsed"}`}>
      <button className="panelToggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="panelTitle">
          <Brain size={16} />
          <span>Brain</span>
          {runDue && <span className="dueBadge">run due</span>}
          {provider?.degraded && <AlertTriangle size={14} className="degradedIcon" />}
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && (
        <>
          <div className="statusGrid">
            <Metric label="Coverage" value={`${overview?.coveragePercent ?? 0}%`} />
            <Metric label="Backlog chats" value={overview?.chatsWithBacklog.toLocaleString() ?? "0"} />
            <Metric
              label="Pending msgs"
              value={((overview?.totalVisibleMessages ?? 0) - (overview?.assimilatedVisibleMessages ?? 0)).toLocaleString()}
            />
            <Metric label="Calls today" value={overview?.usageToday.calls.toLocaleString() ?? "0"} />
            {overview?.validationIssues && overview.validationIssues.error + overview.validationIssues.warning > 0 && (
              <Metric
                label="Quality flags"
                value={`${overview.validationIssues.error + overview.validationIssues.warning}`}
              />
            )}
            {(overview?.mediaGaps?.length ?? 0) > 0 && (
              <div
                className="metric"
                title={`Where unavailable media hurt an inference (the demand stat for building media interpretation): ${overview!.mediaGaps!
                  .map((gap) => `${gap.modality} ${gap.impact}: ${gap.count}`)
                  .join(", ")}`}
              >
                <span>Media gaps</span>
                <strong>{overview!.mediaGaps!.reduce((sum, gap) => sum + gap.count, 0)}</strong>
              </div>
            )}
            {(overview?.resolutionDebt?.episodesWithUnresolved ?? 0) > 0 && (
              <div
                className="metric"
                title={`Episodes still referring to people by number. Saving these contacts repairs old episodes and search with no model call — highest payoff first: ${overview!.resolutionDebt!.topIdentities
                  .map((identity) => `${identity.label} (${identity.messageCount.toLocaleString()} msgs, ${identity.episodeCount} ep)`)
                  .join(", ")}`}
              >
                <span>Unresolved people</span>
                <strong>{overview!.resolutionDebt!.distinctIdentities.toLocaleString()}</strong>
              </div>
            )}
          </div>
          {(overview?.resolutionDebt?.episodesWithUnresolved ?? 0) > 0 && (
            <div className="brainHint">
              {overview!.resolutionDebt!.episodesWithUnresolved.toLocaleString()} episode
              {overview!.resolutionDebt!.episodesWithUnresolved === 1 ? "" : "s"} involve unresolved participants (
              {overview!.resolutionDebt!.distinctIdentities.toLocaleString()} distinct number
              {overview!.resolutionDebt!.distinctIdentities === 1 ? "" : "s"}). Save the top contact
              {overview!.resolutionDebt!.topIdentities.length === 1 ? "" : "s"} to repair the most — with no model call:{" "}
              {overview!.resolutionDebt!.topIdentities
                .slice(0, 3)
                .map((identity) => `${identity.label} (${identity.messageCount.toLocaleString()})`)
                .join(", ")}
              .
            </div>
          )}
          {runDue && !running && (
            <div className="brainDueAlert">
              <AlertTriangle size={14} />
              <span>
                {overview?.scheduler.dueReason} Automatic runs are {overview?.scheduler.mode} — pick a provider and model, then
                run when your quota allows.
              </span>
            </div>
          )}
          {running && (
            <div className="brainDueAlert">
              <Loader2 className="spin" size={14} />
              <span>
                Run in progress ({run?.mode}
                {run?.model ? `/${run.model}` : ""}): {run?.episodesCommitted ?? 0} episodes from {run?.processedChats ?? 0}/
                {run?.totalChats ?? 0} chats{run?.currentChat ? ` — now: ${run.currentChat}` : ""}. {run?.modelCalls ?? 0} model
                calls.
              </span>
            </div>
          )}
          {!running && overview?.latestRun && (
            <div className="brainDueAlert">
              <span>
                Last run: <strong>{overview.latestRun.status}</strong>
                {overview.latestRun.totals
                  ? ` — ${overview.latestRun.totals.episodes ?? 0} episodes${
                      overview.latestRun.totals.extractive ? ` (${overview.latestRun.totals.extractive} extractive)` : ""
                    }`
                  : ""}
                {` · ${formatDate(overview.latestRun.finishedAt ?? overview.latestRun.startedAt)}`}
                {overview.latestRun.errorMessage ? ` — ${overview.latestRun.errorMessage}` : ""}
              </span>
            </div>
          )}
          <div className="brainProviderControls">
            <label>
              <span>Your name</span>
              <input
                value={ownerDraft}
                disabled={Boolean(busy)}
                placeholder="e.g. Abhishek"
                onChange={(event) => setOwnerDraft(event.target.value)}
                onBlur={() => {
                  if (ownerDraft.trim() !== (overview?.ownerName ?? "")) {
                    onSetOwner(ownerDraft.trim() || null);
                  }
                }}
                title='Labels your own messages in episodes and search ("Abhishek (me)" instead of "Me"), and tells the model who you are'
              />
            </label>
            <label>
              <span>Provider</span>
              <select
                value={activeProviderName}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  const value = event.target.value as BrainProviderName;
                  if (value === "extractive") {
                    onProviderAction({ action: "disable" });
                  } else {
                    onProviderAction({ action: "enable", provider: value });
                  }
                }}
              >
                <option value="extractive">extractive (no model)</option>
                <option value="claude-cli">claude (WSL CLI)</option>
                <option value="codex">codex (GPT OAuth)</option>
              </select>
            </label>
            {provider && provider.provider !== "extractive" && (
              <label>
                <span>Model{provider.reasoningEffort ? ` · effort ${provider.reasoningEffort}` : ""}</span>
                <select
                  value={provider.model ?? modelOptions[0] ?? ""}
                  disabled={Boolean(busy)}
                  onChange={(event) =>
                    onProviderAction({
                      action: "set-model",
                      provider: provider.provider as Exclude<BrainProviderName, "extractive">,
                      model: event.target.value
                    })
                  }
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {provider && provider.provider !== "extractive" && (
              <button
                className="miniButton"
                type="button"
                disabled={Boolean(busy) || running}
                onClick={() => onProviderAction({ action: "probe" })}
                title="Make one tiny model call to verify the provider end-to-end"
              >
                Probe
              </button>
            )}
            <label title="How many backlog chats this run assimilates (newest first). Keep it small for a quick test.">
              <span>Chats</span>
              <input
                type="number"
                min={1}
                max={5000}
                value={chatsToRun}
                disabled={Boolean(busy) || running}
                onChange={(event) => setChatsToRun(Math.max(1, Math.min(5000, Number(event.target.value) || 1)))}
              />
            </label>
            <button
              className="primaryButton"
              type="button"
              disabled={Boolean(busy) || running || !overview || overview.chatsWithBacklog === 0 || Boolean(provider?.sessionMissing)}
              onClick={() =>
                onRun(
                  provider && provider.provider !== "extractive"
                    ? { mode: "model", model: provider.model, maxChats: chatsToRun }
                    : { mode: "extractive", maxChats: chatsToRun }
                )
              }
              title={
                provider && provider.provider !== "extractive"
                  ? `Assimilate the top ${chatsToRun} backlog chat(s) with ${provider.provider}/${provider.model} (stops at your daily/hourly budget)`
                  : `Assimilate the top ${chatsToRun} backlog chat(s) with extractive placeholders (no model calls; regenerable later)`
              }
            >
              {running ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              Run
            </button>
            {(overview?.regenerableEpisodes ?? 0) > 0 && (
              <button
                className="miniButton"
                type="button"
                disabled={Boolean(busy) || running || !provider || provider.provider === "extractive" || Boolean(provider.sessionMissing)}
                onClick={() => onRegenerate({ model: provider?.model ?? null })}
                title={`Re-derive ${overview?.regenerableEpisodes} extractive or stale-version episode(s) from their stored windows under the current extraction contract (v${overview?.extractionVersion ?? "?"}); old episodes become superseded, watermarks untouched. Needs a model provider.`}
              >
                <RefreshCcw size={14} />
                Regenerate {overview?.regenerableEpisodes}
              </button>
            )}
            <button
              className="miniButton dangerButton"
              type="button"
              disabled={Boolean(busy) || running}
              onClick={onReset}
              title="Delete all generated episodes, claims, citations, and coverage watermarks (raw messages untouched); the next run starts from scratch"
            >
              <Trash2 size={14} />
              Reset
            </button>
          </div>
          <div className={`statusLine ${provider?.degraded ? "degradedLine" : ""}`}>{provider?.message}</div>
        </>
      )}
    </section>
  );
}

function MemoryPanel({
  status,
  busy,
  query,
  result,
  citation,
  onQueryChange,
  onRun,
  onPreview,
  onQuery,
  onOpenCitation,
  onEnableCodex,
  onDisableProvider
}: {
  status: StatusSummary | null;
  busy: string | null;
  query: string;
  result: MemoryQueryResult | null;
  citation: MemoryCitationResolution | null;
  onQueryChange: (value: string) => void;
  onRun: () => void;
  onPreview: () => void;
  onQuery: () => void;
  onOpenCitation: (citation: string) => void;
  onEnableCodex: () => void;
  onDisableProvider: () => void;
}) {
  const [open, setOpen] = useState(false);
  const memory = status?.memory;
  const provider = memory?.provider;
  const active = memory?.activeRun;
  return (
    <section className={`memoryPanel ${open ? "" : "collapsed"}`}>
      <button className="panelToggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="panelTitle">
          <Sparkles size={16} />
          <span>Second Brain</span>
          {active && <Loader2 className="spin" size={16} />}
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && (
        <>
          <div className="statusGrid">
            <Metric label="Pages" value={memory?.pageCount.toLocaleString() ?? "0"} />
            <Metric label="Citations" value={memory?.citationCount.toLocaleString() ?? "0"} />
            <Metric label="Stale" value={memory?.stalePageCount.toLocaleString() ?? "0"} />
            <Metric label="Provider" value={provider?.provider ?? "local"} />
          </div>
          <div className="statusLine">
            {memory?.latestRun
              ? `${memory.latestRun.status} | ${formatDate(memory.latestRun.finishedAt ?? memory.latestRun.startedAt)} | .wapp-brain/memory/pages`
              : "No memory run yet. Pages will be Markdown with Obsidian-friendly front matter."}
          </div>
          <div className="memoryActions">
            <button className="primaryButton fullButton" onClick={onRun} disabled={Boolean(busy) || !status?.counts.messages} type="button">
              {busy === "Running memory REM" ? <Loader2 className="spin" size={16} /> : <Moon size={16} />}
              Run REM
            </button>
            <button className="secondaryButton subtleButton" onClick={onPreview} disabled={Boolean(busy) || !status?.counts.messages} type="button">
              <Eye size={16} />
              Preview evidence
            </button>
          </div>
          <div className="providerRow">
            <span>{provider?.message ?? "Local memory provider ready."}</span>
            {provider?.remoteModelEnabled ? (
              <button className="miniButton" onClick={onDisableProvider} disabled={Boolean(busy)} type="button">
                Off
              </button>
            ) : (
              <button className="miniButton" onClick={onEnableCodex} disabled={Boolean(busy)} type="button">
                Codex
              </button>
            )}
          </div>
          <div className="memorySearch">
            <div className="searchBox">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onQuery();
                }}
                placeholder="Ask local memory"
              />
            </div>
            <button className="secondaryButton" onClick={onQuery} disabled={Boolean(busy) || !query.trim()} type="button">
              <Search size={16} />
              Search
            </button>
          </div>
          {result && (
            <div className="memoryResults">
              <p>{result.answer}</p>
              {result.evidence.slice(0, 5).map((item, index) => (
                <div className={`memoryEvidence ${item.layer}`} key={`${item.layer}-${index}`}>
                  <strong>{item.layer === "long_term" ? "Long-term" : "Short-term"} | {item.title}</strong>
                  <span>{item.snippet}</span>
                  {item.citation && (
                    <button className="miniButton" type="button" onClick={() => onOpenCitation(item.citation!.sourceMessageKey)}>
                      Open source
                    </button>
                  )}
                </div>
              ))}
              {citation && (
                <div className={`citationContext ${citation.stale ? "stale" : ""}`}>
                  <strong>{citation.stale ? "Stale citation" : "Citation context"}</strong>
                  {citation.nearbyMessages.map((message) => (
                    <span key={message.sourceMessageKey}>
                      {message.sentAt ? formatTime(message.sentAt) : "No time"} | {message.senderDisplayName ?? "Unknown"}: {message.text ?? `[${message.messageType}]`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function OnboardingPanel({
  status,
  busy,
  progress,
  onImport,
  onLink,
  onResume,
  onReviewGaps
}: {
  status: StatusSummary | null;
  busy: string | null;
  progress: LiveSyncProgress | null;
  onImport: () => void;
  onLink: () => void;
  onResume: () => void;
  onReviewGaps: () => void;
}) {
  const setup = status?.setup;
  const action = setup?.primaryAction ?? "import_backup";
  // The sheen reads as "working" — show it only while something actually runs.
  const processing = Boolean(busy) || Boolean(status?.memory?.activeRun) || Boolean(progress?.active);
  const primary = {
    import_backup: { label: "Import backup", icon: <Upload size={17} />, onClick: onImport },
    link_whatsapp: { label: "Link WhatsApp", icon: <QrCode size={17} />, onClick: onLink },
    monitor_sync: { label: "View live health", icon: <Signal size={17} />, onClick: onReviewGaps },
    resume_sync: { label: "Resume sync", icon: <Play size={17} />, onClick: onResume },
    reconnect: { label: "Reconnect", icon: <Link2 size={17} />, onClick: onLink },
    repair_link: { label: "Re-pair WhatsApp", icon: <QrCode size={17} />, onClick: onLink },
    review_gaps: { label: "Review gaps", icon: <AlertTriangle size={17} />, onClick: onReviewGaps }
  }[action];
  return (
    <section className={`onboardingPanel ${setup?.state ?? "loading"}`}>
      {processing && <div className="premiumSheen" />}
      <div className="onboardingHeader">
        <span className="eyebrow">
          <Sparkles size={14} />
          Guided setup
        </span>
        <h2>{setup?.label ?? "Checking local archive"}</h2>
        <p>{setup?.description ?? "Reading local status from 127.0.0.1."}</p>
      </div>
      <div className="phaseRail" aria-label="Setup progress">
        <PhaseStep label="Backup" active={setup?.phase === "backup"} done={Boolean(status?.latestImport)} />
        <PhaseStep label="Archive" active={setup?.phase === "archive"} done={Boolean(status?.counts.messages)} />
        <PhaseStep label="Live Sync" active={setup?.phase === "live"} done={status?.setup?.state === "syncing"} />
      </div>
      {setup?.blockingReason && (
        <div className="setupReason">
          <AlertTriangle size={15} />
          <span>{setup.blockingReason}</span>
        </div>
      )}
      {progress?.active && <SyncProgress progress={progress} />}
      <button className="heroAction" onClick={primary.onClick} disabled={Boolean(busy) || !setup} type="button">
        {busy ? <Loader2 className="spin" size={17} /> : primary.icon}
        {primary.label}
        <ArrowRight size={16} />
      </button>
    </section>
  );
}

function PhaseStep({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={`phaseStep ${active ? "active" : ""} ${done ? "done" : ""}`}>
      {done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
      <span>{label}</span>
    </div>
  );
}

function ImportLauncher({ status, onOpen }: { status: StatusSummary | null; onOpen: () => void }) {
  return (
    <section className="importPanel collapsed">
      <button className="panelToggle" type="button" onClick={onOpen}>
        <span className="panelTitle">
          <Upload size={16} />
          <span>{hasArchiveData(status) ? "Import / re-import" : "Import backup"}</span>
        </span>
        <ChevronRight size={16} />
      </button>
    </section>
  );
}

export type ImportStep = "folder" | "key" | "mode" | "import";

function ImportWizard({
  status,
  initialJob,
  onClose,
  onComplete,
  onStopped,
  step: controlledStep,
  onStepChange
}: {
  status: StatusSummary | null;
  initialJob: ImportJobSummary | null;
  onClose: () => void;
  onComplete: (job: ImportJobSummary) => void;
  onStopped: (job: ImportJobSummary) => void;
  // When provided, the wizard's step is controlled by the route (import
  // sub-routes) and step changes are reported instead of held internally.
  step?: ImportStep;
  onStepChange?: (step: ImportStep) => void;
}) {
  const pickerAvailable = Boolean(status?.pickerAvailable);
  const [internalStep, setInternalStep] = useState<ImportStep>(initialJob ? "import" : "folder");
  const step = controlledStep ?? internalStep;
  const setStep = (next: ImportStep) => {
    (onStepChange ?? setInternalStep)(next);
  };
  const [backupPath, setBackupPath] = useState("");
  const [manifest, setManifest] = useState<BackupDetectionManifest | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrides, setOverrides] = useState({ msgstorePath: "", waPath: "", mediaPath: "" });
  const [key, setKey] = useState("");
  const [verification, setVerification] = useState<ImportVerificationSummary | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [replaceConfirm, setReplaceConfirm] = useState("");
  const [keepDecrypted, setKeepDecrypted] = useState(false);
  const [job, setJob] = useState<ImportJobSummary | null>(initialJob);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoCloseIn, setAutoCloseIn] = useState<number | null>(null);

  // A finished import closes itself after a short countdown shown on the
  // Done button; any interaction path through onClose cancels it implicitly.
  useEffect(() => {
    if (job?.status !== "completed") {
      setAutoCloseIn(null);
      return;
    }
    setAutoCloseIn(5);
    const timer = window.setInterval(() => {
      setAutoCloseIn((current) => (current == null ? current : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job?.status]);

  useEffect(() => {
    if (autoCloseIn === 0) {
      onClose();
    }
  }, [autoCloseIn, onClose]);

  useEffect(() => {
    if (initialJob) {
      setJob(initialJob);
      setStep("import");
    }
  }, [initialJob?.id]);

  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    const timer = window.setInterval(() => {
      getImportJob(job.id)
        .then((next) => {
          setJob(next);
          if (next.status === "completed") {
            onComplete(next);
          } else if (next.status === "cancelled") {
            onStopped(next);
          }
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Could not read import progress."));
    }, 300);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, onComplete, onStopped]);

  const resolvedMsgstore = overrides.msgstorePath.trim() || manifest?.msgstore?.path || "";
  const resolvedWa = overrides.waPath.trim() || manifest?.wa?.path || "";
  const resolvedMedia = overrides.mediaPath.trim() || manifest?.media?.path || "";
  const hasSelectedBackup = Boolean(resolvedMsgstore);
  const needsReplaceConfirmation = hasArchiveData(status) && mode === "replace";
  const canStart = verification?.ok && (!needsReplaceConfirmation || replaceConfirm.trim().toLowerCase() === "replace");

  // In routed mode a later step opened without its prerequisite (no selected
  // backup / unverified key) and no active job is inconsistent — fall back to the
  // first step so a cold sub-route URL never renders a broken wizard.
  useEffect(() => {
    if (!onStepChange || job) {
      return;
    }
    if ((step === "key" && !hasSelectedBackup) || (step === "mode" && !verification?.ok) || (step === "import" && !job)) {
      onStepChange("folder");
    }
  }, [onStepChange, job, step, hasSelectedBackup, verification?.ok]);

  // Scan a folder (native-picked or typed) into a detection manifest. Shallow and
  // async on the server, so it never blocks; the wizard shows a busy indicator.
  async function detect(root: string) {
    const trimmed = root.trim();
    if (!trimmed) return;
    setBusy("Scanning backup folder…");
    setError(null);
    setVerification(null);
    try {
      const result = await detectBackupFolder(trimmed);
      setManifest(result.manifest);
      if (!result.manifest.valid) {
        setError("No msgstore backup was found in that folder. Pick the folder that contains msgstore.db.crypt15, or set an advanced path override.");
      }
    } catch (err) {
      setManifest(null);
      setError(err instanceof Error ? err.message : "Could not scan the backup folder.");
    } finally {
      setBusy(null);
    }
  }

  async function browseFolder() {
    setBusy("Waiting for you to choose a folder…");
    setError(null);
    try {
      const result = await pickImportPath("backup-root", backupPath || null);
      if (result.path) {
        setBackupPath(result.path);
        await detect(result.path);
      } else if (result.unavailable) {
        setError(
          result.reason && result.reason !== "busy"
            ? result.reason
            : "The native folder picker is unavailable. Type the backup folder path instead."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the folder picker.");
    } finally {
      setBusy(null);
    }
  }

  async function browseOverride(kind: PickKind, field: "msgstorePath" | "waPath" | "mediaPath") {
    setError(null);
    const result = await pickImportPath(kind, backupPath || null).catch(() => null);
    if (result?.path) {
      const picked = result.path;
      setOverrides((current) => ({ ...current, [field]: picked }));
      setVerification(null);
    }
  }

  async function verify() {
    setBusy("Verifying key");
    setError(null);
    try {
      const result = await verifyImportKey({
        msgstorePath: resolvedMsgstore || null,
        waPath: resolvedWa || null,
        key: key || null
      });
      setVerification(result.verification);
      if (result.verification.ok) setStep("mode");
    } catch (err) {
      setVerification(null);
      setError(err instanceof Error ? err.message : "Key verification failed.");
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy("Starting import");
    setError(null);
    try {
      const result = await startImportJob({
        mode,
        key: key || null,
        keepDecrypted,
        paths: {
          msgstorePath: resolvedMsgstore || undefined,
          waPath: resolvedWa || undefined,
          mediaPath: resolvedMedia || undefined
        }
      });
      setKey("");
      setJob(result.job);
      setStep("import");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start import.");
    } finally {
      setBusy(null);
    }
  }

  async function stopImport() {
    if (!job || (job.status !== "queued" && job.status !== "running" && job.status !== "cancelling")) {
      return;
    }
    if (
      !window.confirm(
        "Stop this import and roll back any archive changes written by this job? You can start again afterward."
      )
    ) {
      return;
    }
    setBusy("Stopping import");
    setError(null);
    try {
      const result = await cancelImportJob(job.id);
      setJob(result.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop import.");
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    if (job && (job.status === "queued" || job.status === "running" || job.status === "cancelling")) {
      if (!window.confirm("The import will keep running in the local server. Close the progress view anyway?")) {
        return;
      }
    }
    onClose();
  }

  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <section className="wizardModal">
        <div className="wizardHeader">
          <div>
            <span className="eyebrow">
              <ShieldCheck size={14} />
              Local import wizard
            </span>
            <h2 id="import-title">Load WhatsApp backup</h2>
            <p>Pick your backup folder, verify the key locally, choose merge or replace, then watch the import phases.</p>
          </div>
          <button className="iconButton" onClick={() => void close()} type="button" aria-label="Close import wizard">
            <X size={16} />
          </button>
        </div>
        <div className="wizardSteps">
          {["folder", "key", "mode", "import"].map((item, index) => (
            <div className={`wizardStep ${step === item ? "active" : ""}`} key={item}>
              <span>{index + 1}</span>
              <strong>{item === "folder" ? "Folder" : item === "key" ? "Verify" : item === "mode" ? "Mode" : "Import"}</strong>
            </div>
          ))}
        </div>
        {error && (
          <div className="wizardError">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
        {step === "folder" && (
          <div className="wizardBody">
            <div className="filePickRow">
              <div className="fileIcon"><FolderOpen size={18} /></div>
              <div>
                <strong>WhatsApp backup folder</strong>
                <p>
                  {backupPath ||
                    "Select the folder holding msgstore.db.crypt15, wa.db.crypt15, and your Media folder. Everything is read in place — nothing is uploaded."}
                </p>
              </div>
              {pickerAvailable && (
                <button className="fileButton" type="button" onClick={() => void browseFolder()} disabled={Boolean(busy)}>
                  Browse…
                </button>
              )}
            </div>
            <label className="wizardField">
              <span>{pickerAvailable ? "Or type the backup folder path" : "Backup folder path"}</span>
              <div className="pathWithButton">
                <input
                  value={backupPath}
                  onChange={(event) => setBackupPath(event.target.value)}
                  onBlur={() => (backupPath.trim() ? void detect(backupPath) : undefined)}
                  autoComplete="off"
                  placeholder="e.g. D:\\Backups\\WhatsApp"
                />
                <button
                  className="textButton"
                  type="button"
                  onClick={() => void detect(backupPath)}
                  disabled={!backupPath.trim() || Boolean(busy)}
                >
                  Detect
                </button>
              </div>
            </label>
            {busy && (
              <div className="wizardBusy">
                <Loader2 className="spin" size={16} />
                <span>{busy}</span>
              </div>
            )}
            {manifest && <DetectionSummary manifest={manifest} />}
            <button className="textButton" type="button" onClick={() => setAdvancedOpen((current) => !current)}>
              {advancedOpen ? "Hide advanced overrides" : "Advanced: set file paths manually"}
            </button>
            {advancedOpen && (
              <div className="manualPathGrid">
                <OverrideInput
                  label="msgstore path"
                  value={overrides.msgstorePath}
                  pickerAvailable={pickerAvailable}
                  onChange={(value) => setOverrides((current) => ({ ...current, msgstorePath: value }))}
                  onBrowse={() => void browseOverride("msgstore", "msgstorePath")}
                />
                <OverrideInput
                  label="wa.db path"
                  value={overrides.waPath}
                  pickerAvailable={pickerAvailable}
                  onChange={(value) => setOverrides((current) => ({ ...current, waPath: value }))}
                  onBrowse={() => void browseOverride("wa", "waPath")}
                />
                <OverrideInput
                  label="Media folder path"
                  value={overrides.mediaPath}
                  pickerAvailable={pickerAvailable}
                  onChange={(value) => setOverrides((current) => ({ ...current, mediaPath: value }))}
                  onBrowse={() => void browseOverride("media", "mediaPath")}
                />
              </div>
            )}
            <WizardActions
              busy={busy}
              primaryLabel="Continue to key"
              primaryIcon={<ArrowRight size={16} />}
              primaryDisabled={!hasSelectedBackup || Boolean(busy)}
              onPrimary={() => setStep("key")}
              onBack={null}
            />
          </div>
        )}
        {step === "key" && (
          <div className="wizardBody">
            <div className="keyBox">
              <FileKey2 size={20} />
              <div>
                <strong>Key verification happens locally</strong>
                <p>The raw key is used only for this local operation and is not saved in the archive.</p>
              </div>
            </div>
            <label className="wizardField">
              <span>64-character backup key</span>
              <input value={key} onChange={(event) => setKey(event.target.value)} type="password" autoComplete="off" placeholder="Paste key here" />
            </label>
            {busy === "Verifying key" && (
              <div className="wizardBusy">
                <Loader2 className="spin" size={16} />
                <span>Verifying key locally…</span>
              </div>
            )}
            {verification && (
              <div className="verifySuccess">
                <CheckCircle2 size={16} />
                <span>{verification.message}</span>
              </div>
            )}
            <WizardActions
              busy={busy}
              primaryLabel="Verify locally"
              primaryIcon={<ShieldCheck size={16} />}
              primaryDisabled={Boolean(busy) || !key}
              onPrimary={() => void verify()}
              onBack={() => setStep("folder")}
            />
          </div>
        )}
        {step === "mode" && (
          <div className="wizardBody">
            <div className="modeGrid">
              <button className={`modeCard ${mode === "merge" ? "selected" : ""}`} type="button" onClick={() => setMode("merge")}>
                <Download size={18} />
                <strong>Merge</strong>
                <span>Keep existing archive records and idempotently add what this backup contains.</span>
              </button>
              <button className={`modeCard danger ${mode === "replace" ? "selected" : ""}`} type="button" onClick={() => setMode("replace")}>
                <Trash2 size={18} />
                <strong>Clear and replace</strong>
                <span>Reset archive data and live recovery state, then import this backup as the new baseline.</span>
              </button>
            </div>
            <label className="checkRow wizardCheck">
              <input type="checkbox" checked={keepDecrypted} onChange={(event) => setKeepDecrypted(event.target.checked)} />
              <span>Keep decrypted working database after import</span>
            </label>
            {needsReplaceConfirmation && (
              <label className="wizardField">
                <span>Type replace to confirm clearing {status?.counts.messages.toLocaleString() ?? "0"} archived messages</span>
                <input value={replaceConfirm} onChange={(event) => setReplaceConfirm(event.target.value)} autoComplete="off" />
              </label>
            )}
            <WizardActions
              busy={busy}
              primaryLabel="Start import"
              primaryIcon={<Download size={16} />}
              primaryDisabled={!canStart || Boolean(busy)}
              onPrimary={() => void start()}
              onBack={() => setStep("key")}
            />
          </div>
        )}
        {step === "import" && (
          <div className="wizardBody">
            <ImportProgress job={job} />
            <WizardActions
              busy={busy}
              primaryLabel={
                job?.status === "completed"
                  ? autoCloseIn != null
                    ? `Done (${autoCloseIn})`
                    : "Done"
                  : job?.status === "cancelled" || job?.status === "failed"
                    ? "Done"
                    : job?.status === "cancelling"
                      ? "Stopping"
                      : "Importing"
              }
              primaryIcon={job?.status === "completed" ? <CheckCircle2 size={16} /> : job?.status === "cancelled" || job?.status === "failed" ? <X size={16} /> : <Loader2 className="spin" size={16} />}
              primaryDisabled={job?.status !== "completed" && job?.status !== "cancelled" && job?.status !== "failed"}
              onPrimary={onClose}
              onBack={null}
              dangerLabel={job?.status === "queued" || job?.status === "running" || job?.status === "cancelling" ? "Stop import" : null}
              dangerIcon={job?.status === "cancelling" ? <Loader2 className="spin" size={16} /> : <CircleStop size={16} />}
              dangerDisabled={Boolean(busy) || job?.status === "cancelling"}
              onDanger={() => void stopImport()}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function DetectionSummary({ manifest }: { manifest: BackupDetectionManifest }) {
  const rows: Array<{ icon: ReactNode; label: string; value: string; ok: boolean }> = [
    {
      icon: <Database size={16} />,
      label: "Messages",
      value: manifest.msgstore ? manifest.msgstore.name : "Not found — required",
      ok: Boolean(manifest.msgstore)
    },
    {
      icon: <HardDrive size={16} />,
      label: "Contacts",
      value: manifest.wa ? manifest.wa.name : "Not found — optional",
      ok: Boolean(manifest.wa)
    },
    {
      icon: <FolderOpen size={16} />,
      label: "Media",
      value: manifest.media ? manifest.media.name : "Not found — optional",
      ok: Boolean(manifest.media)
    }
  ];
  return (
    <div className={`detectionSummary ${manifest.valid ? "" : "invalid"}`}>
      {rows.map((row) => (
        <div className="detectionRow" key={row.label}>
          <span className="detectionIcon">{row.icon}</span>
          <span className="detectionLabel">{row.label}</span>
          <span className="detectionValue">{row.value}</span>
          {row.ok ? (
            <CheckCircle2 size={16} className="detectionOk" />
          ) : (
            <Circle size={16} className="detectionMissing" />
          )}
        </div>
      ))}
      {manifest.auxiliary.length > 0 && (
        <div className="detectionAux">
          <FileText size={14} />
          <span>
            {manifest.auxiliary.length} other backup file{manifest.auxiliary.length === 1 ? "" : "s"} detected (
            {manifest.auxiliary.map((file) => file.kind).join(", ")}) — reserved for a follow-up, not imported yet.
          </span>
        </div>
      )}
      {manifest.notes.map((note) => (
        <div className="detectionNote" key={note}>
          {note}
        </div>
      ))}
    </div>
  );
}

function OverrideInput({
  label,
  value,
  pickerAvailable,
  onChange,
  onBrowse
}: {
  label: string;
  value: string;
  pickerAvailable: boolean;
  onChange: (value: string) => void;
  onBrowse: () => void;
}) {
  return (
    <label className="wizardField">
      <span>{label}</span>
      <div className="pathWithButton">
        <input value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off" />
        {pickerAvailable && (
          <button className="textButton" type="button" onClick={onBrowse}>
            Browse…
          </button>
        )}
      </div>
    </label>
  );
}

function WizardActions({
  busy,
  primaryLabel,
  primaryIcon,
  primaryDisabled,
  onPrimary,
  onBack,
  dangerLabel = null,
  dangerIcon = null,
  dangerDisabled = false,
  onDanger
}: {
  busy: string | null;
  primaryLabel: string;
  primaryIcon: ReactNode;
  primaryDisabled: boolean;
  onPrimary: () => void;
  onBack: (() => void) | null;
  dangerLabel?: string | null;
  dangerIcon?: ReactNode;
  dangerDisabled?: boolean;
  onDanger?: (() => void) | null;
}) {
  return (
    <div className="wizardActions">
      <div className="wizardSecondaryActions">
        {onBack && (
          <button className="secondaryButton" type="button" onClick={onBack} disabled={Boolean(busy)}>
            Back
          </button>
        )}
        {dangerLabel && onDanger && (
          <button className="secondaryButton dangerButton" type="button" onClick={onDanger} disabled={dangerDisabled}>
            {dangerIcon}
            {dangerLabel}
          </button>
        )}
      </div>
      <button className="primaryButton" type="button" onClick={onPrimary} disabled={primaryDisabled}>
        {busy ? <Loader2 className="spin" size={16} /> : primaryIcon}
        {primaryLabel}
      </button>
    </div>
  );
}

function ImportProgress({ job }: { job: ImportJobSummary | null }) {
  const events = job?.events ?? [];
  const latestStep = [...events].reverse().find((event): event is Extract<ImportProgressEvent, { type: "step" }> => event.type === "step");
  const latestFile = [...events].reverse().find((event): event is Extract<ImportProgressEvent, { type: "file-progress" }> => event.type === "file-progress");
  const latestMessages = [...events].reverse().find((event): event is Extract<ImportProgressEvent, { type: "message-progress" }> => event.type === "message-progress");
  const latestMedia = [...events].reverse().find((event): event is Extract<ImportProgressEvent, { type: "media-progress" }> => event.type === "media-progress");
  const latestWarnings = [...events].reverse().find((event): event is Extract<ImportProgressEvent, { type: "warnings" }> => event.type === "warnings");
  const filePct = latestFile ? progressPercent(latestFile.processedBytes, latestFile.totalBytes) : 0;
  const fileDone = Boolean(latestFile && latestFile.processedBytes >= latestFile.totalBytes);
  const messagePct = latestMessages?.totalMessages ? progressPercent(latestMessages.processedMessages, latestMessages.totalMessages) : 0;
  const messagePreparing =
    job?.status === "running" &&
    !latestMessages &&
    Boolean(latestStep && ["decrypting", "opening", "parsing", "contacts", "identity-merge", "chats"].includes(latestStep.step));
  const messageDetail = latestMessages
    ? latestMessages.totalMessages
      ? `${messagePct}% | ${latestMessages.processedMessages.toLocaleString()} / ${latestMessages.totalMessages.toLocaleString()} processed | ${latestMessages.persistedMessages.toLocaleString()} persisted`
      : `${latestMessages.processedMessages.toLocaleString()} processed | ${latestMessages.persistedMessages.toLocaleString()} persisted`
    : messagePreparing
      ? "Preparing message import"
      : "Waiting";
  const statusTitle =
    job?.status === "completed"
      ? "Import complete"
      : job?.status === "failed"
        ? "Import failed"
        : job?.status === "cancelled"
          ? "Import stopped"
          : job?.status === "cancelling"
            ? "Stopping import"
            : "Import running";
  return (
    <div className="progressStack">
      <div className={`jobStatus ${job?.status ?? "queued"}`}>
        {job?.status === "failed" ? <AlertTriangle size={18} /> : job?.status === "completed" || job?.status === "cancelled" ? <CheckCircle2 size={18} /> : <Loader2 className="spin" size={18} />}
        <div>
          <strong>{statusTitle}</strong>
          <p>{job?.error ?? latestStep?.message ?? "Preparing local import job."}</p>
        </div>
      </div>
      <ProgressBar
        label={latestFile?.message ?? "File verification/decryption"}
        value={filePct}
        active={Boolean(latestFile && job?.status === "running" && !fileDone)}
        detail={latestFile ? `${filePct}% | ${formatBytes(latestFile.processedBytes)} / ${formatBytes(latestFile.totalBytes)}` : "Waiting"}
      />
      <ProgressBar
        label="Messages"
        value={messagePct}
        active={messagePreparing || Boolean(latestMessages && job?.status === "running")}
        detail={messageDetail}
      />
      {latestMedia && (
        <ProgressBar
          label="Media"
          value={latestMedia.totalRefs ? progressPercent(latestMedia.processedRefs, latestMedia.totalRefs) : 0}
          active={Boolean(job?.status === "running" && latestStep?.step === "media")}
          detail={`${latestMedia.matchedRefs.toLocaleString()} matched | ${latestMedia.copiedAssets.toLocaleString()} archived${
            latestMedia.missingRefs ? ` | ${latestMedia.missingRefs.toLocaleString()} missing` : ""
          }${latestMedia.totalRefs ? ` | ${latestMedia.processedRefs.toLocaleString()} / ${latestMedia.totalRefs.toLocaleString()}` : ""}`}
        />
      )}
      {latestWarnings && latestWarnings.count > 0 && (
        <div className="warningSummary">
          <AlertTriangle size={15} />
          <span>
            {latestWarnings.count.toLocaleString()} warnings: {latestWarnings.codes.join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}

function SyncProgress({ progress }: { progress: LiveSyncProgress }) {
  const messagesDetail = `${progress.processedMessages.toLocaleString()} messages synced${
    progress.queuedMessages ? ` | ${progress.queuedMessages.toLocaleString()} in current batch` : ""
  }`;
  // Phase 1: WhatsApp's proactive history push (platform-reported percent).
  if (progress.historySyncPercent != null && progress.historySyncPercent < 100) {
    return (
      <ProgressBar
        label="WhatsApp history sync (recent chats)"
        value={progress.historySyncPercent}
        active
        detail={`${Math.round(progress.historySyncPercent)}% | ${messagesDetail}`}
      />
    );
  }
  // Phase 2: our per-chat backfill of the downtime window.
  if (progress.auditPending) {
    return <ProgressBar label="Preparing chat-by-chat backfill" value={0} active detail={messagesDetail} />;
  }
  if (progress.gapsOpened > progress.gapsClosed) {
    const value = progressPercent(progress.gapsClosed, progress.gapsOpened);
    return (
      <ProgressBar
        label="Backfilling older chat windows"
        value={value}
        active
        detail={`${progress.gapsClosed.toLocaleString()} of ${progress.gapsOpened.toLocaleString()} chat windows caught up | ${messagesDetail}`}
      />
    );
  }
  return <ProgressBar label="Live catch-up" value={100} active detail={messagesDetail} />;
}

function progressPercent(value: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
}

function ProgressBar({ label, value, detail, active = false }: { label: string; value: number; detail: string; active?: boolean }) {
  return (
    <div className={`progressBarBlock ${active ? "active" : ""}`}>
      <div>
        <span>{label}</span>
        <strong>{detail}</strong>
      </div>
      <div className={`progressTrack ${active && value === 0 ? "indeterminate" : ""}`}>
        <div style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function PairingModal({ pairing, onClose, onRetry }: { pairing: LivePairingSummary | null; onClose: () => void; onRetry: () => void }) {
  const expired = pairing?.expiresAt ? Date.now() > Date.parse(pairing.expiresAt) && pairing.state !== "connected" : false;
  const connected = pairing?.state === "connected";
  useEffect(() => {
    if (!connected) {
      return;
    }
    const timer = window.setTimeout(onClose, 1500);
    return () => window.clearTimeout(timer);
  }, [connected, onClose]);
  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="pair-title">
      <section className="pairingModal">
        <div className="wizardHeader">
          <div>
            <span className="eyebrow">
              <QrCode size={14} />
              WhatsApp linked device
            </span>
            <h2 id="pair-title">{pairing?.state === "connected" ? "Linked" : "Link WhatsApp"}</h2>
            <p>Open WhatsApp on your phone, then use Linked devices to scan or pair. The live client is read-only guarded.</p>
          </div>
          <button className="iconButton" onClick={onClose} type="button" aria-label="Close pairing">
            <X size={16} />
          </button>
        </div>
        <div className="pairingBody">
          {connected ? (
            <div className="qrPlaceholder">
              <CheckCircle2 size={26} />
              <span>Linked — closing…</span>
            </div>
          ) : pairing?.qrDataUrl ? (
            <img className="qrImage" src={pairing.qrDataUrl} alt="WhatsApp pairing QR" />
          ) : (
            <div className="qrPlaceholder">
              <Loader2 className="spin" size={26} />
              <span>Waiting for QR</span>
            </div>
          )}
          {pairing?.pairingCode && (
            <div className="pairingCode">
              <span>Pairing code</span>
              <strong>{pairing.pairingCode}</strong>
            </div>
          )}
          <div className={`jobStatus ${pairing?.state ?? "idle"}`}>
            {pairing?.state === "connected" ? <CheckCircle2 size={18} /> : expired || pairing?.state === "error" ? <AlertTriangle size={18} /> : <Loader2 className="spin" size={18} />}
            <div>
              <strong>{expired ? "QR expired" : pairing?.state?.replaceAll("_", " ") ?? "Starting"}</strong>
              <p>{pairing?.lastError ?? "No sends, no read receipts, no chat modifications."}</p>
            </div>
          </div>
          {expired && (
            <button className="primaryButton fullButton" type="button" onClick={onRetry}>
              <RefreshCcw size={16} />
              Generate another QR
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function StatusPanel({
  status,
  statusError,
  busy,
  onInit,
  onCleanup
}: {
  status: StatusSummary | null;
  statusError: string | null;
  busy: string | null;
  onInit: () => void;
  onCleanup: () => void;
}) {
  const latest = status?.latestImport;
  const [statusPanelOpen, setStatusPanelOpen] = useState(true);
  return (
    <section className={`statusPanel ${statusPanelOpen ? "" : "collapsed"}`}>
      <button className="panelToggle" type="button" aria-expanded={statusPanelOpen} onClick={() => setStatusPanelOpen((current) => !current)}>
        <span className="panelTitle">
          <Database size={16} />
          <span>Status</span>
          {busy && <Loader2 className="spin" size={16} />}
        </span>
        {statusPanelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {statusPanelOpen && (
        <>
          <div className="statusGrid">
            <Metric label="DB" value={status?.database.initialized ? "Ready" : "Not ready"} />
            <Metric label="Store" value={status?.database.adapter?.toUpperCase() ?? "SQLite"} />
            <Metric label="Chats" value={status?.counts.chats.toLocaleString() ?? "0"} />
            <Metric label="Contacts" value={status?.counts.contacts.toLocaleString() ?? "0"} />
            <Metric label="Messages" value={status?.counts.messages.toLocaleString() ?? "0"} />
            <Metric label="Warnings" value={status?.counts.warnings.toLocaleString() ?? "0"} />
          </div>
          <div className="statusLine">
            {statusError ??
              status?.database.error ??
              (latest
                ? `${latest.status} | ${formatDate(latest.finishedAt ?? latest.startedAt)}`
                : status?.database.location
                  ? `${status.database.adapter ?? "local"} | ${status.database.location}`
                  : "No import yet")}
          </div>
          {Boolean(status?.latestWarnings.length) && (
            <div className="warningList">
              {status?.latestWarnings.map((warning) => (
                <div key={warning.id ?? warning.code} className={`warningItem ${warning.severity}`}>
                  <span>{warning.code}</span>
                  <p>{warning.message}</p>
                </div>
              ))}
            </div>
          )}
          <div className="privacyLine">
            <FileKey2 size={15} />
            <span>Keys stay runtime-only; imported data stays in the local archive file.</span>
          </div>
          <button className="secondaryButton" onClick={onInit} disabled={Boolean(busy)} type="button">
            <Database size={16} />
            Initialize
          </button>
          <button className="secondaryButton subtleButton" onClick={onCleanup} disabled={Boolean(busy)} type="button">
            {busy === "Cleaning temp files" ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
            Clean Temp Files
          </button>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function hasArchiveData(status: StatusSummary | null): boolean {
  return Boolean(status?.latestImport || status?.counts.messages || status?.counts.chats);
}

export {
  GlobalSearchResults,
  GoogleContactsPanel,
  LivePanel,
  BrainPanel,
  MemoryPanel,
  OnboardingPanel,
  StatusPanel,
  ImportWizard,
  ImportLauncher,
  PairingModal,
  hasArchiveData
};
