import {
  AlertTriangle,
  ArrowRight,
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
  Sparkles,
  Trash2,
  Unlink,
  Upload,
  X
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { parseInlineSegments, parseWhatsAppBlocks, type InlineSegment } from "./whatsappFormat";
import type {
  ArchiveChangeEvent,
  ChatListItem,
  ImportJobSummary,
  ImportMode,
  ImportProgressEvent,
  ImportStagingFileKind,
  ImportStagingSessionSummary,
  ImportVerificationSummary,
  LiveGapWindowRecord,
  LivePairingSummary,
  LiveSyncProgress,
  MemoryCitationResolution,
  MemoryQueryResult,
  MessageEditRevisionRecord,
  MessageListItem,
  StatusSummary
} from "../shared/types";
import {
  cancelImportJob,
  cancelImportSession,
  cleanupTempFiles,
  createImportSession,
  disableMemoryProvider,
  enableCodexMemoryProvider,
  getCurrentImportJob,
  getImportJob,
  getLivePairing,
  getLiveProgress,
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
  queryMemory,
  resolveMemoryCitation,
  resumeLiveSession,
  retryLiveGap,
  retryStuckMedia,
  startMemoryRun,
  startImportJob,
  stopLiveSession,
  unlinkLiveSession,
  uploadImportFile,
  verifyImportKey
} from "./api";

const CHAT_LIMIT = 60;
const MESSAGE_LIMIT = 150;

export function App() {
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [liveGaps, setLiveGaps] = useState<LiveGapWindowRecord[]>([]);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [chatOffset, setChatOffset] = useState(0);
  const [chatSearch, setChatSearch] = useState("");
  const [chatType, setChatType] = useState("all");
  const [includeEventOnly, setIncludeEventOnly] = useState(false);
  const [selectedChat, setSelectedChat] = useState<ChatListItem | null>(null);
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [messageOffset, setMessageOffset] = useState(0);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [messageQuery, setMessageQuery] = useState("");
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importWizardOpen, setImportWizardOpen] = useState(false);
  const [activeImportJob, setActiveImportJob] = useState<ImportJobSummary | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairing, setPairing] = useState<LivePairingSummary | null>(null);
  const [liveProgress, setLiveProgress] = useState<LiveSyncProgress | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryResult, setMemoryResult] = useState<MemoryQueryResult | null>(null);
  const [memoryCitation, setMemoryCitation] = useState<MemoryCitationResolution | null>(null);
  const [lightbox, setLightbox] = useState<{ assetId: number; mimeType: string | null } | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const loadingMessagesRef = useRef(false);
  const scrollActionRef = useRef<"bottom" | "preserve" | null>(null);
  const previousScrollHeightRef = useRef(0);

  useEffect(() => {
    void refreshStatus();
    void reattachActiveImport();
  }, []);

  useEffect(() => {
    void loadChats(true);
  }, [chatSearch, chatType, includeEventOnly]);

  useEffect(() => {
    if (selectedChat) {
      setMessageOffset(0);
      setMessageHasMore(false);
      setMessages([]);
      scrollActionRef.current = "bottom";
      void loadMessages(selectedChat, true);
    }
  }, [selectedChat?.id, messageQuery]);

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
        void loadChats(true);
        const currentSelectedChat = selectedChat;
        const selectedChatChanged = currentSelectedChat
          ? change.chatSourceIds.length === 0 || change.chatSourceIds.includes(currentSelectedChat.sourceChatId)
          : false;
        // WhatsApp behavior: live updates follow the conversation only when the
        // user is already at the bottom; never move them while reading history.
        if (currentSelectedChat && selectedChatChanged && isNearBottom(messageListRef.current)) {
          setMessageOffset(0);
          setMessageHasMore(false);
          scrollActionRef.current = "bottom";
          void loadMessages(currentSelectedChat, true);
        }
        // 1s throttle: initial history sync fires many archive events per
        // second, and each refresh runs real status queries on the server.
      }, 1000);
    };

    events.addEventListener("archive-updated", (event) => {
      try {
        scheduleRefresh(JSON.parse((event as MessageEvent).data) as ArchiveChangeEvent);
      } catch {
        // Ignore malformed local stream messages; the browser will keep the stream alive.
      }
    });

    return () => {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      events.close();
    };
  }, [selectedChat?.sourceChatId, messageQuery, chatSearch, chatType, includeEventOnly]);

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
  }, [pairingOpen]);

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

  useLayoutEffect(() => {
    const list = messageListRef.current;
    const action = scrollActionRef.current;
    if (!list || !action) {
      return;
    }
    if (messages.length === 0) {
      // Chat switches render an intermediate empty list; keep the pending
      // scroll intent alive until real content exists to scroll to.
      return;
    }
    if (action === "bottom") {
      list.scrollTop = list.scrollHeight;
    } else {
      const heightDelta = list.scrollHeight - previousScrollHeightRef.current;
      list.scrollTop += heightDelta;
    }
    scrollActionRef.current = null;
  }, [messages]);

  async function refreshStatus() {
    try {
      setStatusError(null);
      const next = await getStatus();
      setStatus(next);
      setLiveGaps(await listLiveGaps().catch(() => []));
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Status unavailable.");
    }
  }

  async function loadChats(reset = false) {
    setLoadingChats(true);
    try {
      const offset = reset ? 0 : chatOffset;
      const next = await listChats({ search: chatSearch, type: chatType, includeEventOnly, limit: CHAT_LIMIT, offset });
      setChats((current) => (reset ? next : [...current, ...next]));
      setChatOffset(offset + next.length);
      if (reset && selectedChat) {
        const refreshedSelectedChat = next.find((chat) => chat.id === selectedChat.id);
        if (refreshedSelectedChat) {
          setSelectedChat(refreshedSelectedChat);
        } else {
          setSelectedChat(null);
          setMessages([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load chats.");
    } finally {
      setLoadingChats(false);
    }
  }

  async function loadMessages(chat: ChatListItem, reset = false) {
    if (loadingMessagesRef.current) {
      return;
    }
    loadingMessagesRef.current = true;
    setLoadingMessages(true);
    try {
      const offset = reset ? 0 : messageOffset;
      if (!reset) {
        previousScrollHeightRef.current = messageListRef.current?.scrollHeight ?? 0;
        scrollActionRef.current = "preserve";
      }
      const next = await listMessages(chat.id, { limit: MESSAGE_LIMIT, offset, query: messageQuery, order: "desc" });
      setMessages((current) => sortMessagesChronologically(reset ? next : [...current, ...next]));
      setMessageOffset(offset + next.length);
      setMessageHasMore(next.length === MESSAGE_LIMIT);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load messages.");
    } finally {
      loadingMessagesRef.current = false;
      setLoadingMessages(false);
    }
  }

  function handleMessageScroll() {
    if (!selectedChat || !messageHasMore || loadingMessagesRef.current) {
      return;
    }
    const list = messageListRef.current;
    if (list && list.scrollTop < 96) {
      void loadMessages(selectedChat, false);
    }
  }

  async function handleInit() {
    setBusy("Initializing database");
    setError(null);
    setNotice(null);
    try {
      const result = await initDatabase();
      setStatus(result.status);
      setNotice("Archive database initialized.");
      await loadChats(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not initialize database.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCleanup() {
    setBusy("Cleaning temp files");
    setError(null);
    setNotice(null);
    try {
      const result = await cleanupTempFiles();
      setNotice(`Cleanup complete: ${result.summary.removedFiles.toLocaleString()} files removed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed.");
    } finally {
      setBusy(null);
    }
  }

  async function reattachActiveImport() {
    try {
      const result = await getCurrentImportJob();
      if (result.job && (result.job.status === "queued" || result.job.status === "running" || result.job.status === "cancelling")) {
        setActiveImportJob(result.job);
        setImportWizardOpen(true);
      }
    } catch {
      // The app can still browse the archive if no resumable import job is available.
    }
  }

  async function handleRetryGap(id: number) {
    setBusy("Retrying live gap");
    setError(null);
    setNotice(null);
    try {
      const result = await retryLiveGap(id);
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      setLiveGaps(await listLiveGaps());
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
    setNotice(null);
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

  async function handleUnlinkLive() {
    if (!window.confirm("Unlinking removes local live credentials. You will need to scan or pair WhatsApp again.")) {
      return;
    }
    setBusy("Unlinking live session");
    setError(null);
    setNotice(null);
    try {
      const result = await unlinkLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      await refreshStatus();
      setLiveGaps(await listLiveGaps());
      setNotice("Live session state removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink live session.");
    } finally {
      setBusy(null);
    }
  }

  async function handleStopLive() {
    setBusy("Pausing live sync");
    setError(null);
    setNotice(null);
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

  async function handleLinkLive() {
    setBusy("Starting live link");
    setError(null);
    setNotice(null);
    try {
      const result = await linkLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      setPairing(result.pairing);
      setPairingOpen(true);
      setNotice("Live pairing started locally.");
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start live pairing.");
    } finally {
      setBusy(null);
    }
  }

  async function handleResumeLive() {
    setBusy("Resuming live sync");
    setError(null);
    setNotice(null);
    try {
      const result = await resumeLiveSession();
      setStatus((current) => (current ? { ...current, live: result.live } : current));
      setPairing(result.pairing);
      setPairingOpen(true);
      setNotice("Live sync resume started.");
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume live sync.");
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFinished(job: ImportJobSummary) {
    setActiveImportJob(job.status === "completed" ? null : job);
    setNotice(job.totals ? `Import complete: ${job.totals.messages.toLocaleString()} messages.` : "Import complete.");
    await refreshStatus();
    await loadChats(true);
  }

  async function handleImportStopped(job: ImportJobSummary) {
    setActiveImportJob(null);
    setNotice(job.error ?? "Import stopped and rolled back.");
    await refreshStatus();
    await loadChats(true);
  }

  async function handleMemoryRun(dryRun = false) {
    setBusy(dryRun ? "Previewing memory" : "Running memory REM");
    setError(null);
    setNotice(null);
    try {
      const result = await startMemoryRun({ kind: "rem", dryRun, provider: "local" });
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
    setNotice(null);
    try {
      await enableCodexMemoryProvider();
      await refreshStatus();
      setNotice("Codex memory provider enabled. Run CLI login before remote generation if no session exists.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable Codex memory.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDisableMemoryProvider() {
    setBusy("Disabling remote memory");
    setError(null);
    setNotice(null);
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

  const groupedMessages = useMemo(() => groupMessagesByDay(messages), [messages]);

  return (
    <div className="appShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandMark">
            <MessageCircle size={20} />
          </div>
          <div>
            <h1>Wapp Brain</h1>
            <p>Local WhatsApp archive</p>
          </div>
        </div>
        <div className="topActions">
          <span className="localBadge">
            <ShieldCheck size={16} />
            127.0.0.1
          </span>
          <button className="iconButton" onClick={() => void refreshStatus()} title="Refresh status" aria-label="Refresh status">
            <RefreshCcw size={18} />
          </button>
          <button className="iconButton mutedIcon" title="Local dark theme" aria-label="Local dark theme">
            <Moon size={18} />
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <OnboardingPanel
            status={status}
            busy={busy}
            progress={liveProgress}
            onImport={() => setImportWizardOpen(true)}
            onLink={() => void handleLinkLive()}
            onResume={() => void handleResumeLive()}
            onReviewGaps={() => {
              const gap = document.querySelector(".gapList");
              gap?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
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
            onImport={() => setImportWizardOpen(true)}
            onLink={() => void handleLinkLive()}
            onRetryGap={(id) => void handleRetryGap(id)}
            onRetryMedia={() => void handleRetryMedia()}
            onPause={() => void handleStopLive()}
            onResume={() => void handleResumeLive()}
            onUnlink={() => void handleUnlinkLive()}
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

          <ImportLauncher status={status} onOpen={() => setImportWizardOpen(true)} />

          <div className="filterPanel">
            <div className="searchBox">
              <Search size={16} />
              <input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search chats" />
            </div>
            <div className="segmented">
              {["all", "dm", "group", "broadcast", "status"].map((type) => (
                <button key={type} className={chatType === type ? "active" : ""} onClick={() => setChatType(type)} type="button">
                  {type}
                </button>
              ))}
            </div>
            <label className="filterToggle">
              <input
                type="checkbox"
                checked={includeEventOnly}
                onChange={(event) => {
                  setIncludeEventOnly(event.target.checked);
                  setChatOffset(0);
                }}
              />
              <span>Show event-only chats</span>
            </label>
          </div>

          <div className="chatList" aria-live="polite">
            {chats.map((chat) => (
              <button
                key={chat.id}
                className={`chatRow ${selectedChat?.id === chat.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedChat(chat);
                  setMessageOffset(0);
                  setMessageHasMore(false);
                }}
                type="button"
              >
                <span className="chatName">{chatDisplayLabel(chat)}</span>
                <span className="chatMeta">
                  <span>{chat.chatType}</span>
                  <span>{chat.messageCount.toLocaleString()}</span>
                  <span>{formatDate(chat.lastMessageAt)}</span>
                </span>
              </button>
            ))}
            {loadingChats && <SkeletonRows />}
            {!loadingChats && chats.length === 0 && <EmptyState icon={<Eye size={20} />} text="No chats loaded" />}
            {chats.length > 0 && (
              <button className="loadButton" onClick={() => void loadChats(false)} disabled={loadingChats} type="button">
                Load more
              </button>
            )}
          </div>
        </aside>

        <section className="messagePane">
          {(notice || error) && (
            <div className={`toastLine ${error ? "error" : "notice"}`}>
              {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              <span>{error ?? notice}</span>
            </div>
          )}

          {selectedChat ? (
            <>
              <div className="threadHeader">
                <div>
                  <h2>{chatDisplayLabel(selectedChat)}</h2>
                  <p>
                    {selectedChat.chatType} | {selectedChat.messageCount.toLocaleString()} messages
                    {selectedChat.participantCount ? ` | ${selectedChat.participantCount.toLocaleString()} participants` : ""}
                  </p>
                </div>
                <div className="threadSearch">
                  <Search size={16} />
                  <input value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} placeholder="Search messages" />
                </div>
              </div>

              <div className="messageList" ref={messageListRef} onScroll={handleMessageScroll}>
                {messages.length > 0 && messageHasMore && (
                  <div className="olderMessageStatus">
                    {loadingMessages ? <Loader2 className="spin" size={14} /> : null}
                    <span>{loadingMessages ? "Loading older messages" : "Scroll up for older messages"}</span>
                  </div>
                )}
                {groupedMessages.map((group) => (
                  <div key={group.day} className="dayGroup">
                    <div className="dayMarker">{group.day}</div>
                    {groupConsecutiveMedia(group.items).map((entry) =>
                      entry.kind === "grid" ? (
                        <MediaGridBubble
                          key={`grid-${entry.messages[0].id}`}
                          messages={entry.messages}
                          isGroup={selectedChat.chatType === "group"}
                          onOpenMedia={(assetId, mimeType) => setLightbox({ assetId, mimeType })}
                        />
                      ) : (
                        <MessageBubble
                          key={entry.message.id}
                          message={entry.message}
                          isGroup={selectedChat.chatType === "group"}
                          onOpenMedia={(assetId, mimeType) => setLightbox({ assetId, mimeType })}
                        />
                      )
                    )}
                  </div>
                ))}
                {loadingMessages && messages.length === 0 && <SkeletonMessages />}
                {!loadingMessages && messages.length === 0 && <EmptyState icon={<MessageCircle size={22} />} text="No messages loaded" />}
                {messages.length > 0 && (
                  <div className="messageWindowNote">
                    Showing {messages.length.toLocaleString()} newest matching messages in chronological order.
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="emptyThread">
              <HardDrive size={36} />
              <h2>Archive ready</h2>
              <p>
                {status?.counts.messages
                  ? `${status.counts.messages.toLocaleString()} local messages are available.`
                  : "Initialize the local archive, import local files, then select a chat."}
              </p>
            </div>
          )}
        </section>
      </main>
      {importWizardOpen && (
        <ImportWizard
          status={status}
          initialJob={activeImportJob}
          onClose={() => setImportWizardOpen(false)}
          onComplete={(job) => void handleImportFinished(job)}
          onStopped={(job) => void handleImportStopped(job)}
        />
      )}
      {pairingOpen && <PairingModal pairing={pairing} onClose={() => setPairingOpen(false)} onRetry={() => void handleLinkLive()} />}
      {lightbox && <MediaLightbox assetId={lightbox.assetId} mimeType={lightbox.mimeType} onClose={() => setLightbox(null)} />}
    </div>
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
  const [livePanelOpen, setLivePanelOpen] = useState(false);
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

function ImportWizard({
  status,
  initialJob,
  onClose,
  onComplete,
  onStopped
}: {
  status: StatusSummary | null;
  initialJob: ImportJobSummary | null;
  onClose: () => void;
  onComplete: (job: ImportJobSummary) => void;
  onStopped: (job: ImportJobSummary) => void;
}) {
  const [step, setStep] = useState<"files" | "key" | "mode" | "import">(initialJob ? "import" : "files");
  const [session, setSession] = useState<ImportStagingSessionSummary | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [paths, setPaths] = useState({ msgstorePath: "", waPath: "", mediaPath: "", keyPath: "" });
  const [key, setKey] = useState("");
  const [useStagedKey, setUseStagedKey] = useState(false);
  const [verification, setVerification] = useState<ImportVerificationSummary | null>(null);
  const [mode, setMode] = useState<ImportMode>(hasArchiveData(status) ? "merge" : "merge");
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
    if (initialJob) {
      return;
    }
    let cancelled = false;
    createImportSession()
      .then((result) => {
        if (!cancelled) setSession(result.session);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not create import session.");
      });
    return () => {
      cancelled = true;
    };
  }, [initialJob]);

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

  const hasSelectedBackup = Boolean(session?.files.msgstore || paths.msgstorePath.trim());
  const needsReplaceConfirmation = hasArchiveData(status) && mode === "replace";
  const canStart = verification?.ok && (!needsReplaceConfirmation || replaceConfirm.trim().toLowerCase() === "replace");

  async function upload(kind: ImportStagingFileKind, fileList: FileList | null) {
    if (!session || !fileList?.length) return;
    setBusy(`Uploading ${kind}`);
    setError(null);
    try {
      let next = session;
      const files = Array.from(fileList);
      for (const file of files) {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        next = (await uploadImportFile(session.id, kind, file, relative)).session;
      }
      setSession(next);
      if (kind === "key") setUseStagedKey(true);
      setVerification(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stage selected file.");
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy("Verifying key");
    setError(null);
    try {
      const result = await verifyImportKey({
        sessionId: session?.id ?? null,
        msgstorePath: paths.msgstorePath || null,
        waPath: paths.waPath || null,
        key: key || null,
        keyPath: paths.keyPath || null,
        useStagedKey
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
        sessionId: session?.id ?? null,
        mode,
        key: key || null,
        keepDecrypted,
        paths: {
          msgstorePath: paths.msgstorePath || undefined,
          waPath: paths.waPath || undefined,
          mediaPath: paths.mediaPath || undefined,
          keyPath: paths.keyPath || undefined
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
        "Stop this import and roll back any archive changes written by this job? Your selected staging files will be removed, and you can start again afterward."
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
    if (session && !job) {
      await cancelImportSession(session.id).catch(() => undefined);
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
            <p>Pick files, verify the key locally, choose merge or replace, then watch the import phases.</p>
          </div>
          <button className="iconButton" onClick={() => void close()} type="button" aria-label="Close import wizard">
            <X size={16} />
          </button>
        </div>
        <div className="wizardSteps">
          {["files", "key", "mode", "import"].map((item, index) => (
            <div className={`wizardStep ${step === item ? "active" : ""}`} key={item}>
              <span>{index + 1}</span>
              <strong>{item === "files" ? "Files" : item === "key" ? "Verify" : item === "mode" ? "Mode" : "Import"}</strong>
            </div>
          ))}
        </div>
        {error && (
          <div className="wizardError">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
        {step === "files" && (
          <div className="wizardBody">
            <FilePickRow
              icon={<Database size={18} />}
              title="Encrypted msgstore"
              description="Required. Select msgstore.db.crypt15 or an already decrypted msgstore.db."
              file={session?.files.msgstore}
              accept=".crypt15,.db"
              onPick={(files) => void upload("msgstore", files)}
            />
            <FilePickRow
              icon={<HardDrive size={18} />}
              title="Contacts database"
              description="Optional. wa.db or wa.db.crypt15 improves saved contact names."
              file={session?.files.wa}
              accept=".crypt15,.db"
              onPick={(files) => void upload("wa", files)}
            />
            <FilePickRow
              icon={<KeyRound size={18} />}
              title="Backup key file"
              description="Optional. You can also paste the 64-character key in the next step."
              file={session?.files.key}
              accept=".key,*"
              onPick={(files) => void upload("key", files)}
            />
            <FilePickRow
              icon={<FolderOpen size={18} />}
              title="Media folder"
              description="Optional. Your WhatsApp media is archived and shown in chats. For the real multi-GB folder, type its local path below — the server reads it directly from disk."
              file={session?.files.media}
              directory
              onPick={(files) => void upload("media", files)}
            />
            <label className="wizardField mediaPathField">
              <span>Media folder path (recommended for large folders — nothing is uploaded; a wrong path never blocks the import)</span>
              <input
                value={paths.mediaPath}
                onChange={(event) => setPaths((current) => ({ ...current, mediaPath: event.target.value }))}
                autoComplete="off"
                placeholder="e.g. D:\\Backups\\WhatsApp\\Media"
              />
            </label>
            <button className="textButton" type="button" onClick={() => setManualOpen((current) => !current)}>
              {manualOpen ? "Hide advanced paths" : "Use advanced path fallback"}
            </button>
            {manualOpen && (
              <div className="manualPathGrid">
                <PathInput label="msgstore path" value={paths.msgstorePath} onChange={(value) => setPaths((current) => ({ ...current, msgstorePath: value }))} />
                <PathInput label="wa.db or wa.db.crypt15 path" value={paths.waPath} onChange={(value) => setPaths((current) => ({ ...current, waPath: value }))} />
                <PathInput label="key file path" value={paths.keyPath} onChange={(value) => setPaths((current) => ({ ...current, keyPath: value }))} />
              </div>
            )}
            <WizardActions
              busy={busy}
              primaryLabel="Verify key"
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
            {session?.files.key && (
              <label className="checkRow wizardCheck">
                <input type="checkbox" checked={useStagedKey} onChange={(event) => setUseStagedKey(event.target.checked)} />
                <span>Use selected key file: {session.files.key.name}</span>
              </label>
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
              primaryDisabled={Boolean(busy) || (!key && !useStagedKey && !paths.keyPath)}
              onPrimary={() => void verify()}
              onBack={() => setStep("files")}
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

function FilePickRow({
  icon,
  title,
  description,
  file,
  accept,
  directory,
  onPick
}: {
  icon: ReactNode;
  title: string;
  description: string;
  file?: { name: string; size: number } | null;
  accept?: string;
  directory?: boolean;
  onPick: (files: FileList | null) => void;
}) {
  return (
    <div className="filePickRow">
      <div className="fileIcon">{icon}</div>
      <div>
        <strong>{title}</strong>
        <p>{file ? `${file.name} | ${formatBytes(file.size)}` : description}</p>
      </div>
      <label className="fileButton">
        Pick
        <input
          type="file"
          accept={accept}
          multiple={directory}
          {...(directory ? { webkitdirectory: "true" } : {})}
          onChange={(event) => onPick(event.target.files)}
        />
      </label>
    </div>
  );
}

function PathInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="wizardField">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off" />
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
    Boolean(latestStep && ["decrypting", "opening", "parsing", "contacts", "chats"].includes(latestStep.step));
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
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
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

// Mention tokens inside display text: server-resolved "@<label>" spans (the
// exact labels arrive on the DTO) plus raw unresolved "@<digits>" tokens.
function renderMentions(text: string, mentions: string[]): ReactNode {
  const tokens = [...new Set(mentions)]
    .sort((a, b) => b.length - a.length)
    .map((label) => escapeRegExp(`@${label}`));
  tokens.push("@\\d{5,20}");
  const splitter = new RegExp(`(${tokens.join("|")})`);
  const parts = text.split(splitter);
  if (parts.length === 1) {
    return text;
  }
  // A single capture group means odd indices are the matched mention tokens.
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="mention">
        {part}
      </span>
    ) : (
      part
    )
  );
}

// Render one WhatsApp inline-formatting tree: bold/italic/strike nest, code and
// monospace are literal, URLs are clickable, and plain text keeps mention
// highlighting.
function renderInline(segments: InlineSegment[], mentions: string[]): ReactNode {
  return segments.map((segment, index) => {
    switch (segment.type) {
      case "text":
        return <span key={index}>{renderMentions(segment.value, mentions)}</span>;
      case "url":
        return (
          <a
            key={index}
            className="linkText"
            href={segment.value.startsWith("www.") ? `https://${segment.value}` : segment.value}
            target="_blank"
            rel="noopener noreferrer"
          >
            {segment.value}
          </a>
        );
      case "code":
        return (
          <code key={index} className="fmtMono">
            {segment.value}
          </code>
        );
      case "bold":
        return <strong key={index}>{renderInline(segment.children, mentions)}</strong>;
      case "italic":
        return <em key={index}>{renderInline(segment.children, mentions)}</em>;
      case "strike":
        return <del key={index}>{renderInline(segment.children, mentions)}</del>;
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Inline-only rendering for one-line contexts (system chips): no block-level
// lists/quotes, just formatting + links + mentions.
function renderInlineText(text: string, mentions: string[]): ReactNode {
  return renderInline(parseInlineSegments(text), mentions);
}

// Full message text: block-aware (quotes, bulleted and numbered lists) with
// inline formatting inside. The container is pre-wrap, so paragraph line breaks
// come from newline text nodes.
function renderRichText(text: string, mentions: string[]): ReactNode {
  return parseWhatsAppBlocks(text).map((block, blockIndex) => {
    if (block.type === "bullet" || block.type === "numbered") {
      const items = block.items.map((segments, itemIndex) => <li key={itemIndex}>{renderInline(segments, mentions)}</li>);
      return block.type === "bullet" ? (
        <ul key={blockIndex} className="fmtList">
          {items}
        </ul>
      ) : (
        <ol key={blockIndex} className="fmtList">
          {items}
        </ol>
      );
    }
    const lineNodes: ReactNode[] = [];
    block.lines.forEach((segments, lineIndex) => {
      if (lineIndex > 0) {
        lineNodes.push("\n");
      }
      lineNodes.push(<Fragment key={lineIndex}>{renderInline(segments, mentions)}</Fragment>);
    });
    return block.type === "quote" ? (
      <blockquote key={blockIndex} className="fmtQuote">
        {lineNodes}
      </blockquote>
    ) : (
      <Fragment key={blockIndex}>{lineNodes}</Fragment>
    );
  });
}

type OnOpenMedia = (assetId: number, mimeType: string | null) => void;

function MessageBubble({ message, isGroup, onOpenMedia }: { message: MessageListItem; isGroup: boolean; onOpenMedia: OnOpenMedia }) {
  const text = message.body || message.caption;
  const placeholder = messagePlaceholder(message);
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasHistory = message.editRevisionCount > 0;

  if (isSystemEvent(message)) {
    return (
      <article className="systemChip">
        <span>{text ? renderInlineText(text, message.mentions) : placeholder.label}</span>
        <time>{formatTime(message.sentAt)}</time>
      </article>
    );
  }
  return (
    <article className={`messageBubble ${message.direction} ${message.isDeleted ? "deleted" : ""}`}>
      <div className="messageMeta">
        {isGroup && message.direction !== "outgoing" && <span>{message.senderDisplayName ?? "Unresolved contact"}</span>}
        <span className="metaRight">
          {message.isDeleted && <span className="deletedChip">deleted</span>}
          {message.isEdited &&
            (hasHistory ? (
              <button
                className="editedChip clickable"
                type="button"
                onClick={() => setHistoryOpen(true)}
                title="View edit history"
                aria-expanded={historyOpen}
              >
                <History size={11} />
                edited
              </button>
            ) : (
              <span className="editedChip">edited</span>
            ))}
          <time>{formatTime(message.sentAt)}</time>
        </span>
      </div>
      {message.media && <MessageMediaView message={message} onOpenMedia={onOpenMedia} />}
      {text ? (
        <div className="messageText">{renderRichText(text, message.mentions)}</div>
      ) : (
        !message.media && (
          <p className="placeholderText">
            {placeholder.label}
            {placeholder.reason && <span className="placeholderReason">{placeholder.reason}</span>}
          </p>
        )
      )}
      {message.linkPreview && <LinkPreviewCard message={message} />}
      {(message.isForwarded || message.isStarred || (message.hasMedia && !message.media)) && (
        <div className="messageFlags">
          {message.hasMedia && !message.media && <span>{message.mediaMimeType ?? message.messageType}</span>}
          {message.isForwarded && <span>forwarded</span>}
          {message.isStarred && <span>starred</span>}
        </div>
      )}
      {historyOpen && <EditHistoryModal message={message} onClose={() => setHistoryOpen(false)} />}
    </article>
  );
}

// A version in the reconstructed timeline: the text that was showing, and the
// moment it became the message's content.
interface EditTimelineEntry {
  key: string;
  label: string;
  timeMs: number | null;
  text: string;
  current: boolean;
}

// Reconstruct the full version timeline from the message and its retained prior
// revisions. Each revision stores the text of a past version and the time it
// was replaced; a version therefore became active when the PREVIOUS one was
// replaced (and the very first became active at the original send time). This
// is what makes the timestamps read correctly — "Original 12:31 / Edited 12:32"
// instead of tagging the old text with the time it was edited away.
function buildEditTimeline(message: MessageListItem, revisions: MessageEditRevisionRecord[]): EditTimelineEntry[] {
  const currentText = message.body ?? message.caption ?? "(no text)";
  if (revisions.length === 0) {
    return [{ key: "cur", label: "Current version", timeMs: message.timestampMs, text: currentText, current: true }];
  }
  const entries: EditTimelineEntry[] = [
    { key: "orig", label: "Original", timeMs: message.timestampMs, text: revisions[0].body ?? revisions[0].caption ?? "(no text)", current: false }
  ];
  for (let index = 1; index < revisions.length; index += 1) {
    entries.push({
      key: `rev-${revisions[index].revisionIndex}`,
      label: "Edited",
      timeMs: revisions[index - 1].editedAtMs,
      text: revisions[index].body ?? revisions[index].caption ?? "(no text)",
      current: false
    });
  }
  entries.push({
    key: "cur",
    label: "Current version",
    timeMs: revisions[revisions.length - 1].editedAtMs,
    text: currentText,
    current: true
  });
  return entries;
}

// Modal timeline of a message's edits, oldest to newest, each version labeled
// with when it became the message's content.
function EditHistoryModal({ message, onClose }: { message: MessageListItem; onClose: () => void }) {
  const [revisions, setRevisions] = useState<MessageEditRevisionRecord[] | null>(null);
  // Fetch fresh whenever the modal opens, and re-fetch when a live edit adds a
  // revision (the count changes) — so the history never shows a stale snapshot.
  // Kept in the modal (not cached on the bubble) so reopening always reloads.
  useEffect(() => {
    let cancelled = false;
    listMessageRevisions(message.id)
      .then((result) => {
        if (!cancelled) setRevisions(result);
      })
      .catch(() => {
        if (!cancelled) setRevisions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [message.id, message.editRevisionCount]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Built oldest-to-newest for correct "became active" timestamps, shown
  // newest-first so the current version is on top.
  const timeline = revisions ? buildEditTimeline(message, revisions).reverse() : null;
  const lastEditedMs = revisions && revisions.length > 0 ? revisions[revisions.length - 1].editedAtMs : null;
  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-label="Message edit history" onClick={onClose}>
      <section className="editHistoryModal" onClick={(event) => event.stopPropagation()}>
        <div className="editHistoryModalHeader">
          <div>
            <span className="eyebrow">
              <History size={14} />
              Edit history
            </span>
            <h2>
              {timeline ? `${timeline.length} version${timeline.length === 1 ? "" : "s"}` : "Loading…"}
            </h2>
            {lastEditedMs != null && <p>Last edited {formatDateTime(lastEditedMs)}</p>}
          </div>
          <button className="iconButton" type="button" onClick={onClose} aria-label="Close edit history">
            <X size={16} />
          </button>
        </div>
        <div className="editTimeline">
          {timeline == null ? (
            <div className="editTimelineLoading">
              <Loader2 className="spin" size={18} />
              Loading history…
            </div>
          ) : (
            timeline.map((entry) => (
              <div className={`editTimelineEntry ${entry.current ? "current" : ""}`} key={entry.key}>
                <div className="editTimelineHead">
                  <span className="editTimelineLabel">{entry.label}</span>
                  <time>{formatDateTime(entry.timeMs)}</time>
                </div>
                <p className="editTimelineText">{entry.text}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

// Media block inside a bubble: real media when stored (image/sticker opens
// full size, video with poster, inline audio player, document row) and an
// honest labeled placeholder when not, with a visible view-once badge.
function MessageMediaView({ message, onOpenMedia }: { message: MessageListItem; onOpenMedia: OnOpenMedia }) {
  const media = message.media!;
  const placeholder = messagePlaceholder(message);
  if (media.availability !== "stored" || media.assetId == null) {
    return (
      <div className="mediaUnavailable">
        {media.isViewOnce && <span className="viewOnceBadge">view once</span>}
        <span className="mediaUnavailableLabel">{placeholder.label}</span>
        {placeholder.reason && <span className="placeholderReason">{placeholder.reason}</span>}
      </div>
    );
  }
  const assetId = media.assetId;
  const mime = media.mimeType ?? "";
  const isSticker = message.messageType === "sticker" || mime === "image/webp";
  if (mime.startsWith("image/")) {
    return (
      <button className={`mediaFrame ${isSticker ? "sticker" : ""}`} type="button" onClick={() => onOpenMedia(assetId, media.mimeType)}>
        {/* Full bytes are local; the embedded thumbnail keeps long threads light. */}
        <img
          className="mediaImage"
          loading="lazy"
          src={media.hasThumbnail && !isSticker ? mediaThumbnailUrl(assetId) : mediaAssetUrl(assetId)}
          alt={message.mediaName ?? "Archived media"}
          width={media.width ?? undefined}
          height={media.height ?? undefined}
        />
        {media.isViewOnce && <span className="viewOnceBadge">view once</span>}
      </button>
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <div className="mediaFrame">
        <video
          className="mediaVideo"
          controls
          preload="none"
          poster={media.hasThumbnail ? mediaThumbnailUrl(assetId) : undefined}
          src={mediaAssetUrl(assetId)}
        />
        {media.isViewOnce && <span className="viewOnceBadge">view once</span>}
      </div>
    );
  }
  if (mime.startsWith("audio/")) {
    return (
      <div className="mediaAudio">
        {media.isViewOnce && <span className="viewOnceBadge">view once</span>}
        <audio controls preload="none" src={mediaAssetUrl(assetId)} />
        {media.durationMs != null && <span className="mediaDuration">{formatDuration(media.durationMs)}</span>}
      </div>
    );
  }
  return (
    <a className="documentRow" href={mediaAssetUrl(assetId)} target="_blank" rel="noopener noreferrer">
      <FileText size={18} />
      <span className="documentName">{message.mediaName ?? placeholder.label}</span>
      {media.byteSize != null && <span className="documentSize">{formatBytes(media.byteSize)}</span>}
      {media.isViewOnce && <span className="viewOnceBadge">view once</span>}
    </a>
  );
}

// Offline link-preview card from stored sender-embedded data; never fetches
// the link target.
function LinkPreviewCard({ message }: { message: MessageListItem }) {
  const preview = message.linkPreview!;
  const href = preview.canonicalUrl
    ? preview.canonicalUrl.startsWith("http")
      ? preview.canonicalUrl
      : `https://${preview.canonicalUrl}`
    : null;
  const body = (
    <>
      {preview.hasThumbnail && <img className="linkPreviewThumb" loading="lazy" src={linkPreviewThumbnailUrl(message.id)} alt="" />}
      <span className="linkPreviewText">
        {preview.title && <strong>{preview.title}</strong>}
        {preview.description && <span>{preview.description}</span>}
        {preview.canonicalUrl && <span className="linkPreviewUrl">{preview.canonicalUrl}</span>}
      </span>
    </>
  );
  return href ? (
    <a className="linkPreviewCard" href={href} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    <div className="linkPreviewCard">{body}</div>
  );
}

// WhatsApp-style grid for runs of consecutive media from one sender: 2x2 with
// a "+N" overflow tile; expanding and opening items is display-only.
function MediaGridBubble({ messages, isGroup, onOpenMedia }: { messages: MessageListItem[]; isGroup: boolean; onOpenMedia: OnOpenMedia }) {
  const [expanded, setExpanded] = useState(false);
  const first = messages[0];
  const visible = expanded ? messages : messages.slice(0, 4);
  const overflow = messages.length - 4;
  return (
    <article className={`messageBubble mediaGridBubble ${first.direction}`}>
      <div className="messageMeta">
        {isGroup && first.direction !== "outgoing" && <span>{first.senderDisplayName ?? "Unresolved contact"}</span>}
        <span className="metaRight">
          <span className="gridCount">{messages.length} media</span>
          <time>{formatTime(first.sentAt)}</time>
        </span>
      </div>
      <div className="mediaGrid">
        {visible.map((message, index) => {
          const media = message.media!;
          const isOverflowTile = !expanded && overflow > 0 && index === 3;
          return (
            <button
              key={message.id}
              className="gridTile"
              type="button"
              onClick={() => (isOverflowTile ? setExpanded(true) : onOpenMedia(media.assetId!, media.mimeType))}
            >
              <img
                loading="lazy"
                src={media.hasThumbnail ? mediaThumbnailUrl(media.assetId!) : mediaAssetUrl(media.assetId!)}
                alt=""
              />
              {media.mimeType?.startsWith("video/") && !isOverflowTile && (
                <span className="gridPlay">
                  <Play size={18} />
                </span>
              )}
              {message.isDeleted && !isOverflowTile && <span className="deletedChip gridDeleted">deleted</span>}
              {isOverflowTile && <span className="gridOverflow">+{overflow}</span>}
            </button>
          );
        })}
      </div>
    </article>
  );
}

function MediaLightbox({ assetId, mimeType, onClose }: { assetId: number; mimeType: string | null; onClose: () => void }) {
  return (
    <div className="modalBackdrop lightboxBackdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="iconButton lightboxClose" type="button" aria-label="Close media view" onClick={onClose}>
        <X size={18} />
      </button>
      <div className="lightboxContent" onClick={(event) => event.stopPropagation()}>
        {mimeType?.startsWith("video/") ? (
          <video controls autoPlay src={mediaAssetUrl(assetId)} />
        ) : (
          <img src={mediaAssetUrl(assetId)} alt="Archived media, full size" />
        )}
      </div>
    </div>
  );
}

// Display-only grouping: 4+ consecutive stored image/video items from the same
// sender within a tight window collapse into one grid entry. Captioned or
// unavailable media stays a normal bubble, and storage is untouched.
type ThreadEntry = { kind: "single"; message: MessageListItem } | { kind: "grid"; messages: MessageListItem[] };

const MEDIA_GRID_MIN_RUN = 4;
const MEDIA_GRID_WINDOW_MS = 3 * 60_000;

function isGridMedia(message: MessageListItem): boolean {
  const mime = message.media?.mimeType ?? "";
  return (
    message.media?.availability === "stored" &&
    message.media.assetId != null &&
    (mime.startsWith("image/") || mime.startsWith("video/")) &&
    message.messageType !== "sticker" &&
    !message.body &&
    !message.caption
  );
}

function sameGridRun(previous: MessageListItem, next: MessageListItem): boolean {
  return (
    previous.senderSourceJid === next.senderSourceJid &&
    previous.direction === next.direction &&
    Math.abs((next.timestampMs ?? 0) - (previous.timestampMs ?? 0)) <= MEDIA_GRID_WINDOW_MS
  );
}

function groupConsecutiveMedia(messages: MessageListItem[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let run: MessageListItem[] = [];
  const flush = () => {
    if (run.length >= MEDIA_GRID_MIN_RUN) {
      entries.push({ kind: "grid", messages: run });
    } else {
      for (const message of run) {
        entries.push({ kind: "single", message });
      }
    }
    run = [];
  };
  for (const message of messages) {
    if (!isGridMedia(message)) {
      flush();
      entries.push({ kind: "single", message });
      continue;
    }
    if (run.length > 0 && !sameGridRun(run[run.length - 1], message)) {
      flush();
    }
    run.push(message);
  }
  flush();
  return entries;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isSystemEvent(message: MessageListItem): boolean {
  return (
    message.direction === "system" ||
    message.messageType === "system" ||
    message.messageType === "status" ||
    message.messageType === "reaction" ||
    message.messageType === "encrypted_update"
  );
}

// The server owns interpretation (one source of truth for every consumer);
// the humanized fallback only covers DTOs from before the field existed.
function messagePlaceholder(message: MessageListItem): { label: string; reason: string | null } {
  return message.interpretation ?? { label: `${humanizeMessageType(message.messageType)} message`, reason: null };
}

function humanizeMessageType(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="emptyState">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="skeletonRow" key={index} />
      ))}
    </>
  );
}

function SkeletonMessages() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <div className="skeletonMessage" key={index} />
      ))}
    </>
  );
}

function chatDisplayLabel(chat: ChatListItem): string {
  if (chat.displayName) {
    return chat.displayName;
  }
  return chat.chatType === "group" ? "Unnamed group" : "Unresolved contact";
}

function isNearBottom(list: HTMLDivElement | null): boolean {
  if (!list) {
    return true;
  }
  return list.scrollHeight - list.scrollTop - list.clientHeight < 160;
}

function groupMessagesByDay(messages: MessageListItem[]) {
  const groups = new Map<string, MessageListItem[]>();
  for (const message of messages) {
    const day = message.sentAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(message.sentAt)) : "Undated";
    const items = groups.get(day) ?? [];
    items.push(message);
    groups.set(day, items);
  }
  return [...groups].map(([day, items]) => ({ day, items }));
}

function sortMessagesChronologically(messages: MessageListItem[]) {
  const unique = new Map<number, MessageListItem>();
  for (const message of messages) {
    unique.set(message.id, message);
  }
  return [...unique.values()].sort((a, b) => {
    const byTime = (a.timestampMs ?? 0) - (b.timestampMs ?? 0);
    return byTime || a.id - b.id;
  });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function msToIso(value: number | null | undefined): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "No time";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

// Date + time for the edit-history timeline, where distinguishing when each
// version became active (possibly across days) matters.
function formatDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}
