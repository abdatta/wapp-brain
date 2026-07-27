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
import { Link } from "react-router-dom";
import { parseInlineSegments, parseWhatsAppBlocks, type InlineSegment } from "./whatsappFormat";
import { useStatus } from "./state/StatusContext";
import type {
  ArchiveChangeEvent,
  BackupDetectionManifest,
  BrainOverview,
  BrainQualitySummary,
  BrainProviderName,
  BrainRunProgress,
  ChatListItem,
  OwnerIdentitySuggestion,
  OwnerSelfIdentity,
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
  SearchMatchTier,
  SearchReindexProgress,
  SearchRelaxationInfo,
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
  dryRunBrainRegenerate,
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
  matchTier,
  relaxation,
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
  matchTier?: SearchMatchTier;
  relaxation?: SearchRelaxationInfo | null;
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
  // Precision honesty: relaxed/partial tiers are labelled, never silently
  // blended with exact results (they only appear when strict found nothing).
  const effectiveTier: SearchMatchTier = matchTier ?? "exact";
  const showRelaxationBanner = !searching && !needsRebuild && !error && effectiveTier !== "exact" && results.length > 0;
  const relaxationSummary = (() => {
    if (effectiveTier === "relaxed") {
      return "No exact matches — loosened word endings (prefix match) to find these.";
    }
    if (relaxation && relaxation.droppedTerms.length > 0) {
      return `No exact matches — matched ${relaxation.requiredTerms} of ${relaxation.totalTerms} terms; ignored: ${relaxation.droppedTerms.join(", ")}.`;
    }
    if (relaxation && relaxation.tier === 4) {
      return "No exact matches — showing the best results matching any of your terms.";
    }
    return "No exact matches — showing looser results.";
  })();
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
      {showRelaxationBanner && (
        <div className="relaxedBanner" role="status">
          <p>{relaxationSummary}</p>
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
                {hit.senderOnlyMatch && <span className="hitBadge">sender match</span>}
                {hit.termCoverage && hit.termCoverage.matched < hit.termCoverage.total && (
                  <span className="hitBadge">
                    {hit.termCoverage.matched}/{hit.termCoverage.total} terms
                  </span>
                )}
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
  const demo = Boolean(useStatus().status?.demo);
  const last = status?.lastSync;
  if (demo) {
    return (
      <section className="importPanel">
        <div className="panelTitle"><Users size={16} /><span>Google Contacts</span></div>
        <p className="muted">Demo instance: Google Contacts is disabled. This workspace only ever holds synthetic sample data, so there is nothing real to enrich.</p>
      </section>
    );
  }
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
  // Demo instances never open a live connection; the panel says so instead of
  // offering link/resume actions that the server would refuse anyway.
  if (status?.demo) {
    return (
      <section className="livePanel">
        <div className="panelTitle">
          <Signal size={16} />
          <span>Live Sync</span>
        </div>
        <p className="muted">
          Demo instance: live sync is disabled. Pairing a real WhatsApp account is only available outside demo mode — this
          workspace holds synthetic sample data and makes no external connections.
        </p>
      </section>
    );
  }
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

// Compact counts for chips (11,528 → "11.5k") so a chip stays one glanceable token.
function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

// One live fact as a pill: a muted label and its value. `truncate` clamps long
// values (a chat name) with the full text on hover; `warn` tints it (fallbacks).
function RunChip({ label, value, truncate, warn }: { label: string; value: string; truncate?: boolean; warn?: boolean }) {
  return (
    <span className={`runChip ${warn ? "runChipWarn" : ""}`} title={truncate ? value : undefined}>
      <span className="runChipLabel">{label}</span>
      <span className={`runChipValue ${truncate ? "runChipTruncate" : ""}`}>{value}</span>
    </span>
  );
}

// A live run's progress: a determinate bar against the precomputed episode
// estimate (indeterminate until it lands), the run's live facts as chips, and a
// Stop control. Replaces the panel's action row while a run executes — the Run
// button is meaningless then (only one run at a time).
function RunProgressCard({ run, stopping, onStop }: { run: BrainRunProgress; stopping: boolean; onStop: () => void }) {
  const kindLabel = run.kind === "backfill" ? "Backfill" : run.kind === "regenerate" ? "Regeneration" : "Assimilation";
  const committed = run.episodesCommitted;
  const estimate = run.estimatedEpisodes;
  const known = estimate != null && estimate > 0;
  // Once the actual count passes the estimate, the denominator is meaningless —
  // flip to the indeterminate sweep rather than pin a false 100%. So the bar is
  // determinate only while committed is within the estimate.
  const over = known && committed > estimate;
  const determinate = known && !over;
  const percent = determinate ? Math.min(100, Math.round((committed / estimate) * 100)) : null;
  // Regeneration knows its total exactly; assimilation/backfill estimate it.
  const approx = run.kind !== "regenerate";
  return (
    <div className="runProgressCard">
      <div className="runProgressHead">
        <span className="runProgressTitle">
          <Loader2 className="spin" size={15} />
          <span>
            {kindLabel} running{stopping ? " — stopping…" : ""}
          </span>
        </span>
        <button
          className="miniButton runStopButton"
          type="button"
          disabled={stopping}
          onClick={onStop}
          title="Stop after the current episode; committed episodes and coverage are kept, the rest stays pending"
        >
          <CircleStop size={14} />
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      <div
        className={`runProgressBar ${determinate ? "" : "indeterminate"}`}
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="runProgressFill" style={determinate ? { width: `${percent}%` } : undefined} />
      </div>
      <div className="runProgressCounts">
        <span className="runProgressEpisodes">
          <strong>{committed.toLocaleString()}</strong>
          {over
            ? ` episodes · ${approx ? "≈" : ""}${estimate.toLocaleString()} expected`
            : known
              ? ` / ${approx ? "≈" : ""}${estimate.toLocaleString()} episodes`
              : " episodes"}
        </span>
        {percent != null && <span className="runProgressPercent">{percent}%</span>}
      </div>
      <div className="runChips">
        <RunChip label={run.mode === "model" ? "model" : "mode"} value={run.model ?? run.mode} />
        <RunChip label="chats" value={`${run.processedChats.toLocaleString()} / ${run.totalChats.toLocaleString()}`} />
        {run.currentChat && <RunChip label="now" value={run.currentChat} truncate />}
        {run.mode === "model" && <RunChip label="calls" value={run.modelCalls.toLocaleString()} />}
        {run.mode === "model" && run.tokensUsed > 0 && <RunChip label="tokens" value={compactCount(run.tokensUsed)} />}
        {run.queuedTasks != null && <RunChip label="queued" value={run.queuedTasks.toLocaleString()} />}
        {run.extractiveEpisodes > 0 && <RunChip label="extractive" value={run.extractiveEpisodes.toLocaleString()} warn />}
      </div>
    </div>
  );
}

// The brain's operator panel: coverage truth, run-due alert, and full provider
// control (opt-in, model choice, probe) — manual-first, everything from the UI.
function BrainPanel({
  overview,
  quality,
  run,
  busy,
  onOpenConsole,
  onReset,
  onStop
}: {
  overview: BrainOverview | null;
  // Fetched separately from the polled overview and on its own cadence, so a
  // slow aggregate shimmers in place instead of delaying the whole panel.
  quality: BrainQualitySummary | null;
  run: BrainRunProgress | null;
  busy: string | null;
  // Run configuration (identity, mode, provider, budgets) lives in the run
  // console modal — the panel is a summary with one primary action, plus the
  // reset danger control (a destructive archive-level action, not run config).
  onOpenConsole: () => void;
  onReset: () => void;
  // Cooperative stop for the in-progress run (the Stop control on the card).
  onStop: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [stopRequested, setStopRequested] = useState(false);
  const provider = overview?.provider;
  // Until the first status answer arrives, values are UNKNOWN — render
  // shimmers, never placeholder zeros that read as data. Quality answers
  // separately, so it shimmers on its own clock and never gates the rest.
  const loading = !overview;
  const qualityLoading = !quality;
  const runDue = Boolean(overview?.scheduler.runDue);
  const running = run?.state === "running";
  // A finished (or freshly started) run clears the optimistic "stopping" latch.
  useEffect(() => {
    if (!running) {
      setStopRequested(false);
    }
  }, [running]);
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
            <Metric label="Coverage" loading={loading} value={`${overview?.coveragePercent ?? 0}%`} />
            <Metric label="Backlog chats" loading={loading} value={overview?.chatsWithBacklog.toLocaleString() ?? "0"} />
            <Metric
              label="Pending msgs"
              loading={loading}
              value={((overview?.totalVisibleMessages ?? 0) - (overview?.assimilatedVisibleMessages ?? 0)).toLocaleString()}
            />
            <Metric label="Calls today" loading={loading} value={overview?.usageToday.calls.toLocaleString() ?? "0"} />
            {/* The quality slots arrive on their own request. Their labels are
                known before their values are, so they shimmer in place rather
                than popping in — and a zero one then drops out, as before. */}
            {qualityLoading ? (
              <>
                <Metric label="Quality flags" loading value="" />
                <Metric label="Media gaps" loading value="" />
                <Metric label="Unresolved people" loading value="" />
              </>
            ) : (
              <>
                {quality!.validationIssues.error + quality!.validationIssues.warning > 0 && (
                  <Metric label="Quality flags" value={`${quality!.validationIssues.error + quality!.validationIssues.warning}`} />
                )}
                {quality!.mediaGaps.length > 0 && (
                  <div
                    className="metric"
                    title={`Where unavailable media hurt an inference (the demand stat for building media interpretation): ${quality!.mediaGaps
                      .map((gap) => `${gap.modality} ${gap.impact}: ${gap.count}`)
                      .join(", ")}`}
                  >
                    <span>Media gaps</span>
                    <strong>{quality!.mediaGaps.reduce((sum, gap) => sum + gap.count, 0)}</strong>
                  </div>
                )}
                {quality!.resolutionDebt.episodesWithUnresolved > 0 && (
                  <div
                    className="metric"
                    title={`Episodes still referring to people by number. Saving these contacts repairs old episodes and search with no model call — highest payoff first: ${quality!.resolutionDebt.topIdentities
                      .map((identity) => `${identity.label} (${identity.messageCount.toLocaleString()} msgs, ${identity.episodeCount} ep)`)
                      .join(", ")}`}
                  >
                    <span>Unresolved people</span>
                    <strong>{quality!.resolutionDebt.distinctIdentities.toLocaleString()}</strong>
                  </div>
                )}
              </>
            )}
          </div>
          {qualityLoading && <span className="metricSkeleton lineSkeleton" aria-label="Quality detail loading" />}
          {!qualityLoading && quality!.resolutionDebt.episodesWithUnresolved > 0 && (
            <div className="brainHint">
              {quality!.resolutionDebt.episodesWithUnresolved.toLocaleString()} episode
              {quality!.resolutionDebt.episodesWithUnresolved === 1 ? "" : "s"} involve unresolved participants (
              {quality!.resolutionDebt.distinctIdentities.toLocaleString()} distinct number
              {quality!.resolutionDebt.distinctIdentities === 1 ? "" : "s"}). Save the top contact
              {quality!.resolutionDebt.topIdentities.length === 1 ? "" : "s"} to repair the most — with no model call:{" "}
              {quality!.resolutionDebt.topIdentities
                .slice(0, 3)
                .map((identity) => `${identity.label} (${identity.messageCount.toLocaleString()})`)
                .join(", ")}
              .
            </div>
          )}
          {!qualityLoading && quality!.modelQuality.some((aggregate) => aggregate.attempted > 0) && (
            <div className="brainHint">
              Model quality:{" "}
              {quality!.modelQuality
                .filter((aggregate) => aggregate.attempted > 0)
                .map(
                  (aggregate) =>
                    `${aggregate.model} v${aggregate.extractionVersion} — ${aggregate.fallbackEpisodes}/${aggregate.attempted} fell back` +
                    (aggregate.strictPrecision != null
                      ? `, precision ${(aggregate.strictPrecision * 100).toFixed(0)}% (${
                          aggregate.grades.supported + aggregate.grades.partial + aggregate.grades.unsupported
                        } graded)`
                      : "")
                )
                .join(" · ")}{" "}
              — <Link to="/brain/eval">Eval &amp; grading</Link>
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
          {running && run && (
            <RunProgressCard
              run={run}
              stopping={stopRequested}
              onStop={() => {
                setStopRequested(true);
                onStop();
              }}
            />
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
          {/* While a run executes, the progress card above owns the action
              area — a second "Run" button is meaningless (one run at a time),
              and Reset is unsafe mid-run. Both return when the run ends. */}
          {!running && (
            <div className="brainConsoleRow">
              <button
                className="primaryButton"
                type="button"
                disabled={Boolean(busy) || loading}
                onClick={onOpenConsole}
                title={loading ? "Waiting for brain status…" : "Configure identity, provider, and budgets, then start a run"}
              >
                <Play size={16} />
                Run brain
              </button>
              <button
                className="miniButton dangerButton brainResetButton"
                type="button"
                disabled={Boolean(busy) || loading}
                onClick={onReset}
                title="Delete all generated episodes, claims, citations, and coverage watermarks (raw messages untouched); the next run starts from scratch"
              >
                <Trash2 size={14} />
                Reset
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// --- Brain run console (brain-run-console) ---------------------------------
// Every run setting in one validated modal: identity (name required, self
// numbers with absolute labeling precedence), mode, provider/model, and
// budgets. The validation matrix DISABLES impossible combinations with a
// stated reason — extractive mode has no model budgets, regeneration needs a
// model, call budgets clamp to the remaining daily ledger — and Start stays
// off until the owner name exists.

// A number-ish current label carries no mis-pick warning value.
function selfWarningLabel(label: string | null | undefined, ownerName: string): string | null {
  const clean = label?.trim();
  if (!clean || /^\+?[\d\s]+$/.test(clean)) {
    return null;
  }
  const ownerShort = ownerName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return ownerShort && clean.toLowerCase().includes(ownerShort) ? null : clean;
}

function RunConsoleModal({
  overview,
  quality,
  busy,
  running,
  onClose,
  onProviderAction,
  onSaveIdentity,
  onStartRun,
  onStartRegenerate,
  suggest
}: {
  overview: BrainOverview | null;
  // The regenerate mode's queue size and contract version: off the poll path,
  // so the console renders immediately and this line fills in when it lands.
  quality: BrainQualitySummary | null;
  busy: string | null;
  running: boolean;
  onClose: () => void;
  onProviderAction: (body: {
    action: "enable" | "disable" | "probe" | "set-model";
    provider?: Exclude<BrainProviderName, "extractive">;
    model?: string;
  }) => void;
  onSaveIdentity: (name: string, selfJids: string[]) => Promise<boolean>;
  onStartRun: (body: {
    mode: "model" | "extractive";
    model?: string | null;
    maxChats?: number;
    maxModelCalls?: number;
    maxTokens?: number | null;
    backfill?: boolean;
    callsPerHour?: number | null;
    callsPerDay?: number | null;
    strict?: boolean;
    concurrency?: number | null;
  }) => Promise<boolean>;
  onStartRegenerate: (body: { model?: string | null; maxMessages?: number | null; callsPerDay?: number | null }) => Promise<boolean>;
  suggest: (query: string) => Promise<OwnerIdentitySuggestion[]>;
}) {
  const demo = Boolean(useStatus().status?.demo);
  const provider = overview?.provider ?? null;
  const ownerName = overview?.ownerName ?? "";
  const [name, setName] = useState(ownerName);
  const [selfEntries, setSelfEntries] = useState<OwnerSelfIdentity[]>(overview?.selfIdentities ?? []);
  const [numberInput, setNumberInput] = useState("");
  const [numberError, setNumberError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<OwnerIdentitySuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [runMode, setRunMode] = useState<"assimilate" | "backfill" | "regenerate">("assimilate");
  const [maxChats, setMaxChats] = useState("3");
  const [maxCalls, setMaxCalls] = useState(String(overview?.limits?.maxCallsPerHour ?? 30));
  const [maxTokens, setMaxTokens] = useState("");
  // Backfill (historical-backfill H6): optional task cap (empty = the whole
  // uncovered queue), per-run pacing overrides, worker pool width, strict mode.
  const [backfillChats, setBackfillChats] = useState("");
  const [rateOverride, setRateOverride] = useState("");
  const [dailyOverride, setDailyOverride] = useState("");
  const [concurrency, setConcurrency] = useState("5");
  const [strictMode, setStrictMode] = useState(false);
  // Regeneration pack-size scope (zero-claim-episodes migration): empty =
  // every stale episode; a number regenerates only packs of at most N messages.
  // The scoped count previews via the dry-run endpoint before anything spends.
  const [regenMaxMessages, setRegenMaxMessages] = useState("");
  const [regenScopedCount, setRegenScopedCount] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  // Plain substring autocomplete (no inference), debounced; every row shows
  // the number's CURRENT resolved name so a mis-pick is visible before saving.
  useEffect(() => {
    const query = numberInput.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    const timer = window.setTimeout(() => {
      suggest(query)
        .then((rows) => {
          setSuggestions(rows);
          setSuggestionsOpen(rows.length > 0);
        })
        .catch(() => setSuggestions([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [numberInput, suggest]);

  // Scoped-count preview: debounce the dry-run query so the Regenerate button
  // shows the true selection size for the chosen pack-size bound.
  const scopeNumber = regenMaxMessages.trim() === "" ? null : Number(regenMaxMessages);
  const scopeValid = scopeNumber != null && Number.isInteger(scopeNumber) && scopeNumber >= 1 && scopeNumber <= 10_000;
  useEffect(() => {
    if (runMode !== "regenerate" || !scopeValid) {
      setRegenScopedCount(null);
      return;
    }
    const timer = window.setTimeout(() => {
      dryRunBrainRegenerate({ maxMessages: scopeNumber })
        .then((response) => setRegenScopedCount(response.episodes))
        .catch(() => setRegenScopedCount(null));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [runMode, scopeNumber, scopeValid]);

  const modelBacked = Boolean(provider && provider.provider !== "extractive");
  const modelOptions = provider && provider.provider !== "extractive" ? provider.models[provider.provider] ?? [] : [];
  const regenerable = quality?.regenerableEpisodes ?? 0;
  const backfill = runMode === "backfill";
  const dailyOverrideNumber = dailyOverride.trim() === "" ? null : Number(dailyOverride);
  // The remaining-today guard validates against what the server will actually
  // enforce: the per-run daily override when given, else the configured cap.
  // Regeneration accepts the same override — a bulk re-derivation (the sweep
  // button hardcodes 10,000/day for the same reason) dwarfs the configured cap.
  const dailyCap = (backfill || runMode === "regenerate") && dailyOverrideNumber != null && Number.isInteger(dailyOverrideNumber)
    ? dailyOverrideNumber
    : overview?.limits?.maxCallsPerDay ?? 0;
  const usedToday = overview?.usageToday.calls ?? 0;
  const remainingToday = Math.max(0, dailyCap - usedToday);
  const pendingMessages = Math.max(0, (overview?.totalVisibleMessages ?? 0) - (overview?.assimilatedVisibleMessages ?? 0));

  // --- Validation matrix: disabled-with-reason, never silently ignored. ---
  const nameError = name.trim() ? null : "Your name is required — episodes label your own messages with it.";
  const chatsNumber = Number(maxChats);
  const chatsError =
    runMode !== "assimilate"
      ? null
      : !Number.isInteger(chatsNumber) || chatsNumber < 1 || chatsNumber > 5000
        ? "Between 1 and 5000 chats."
        : null;
  const backfillChatsNumber = backfillChats.trim() === "" ? null : Number(backfillChats);
  const backfillChatsError =
    !backfill || backfillChatsNumber == null
      ? null
      : !Number.isInteger(backfillChatsNumber) || backfillChatsNumber < 1 || backfillChatsNumber > 100_000
        ? "Between 1 and 100,000 tasks (leave empty to drain the whole queue)."
        : null;
  const callsDisabledReason = !modelBacked
    ? "Extractive mode makes no model calls — nothing to budget."
    : runMode === "regenerate"
      ? "Regeneration sizes its own queue; the call budget still caps spend via the daily ledger."
      : null;
  const callsNumber = maxCalls.trim() === "" ? null : Number(maxCalls);
  const callsError =
    callsDisabledReason != null
      ? null
      : callsNumber == null
        ? backfill
          ? null
          : "Between 1 and 1000 calls."
        : !Number.isInteger(callsNumber) || callsNumber < 1 || callsNumber > (backfill ? 100_000 : 1000)
          ? `Between 1 and ${backfill ? "100,000" : "1000"} calls${backfill ? " (leave empty for no per-run ceiling)" : ""}.`
          : callsNumber > remainingToday
            ? `Only ${remainingToday.toLocaleString()} of ${dailyCap.toLocaleString()} daily calls left today${backfill ? " (raise the daily override for a turbo session)" : ""}.`
            : null;
  const tokensDisabledReason = !modelBacked
    ? "Extractive mode makes no model calls — nothing to budget."
    : runMode === "regenerate"
      ? "Token budget applies to assimilation runs; regeneration enforces the call budget."
      : null;
  const tokensNumber = maxTokens.trim() === "" ? null : Number(maxTokens);
  const tokensError =
    tokensDisabledReason != null || tokensNumber == null
      ? null
      : !Number.isInteger(tokensNumber) || tokensNumber < 1000 || tokensNumber > 100_000_000
        ? "Between 1,000 and 100,000,000 tokens (leave empty for no token budget)."
        : null;
  const tokenNote =
    tokensDisabledReason ??
    (provider?.tokenUsage === "may-estimate"
      ? "Some codex calls report estimated usage — treat this budget as approximate."
      : "Counts the provider's real reported usage.");
  // Backfill-only rows: pacing overrides, worker pool, strict. Overrides need
  // a model (extractive backfill spends nothing — permitted, with a note).
  const pacingDisabledReason = !backfill
    ? null
    : !modelBacked
      ? "Extractive backfill makes zero model calls — pacing has nothing to pace."
      : null;
  const rateNumber = rateOverride.trim() === "" ? null : Number(rateOverride);
  const rateError =
    !backfill || pacingDisabledReason != null || rateNumber == null
      ? null
      : !Number.isInteger(rateNumber) || rateNumber < 1 || rateNumber > 1000
        ? "Between 1 and 1000 calls/hour (leave empty for the configured pace)."
        : null;
  const dailyError =
    (!backfill && runMode !== "regenerate") || pacingDisabledReason != null || dailyOverrideNumber == null
      ? null
      : !Number.isInteger(dailyOverrideNumber) || dailyOverrideNumber < 1 || dailyOverrideNumber > 10_000
        ? "Between 1 and 10,000 calls/day (leave empty for the configured ceiling)."
        : null;
  const concurrencyNumber = Number(concurrency);
  const concurrencyError =
    !backfill || pacingDisabledReason != null
      ? null
      : !Number.isInteger(concurrencyNumber) || concurrencyNumber < 1 || concurrencyNumber > 6
        ? "Between 1 and 6 workers."
        : null;
  const strictDisabledReason = !backfill ? null : !modelBacked ? "Strict mode needs a model — extractive generation has no model failures to refuse." : null;
  const regenScopeError =
    runMode !== "regenerate" || scopeNumber == null || scopeValid
      ? null
      : "Between 1 and 10,000 messages (leave empty for every stale episode).";
  // The queue size now arrives on its own request, so "not counted yet" must
  // not be reported as "nothing to regenerate" — an unknown that reads as zero
  // would disable the mode with a reason that is simply false.
  const regenerateDisabledReason = !quality
    ? "Counting episodes below the current contract…"
    : regenerable === 0
      ? "Nothing to regenerate — every current episode is on the current contract."
      : !modelBacked
        ? "Regeneration needs a model provider — an extractive re-run would downgrade model episodes."
        : null;
  const providerGate = !provider
    ? "Provider status is still loading."
    : modelBacked && provider.sessionMissing
      ? provider.message
      : modelBacked && provider.degraded
        ? `${provider.message} Probe the provider (or pick extractive) before running.`
        : null;
  const startDisabledReason =
    nameError ??
    providerGate ??
    (running ? "A run is already in progress." : null) ??
    (busy ? `Busy: ${busy}.` : null) ??
    (runMode === "regenerate"
      ? regenerateDisabledReason ??
        regenScopeError ??
        dailyError ??
        (remainingToday === 0
          ? `Daily call budget exhausted (${usedToday.toLocaleString()}/${dailyCap.toLocaleString()}). Set a daily override for this run, or wait for the ledger day to roll.`
          : null)
      : backfill
        ? backfillChatsError ??
          callsError ??
          tokensError ??
          rateError ??
          dailyError ??
          concurrencyError ??
          (pendingMessages === 0 ? "Nothing uncovered — historical coverage is complete." : null) ??
          (modelBacked && remainingToday === 0
            ? `Daily call budget exhausted (${usedToday.toLocaleString()}/${dailyCap.toLocaleString()}). Raise the daily override for a turbo session, or wait for the ledger day to roll.`
            : null)
        : chatsError ??
          callsError ??
          tokensError ??
          ((overview?.chatsWithBacklog ?? 0) === 0 ? "No backlog — every visible message is already assimilated." : null) ??
          (modelBacked && remainingToday === 0
            ? `Daily call budget exhausted (${usedToday.toLocaleString()}/${dailyCap.toLocaleString()}). Extractive still works, or raise the cap.`
            : null));

  const addSelfEntry = (entry: OwnerSelfIdentity) => {
    setSelfEntries((current) => (current.some((existing) => existing.jid === entry.jid) ? current : [...current, entry]));
    setNumberInput("");
    setNumberError(null);
    setSuggestions([]);
    setSuggestionsOpen(false);
  };

  const addFreeText = () => {
    const digits = numberInput.replace(/[\s\-().+]/g, "");
    if (!/^\d{8,15}$/.test(digits)) {
      setNumberError("Use 8–15 digits (optional +, spaces, dashes) — or pick a suggestion.");
      return;
    }
    const jid = `${digits}@s.whatsapp.net`;
    const match = suggestions.find((suggestion) => suggestion.jid === jid);
    addSelfEntry(
      match
        ? { jid: match.jid, number: match.number, currentLabel: selfWarningLabel(match.label, name), messageCount: match.messageCount }
        : { jid, number: `+${digits}`, currentLabel: null, messageCount: 0 }
    );
  };

  async function handleStart() {
    if (startDisabledReason) {
      return;
    }
    setStarting(true);
    try {
      const identitySaved = await onSaveIdentity(
        name.trim(),
        selfEntries.map((entry) => entry.jid)
      );
      if (!identitySaved) {
        return;
      }
      const started =
        runMode === "regenerate"
          ? await onStartRegenerate({
              model: provider?.model ?? null,
              maxMessages: scopeValid ? scopeNumber : null,
              ...(dailyOverrideNumber != null ? { callsPerDay: dailyOverrideNumber } : {})
            })
          : runMode === "backfill"
            ? await onStartRun({
                mode: modelBacked ? "model" : "extractive",
                model: modelBacked ? provider?.model ?? null : null,
                backfill: true,
                ...(backfillChatsNumber != null ? { maxChats: backfillChatsNumber } : {}),
                ...(modelBacked && callsNumber != null ? { maxModelCalls: callsNumber } : {}),
                ...(modelBacked && tokensNumber ? { maxTokens: tokensNumber } : {}),
                ...(modelBacked && rateNumber != null ? { callsPerHour: rateNumber } : {}),
                ...(modelBacked && dailyOverrideNumber != null ? { callsPerDay: dailyOverrideNumber } : {}),
                ...(modelBacked ? { concurrency: concurrencyNumber, strict: strictMode } : {})
              })
            : await onStartRun({
                mode: modelBacked ? "model" : "extractive",
                model: modelBacked ? provider?.model ?? null : null,
                maxChats: chatsNumber,
                ...(modelBacked && callsDisabledReason == null && callsNumber != null ? { maxModelCalls: callsNumber } : {}),
                ...(modelBacked && tokensDisabledReason == null && tokensNumber ? { maxTokens: tokensNumber } : {})
              });
      if (started) {
        onClose();
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="run-console-title">
      <section className="runConsoleModal">
        <header className="runConsoleHeader">
          <div>
            <h2 id="run-console-title">Brain run console</h2>
            <p>Identity, provider, and budgets for this run. Invalid combinations are disabled — with the reason.</p>
          </div>
          <button className="miniButton" type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="runConsoleSection">
          <h3>Identity</h3>
          <label className="runConsoleField">
            <span>
              Your name <em className="requiredMark">*</em>
            </span>
            <input
              value={name}
              placeholder="e.g. Abhishek"
              onChange={(event) => setName(event.target.value)}
              title='Labels your own messages in episodes and search ("Abhishek (me)" instead of "Me")'
            />
            {nameError && <span className="fieldError">{nameError}</span>}
          </label>
          <div className="runConsoleField">
            <span>Also me (other numbers)</span>
            <div className="selfChips">
              {selfEntries.map((entry) => (
                <span key={entry.jid} className={`selfChip ${entry.currentLabel ? "selfChipWarn" : ""}`}>
                  <span>{entry.number}</span>
                  {entry.currentLabel && (
                    <span
                      className="selfChipNote"
                      title={`This number currently resolves to “${entry.currentLabel}”. As a self number it will be labelled “${name.trim() || "you"} (me)” with precedence over that name.`}
                    >
                      saved as “{entry.currentLabel}”
                    </span>
                  )}
                  {entry.messageCount > 0 && <span className="selfChipCount">{entry.messageCount.toLocaleString()} msgs</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${entry.number}`}
                    onClick={() => setSelfEntries((current) => current.filter((existing) => existing.jid !== entry.jid))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="selfSuggestWrap">
              <input
                value={numberInput}
                placeholder="Type a number or name to search your archive…"
                onChange={(event) => {
                  setNumberInput(event.target.value);
                  setNumberError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addFreeText();
                  } else if (event.key === "Escape") {
                    setSuggestionsOpen(false);
                  }
                }}
                onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 150)}
                onFocus={() => setSuggestionsOpen(suggestions.length > 0)}
              />
              {suggestionsOpen && (
                <ul className="selfSuggestList" role="listbox">
                  {suggestions.map((suggestion) => {
                    const added = selfEntries.some((entry) => entry.jid === suggestion.jid);
                    const warning = selfWarningLabel(suggestion.label, name);
                    return (
                      <li key={suggestion.jid}>
                        <button
                          type="button"
                          disabled={added}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() =>
                            addSelfEntry({
                              jid: suggestion.jid,
                              number: suggestion.number,
                              currentLabel: warning,
                              messageCount: suggestion.messageCount
                            })
                          }
                        >
                          <strong>{suggestion.number}</strong>
                          <span className={warning ? "selfSuggestName" : "selfSuggestMuted"}>
                            {warning ?? (suggestion.label && !/^\+?[\d\s]+$/.test(suggestion.label) ? suggestion.label : "no saved name")}
                          </span>
                          <span className="selfSuggestMeta">
                            {suggestion.messageCount.toLocaleString()} msgs{added ? " · added" : suggestion.isSelf ? " · already you" : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {numberError && <span className="fieldError">{numberError}</span>}
            <span className="fieldNote">
              These numbers are treated as you with precedence over any saved contact name. New episodes label them “
              {(name.trim() || "you").split(/\s+/)[0]} (me)”; regeneration upgrades old ones.
            </span>
          </div>
        </div>

        <div className="runConsoleSection">
          <h3>Run</h3>
          <div className="runModeRow" role="radiogroup" aria-label="Run mode">
            <label className={runMode === "assimilate" ? "runModeActive" : ""}>
              <input type="radio" name="runMode" checked={runMode === "assimilate"} onChange={() => setRunMode("assimilate")} />
              <span>Assimilate new</span>
              <small>{(overview?.chatsWithBacklog ?? 0).toLocaleString()} chat(s) with backlog</small>
            </label>
            <label
              className={runMode === "backfill" ? "runModeActive" : ""}
              title="Drain the full uncovered history through the durable queue — newest chat first, resumable after any interruption"
            >
              <input type="radio" name="runMode" checked={runMode === "backfill"} onChange={() => setRunMode("backfill")} />
              <span>Backfill history</span>
              <small>{pendingMessages.toLocaleString()} message(s) uncovered</small>
            </label>
            <label
              className={`${runMode === "regenerate" ? "runModeActive" : ""} ${regenerateDisabledReason ? "runModeDisabled" : ""}`}
              title={regenerateDisabledReason ?? undefined}
            >
              <input
                type="radio"
                name="runMode"
                disabled={Boolean(regenerateDisabledReason)}
                checked={runMode === "regenerate"}
                onChange={() => setRunMode("regenerate")}
              />
              <span>Regenerate stale</span>
              <small>
                {quality ? (
                  `${regenerable.toLocaleString()} episode(s) below v${quality.extractionVersion}`
                ) : (
                  <span className="metricSkeleton lineSkeleton short" aria-label="Regenerable episode count loading" />
                )}
              </small>
            </label>
          </div>
          {backfill && !modelBacked && (
            <div className="statusLine">
              Extractive backfill is permitted but spends zero model calls: every episode is a placeholder, all of them sweepable
              by a later model regeneration.
            </div>
          )}
          <div className="runConsoleGrid">
            <label className="runConsoleField" title={demo ? "Demo instance: model providers are disabled — runs are extractive-only." : undefined}>
              <span>Provider{demo ? " (demo: extractive only)" : ""}</span>
              <select
                disabled={demo}
                value={provider?.provider ?? "extractive"}
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
            <label className="runConsoleField" title={demo ? "Demo instance: model providers are disabled." : !modelBacked ? "Extractive mode makes no model calls." : undefined}>
              <span>Model{provider?.reasoningEffort ? ` · effort ${provider.reasoningEffort}` : ""}</span>
              <select
                disabled={!modelBacked || demo}
                value={provider?.model ?? modelOptions[0] ?? ""}
                onChange={(event) =>
                  provider &&
                  provider.provider !== "extractive" &&
                  onProviderAction({
                    action: "set-model",
                    provider: provider.provider as Exclude<BrainProviderName, "extractive">,
                    model: event.target.value
                  })
                }
              >
                {(modelBacked ? modelOptions : ["—"]).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            {modelBacked && (
              <button
                className="miniButton probeButton"
                type="button"
                disabled={Boolean(busy) || running}
                onClick={() => onProviderAction({ action: "probe" })}
                title="Make one tiny model call to verify the provider end-to-end"
              >
                Probe
              </button>
            )}
          </div>
          <div className={`statusLine ${provider?.degraded ? "degradedLine" : ""}`}>{provider?.message}</div>
        </div>

        <div className="runConsoleSection">
          <h3>Budgets</h3>
          <div className="runConsoleGrid">
            {backfill ? (
              <label className="runConsoleField" title="Optional cap on queue tasks this run (newest chats first) — the scoped confidence-pass knob. Empty drains the whole uncovered queue.">
                <span>Chats (optional cap)</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  placeholder="whole queue"
                  value={backfillChats}
                  onChange={(event) => setBackfillChats(event.target.value)}
                />
                {backfillChatsError ? (
                  <span className="fieldError">{backfillChatsError}</span>
                ) : (
                  <span className="fieldNote">Empty = drain everything; set ~20–30 for a confidence pass first.</span>
                )}
              </label>
            ) : runMode === "regenerate" ? (
              <>
              <label
                className="runConsoleField"
                title="Regenerate only episodes whose window holds at most this many messages — the thin-pack population a contract change actually affects. Empty regenerates every stale episode."
              >
                <span>Max messages (scope)</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  placeholder="all sizes"
                  value={regenMaxMessages}
                  onChange={(event) => setRegenMaxMessages(event.target.value)}
                />
                {regenScopeError ? (
                  <span className="fieldError">{regenScopeError}</span>
                ) : scopeValid ? (
                  <span className="fieldNote">
                    {regenScopedCount != null ? `${regenScopedCount.toLocaleString()} episode(s) of ≤${scopeNumber} message(s) selected.` : "Counting…"}
                  </span>
                ) : (
                  <span className="fieldNote">Empty = all {regenerable.toLocaleString()} stale episode(s); set 5 for the small-pack slice.</span>
                )}
              </label>
                <label
                  className="runConsoleField"
                  title="Per-run replacement for the configured daily model-call cap — a bulk re-derivation dwarfs the routine ceiling (the fallback-sweep button uses 10,000)."
                >
                  <span>Daily calls override</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    placeholder={`default ${overview?.limits?.maxCallsPerDay ?? "—"}`}
                    value={dailyOverride}
                    onChange={(event) => setDailyOverride(event.target.value)}
                  />
                  {dailyError ? (
                    <span className="fieldError">{dailyError}</span>
                  ) : (
                    <span className="fieldNote">
                      {remainingToday.toLocaleString()} of {dailyCap.toLocaleString()} daily calls left today; a scoped slice needs ~1 call per episode.
                    </span>
                  )}
                </label>
              </>
            ) : (
              <label className="runConsoleField" title="How many backlog chats this run assimilates (newest first).">
                <span>Chats</span>
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={maxChats}
                  onChange={(event) => setMaxChats(event.target.value)}
                />
                {chatsError && <span className="fieldError">{chatsError}</span>}
              </label>
            )}
            <label
              className={`runConsoleField ${callsDisabledReason ? "fieldDisabled" : ""}`}
              title={callsDisabledReason ?? `Hard cap on model calls this run. ${remainingToday.toLocaleString()} of ${dailyCap.toLocaleString()} daily calls left.`}
            >
              <span>Max model calls{backfill ? " (optional)" : ""}</span>
              <input
                type="number"
                min={1}
                max={backfill ? 100_000 : 1000}
                placeholder={backfill ? "no per-run ceiling" : undefined}
                disabled={Boolean(callsDisabledReason)}
                value={maxCalls}
                onChange={(event) => setMaxCalls(event.target.value)}
              />
              {callsDisabledReason ? (
                <span className="fieldNote">{callsDisabledReason}</span>
              ) : callsError ? (
                <span className="fieldError">{callsError}</span>
              ) : (
                <span className="fieldNote">{remainingToday.toLocaleString()} of {dailyCap.toLocaleString()} daily calls left today.</span>
              )}
            </label>
            <label
              className={`runConsoleField ${tokensDisabledReason ? "fieldDisabled" : ""}`}
              title={tokensDisabledReason ?? "Optional hard ceiling on input+output tokens this run; the run stops BEFORE the call that would cross it."}
            >
              <span>Max tokens (optional)</span>
              <input
                type="number"
                min={1000}
                step={1000}
                placeholder="no token budget"
                disabled={Boolean(tokensDisabledReason)}
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
              {tokensError ? <span className="fieldError">{tokensError}</span> : <span className="fieldNote">{tokenNote}</span>}
            </label>
          </div>
        </div>

        {backfill && (
          <div className="runConsoleSection">
            <h3>Turbo pacing</h3>
            <div className="runConsoleGrid">
              <label
                className={`runConsoleField ${pacingDisabledReason ? "fieldDisabled" : ""}`}
                title={pacingDisabledReason ?? "Optional hourly throttle for THIS run. Leave empty for no hourly limit — the worker pool and the daily ceiling pace it. Set a value only to deliberately go slower; reaching it ends the run as a named budget stop."}
              >
                <span>Calls/hour override</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  placeholder="no hourly limit"
                  disabled={Boolean(pacingDisabledReason)}
                  value={rateOverride}
                  onChange={(event) => setRateOverride(event.target.value)}
                />
                {pacingDisabledReason ? (
                  <span className="fieldNote">{pacingDisabledReason}</span>
                ) : rateError ? (
                  <span className="fieldError">{rateError}</span>
                ) : (
                  <span className="fieldNote">Empty = no hourly cap (overnight-safe). Set a number only to throttle slower.</span>
                )}
              </label>
              <label
                className={`runConsoleField ${pacingDisabledReason ? "fieldDisabled" : ""}`}
                title={pacingDisabledReason ?? "Per-run daily ceiling — the real budget guard for a long run. Empty falls back to the configured daily cap; raise it for an overnight drain. Reaching it ends the run as a named budget stop, resumable next day."}
              >
                <span>Calls/day override</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  placeholder={`default ${overview?.limits?.maxCallsPerDay ?? "—"}`}
                  disabled={Boolean(pacingDisabledReason)}
                  value={dailyOverride}
                  onChange={(event) => setDailyOverride(event.target.value)}
                />
                {dailyError ? (
                  <span className="fieldError">{dailyError}</span>
                ) : (
                  <span className="fieldNote">
                    The real budget guard — empty uses {(overview?.limits?.maxCallsPerDay ?? 0).toLocaleString()}/day. Raise it above the run's total for an unbroken drain.
                  </span>
                )}
              </label>
              <label
                className={`runConsoleField ${pacingDisabledReason ? "fieldDisabled" : ""}`}
                title={pacingDisabledReason ?? "Sliding worker pool width: parallel across chats, always serial within a chat. A freed slot claims the next task immediately — never batch barriers."}
              >
                <span>Parallel workers</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  disabled={Boolean(pacingDisabledReason)}
                  value={concurrency}
                  onChange={(event) => setConcurrency(event.target.value)}
                />
                {concurrencyError ? (
                  <span className="fieldError">{concurrencyError}</span>
                ) : (
                  <span className="fieldNote">Verified safe at 5 (2026-07-18 spikes): ~4× throughput, zero cross-talk.</span>
                )}
              </label>
            </div>
            <label
              className={`runConsoleStrictRow ${strictDisabledReason ? "fieldDisabled" : ""}`}
              title={
                strictDisabledReason ??
                "When model generation fails twice for a pack, commit NOTHING (no extractive placeholder, watermark unchanged) and fail the task visibly. Coverage stalls honestly instead of degrading silently."
              }
            >
              <input
                type="checkbox"
                disabled={Boolean(strictDisabledReason)}
                checked={strictMode && !strictDisabledReason}
                onChange={(event) => setStrictMode(event.target.checked)}
              />
              <span>
                Strict mode — no extractive placeholders; twice-failed packs stay pending as visible failed work
              </span>
            </label>
            {strictDisabledReason && <span className="fieldNote">{strictDisabledReason}</span>}
          </div>
        )}

        <footer className="runConsoleFooter">
          <div className="runConsoleFooterReason">{startDisabledReason}</div>
          <div className="runConsoleFooterActions">
            <button className="secondaryButton" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primaryButton"
              type="button"
              disabled={Boolean(startDisabledReason) || starting}
              title={startDisabledReason ?? undefined}
              onClick={() => void handleStart()}
            >
              {starting ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              {runMode === "regenerate"
                ? scopeValid
                  ? `Regenerate ${regenScopedCount != null ? regenScopedCount.toLocaleString() : "…"} (≤${scopeNumber} msgs)`
                  : `Regenerate ${regenerable.toLocaleString()}`
                : backfill
                  ? "Start backfill"
                  : "Start run"}
            </button>
          </div>
        </footer>

      </section>
    </div>
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

// `loading` renders a shimmer in place of the value — real numbers or a
// loader, never a placeholder 0 that reads as data.
function Metric({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="metric">
      <span>{label}</span>
      {loading ? <strong className="metricSkeleton" aria-label={`${label} loading`} /> : <strong>{value}</strong>}
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
  RunConsoleModal,
  MemoryPanel,
  OnboardingPanel,
  StatusPanel,
  ImportWizard,
  ImportLauncher,
  PairingModal,
  hasArchiveData
};
