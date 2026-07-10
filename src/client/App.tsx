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
  StatusSummary
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
  searchArchive,
  startBrainRun,
  startMemoryRun,
  startImportJob,
  startSearchReindex,
  stopLiveSession,
  unlinkLiveSession,
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
  const [brainOverview, setBrainOverview] = useState<BrainOverview | null>(null);
  const [brainRun, setBrainRun] = useState<BrainRunProgress | null>(null);
  const [lightbox, setLightbox] = useState<{ assetId: number; mimeType: string | null } | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResults, setGlobalResults] = useState<SearchResultItem[]>([]);
  const [globalTotalMatches, setGlobalTotalMatches] = useState(0);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);
  const [searchIndex, setSearchIndex] = useState<SearchIndexStatus | null>(null);
  const [reindexProgress, setReindexProgress] = useState<SearchReindexProgress | null>(null);
  const [searchSender, setSearchSender] = useState("");
  const [searchType, setSearchType] = useState<"all" | SearchTypeFilter>("all");
  const [searchDirection, setSearchDirection] = useState<"all" | "incoming" | "outgoing">("all");
  const [searchAfter, setSearchAfter] = useState("");
  const [searchBefore, setSearchBefore] = useState("");
  // Search deep-link state: a thread window centered on a hit, with enough
  // bookkeeping to page older (offset side) and newer (toward the present).
  const [jumpContext, setJumpContext] = useState<{ anchorId: number; newerCount: number } | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const loadingMessagesRef = useRef(false);
  const scrollActionRef = useRef<"bottom" | "preserve" | "anchor" | null>(null);
  const previousScrollHeightRef = useRef(0);
  const pendingJumpRef = useRef<{ chatId: number; anchorId: number } | null>(null);
  const anchorScrollRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshStatus();
    void reattachActiveImport();
  }, []);

  useEffect(() => {
    void loadChats(true);
  }, [chatSearch, chatType, includeEventOnly]);

  useEffect(() => {
    if (selectedChat) {
      const jump = pendingJumpRef.current;
      if (jump && jump.chatId === selectedChat.id) {
        pendingJumpRef.current = null;
        setMessages([]);
        void loadMessagesAroundAnchor(selectedChat, jump.anchorId);
        return;
      }
      setJumpContext(null);
      anchorScrollRef.current = null;
      setMessageOffset(0);
      setMessageHasMore(false);
      setMessages([]);
      scrollActionRef.current = "bottom";
      void loadMessages(selectedChat, true);
    }
  }, [selectedChat?.id, messageQuery]);

  // Debounced global archive search; index state rides on every response so a
  // needs-rebuild archive shows the reindex call to action instead of results.
  useEffect(() => {
    const query = globalQuery.trim();
    if (!query) {
      setGlobalResults([]);
      setGlobalSearchError(null);
      setGlobalSearching(false);
      return;
    }
    let cancelled = false;
    setGlobalSearching(true);
    const timer = window.setTimeout(() => {
      searchArchive({
        query,
        sender: searchSender.trim() || null,
        type: searchType === "all" ? null : searchType,
        direction: searchDirection === "all" ? null : searchDirection,
        afterMs: searchAfter ? Date.parse(`${searchAfter}T00:00:00`) : null,
        beforeMs: searchBefore ? Date.parse(`${searchBefore}T23:59:59.999`) : null,
        limit: 50
      })
        .then((response) => {
          if (cancelled) return;
          // Defensive against server/client version skew mid-deploy: older
          // servers may answer without newer fields.
          setGlobalResults(response.results ?? []);
          setGlobalTotalMatches(response.totalMatches ?? response.results?.length ?? 0);
          setSearchIndex(response.index ?? null);
          setGlobalSearchError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setGlobalResults([]);
          setGlobalTotalMatches(0);
          setGlobalSearchError(err instanceof Error ? err.message : "Search failed.");
          getSearchStatus()
            .then((status) => {
              if (!cancelled) {
                setSearchIndex(status.index);
                setReindexProgress(status.reindex);
              }
            })
            .catch(() => undefined);
        })
        .finally(() => {
          if (!cancelled) setGlobalSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [globalQuery, searchSender, searchType, searchDirection, searchAfter, searchBefore, searchIndex?.state]);

  // Poll reindex progress while the job runs; completion flips the index state
  // which re-fires the search effect above.
  useEffect(() => {
    if (!reindexProgress || (reindexProgress.state !== "running" && reindexProgress.state !== "finalizing")) {
      return;
    }
    const timer = window.setInterval(() => {
      getSearchStatus()
        .then((status) => {
          setReindexProgress(status.reindex);
          setSearchIndex(status.index);
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [reindexProgress?.state]);

  // Poll brain-run progress while one executes; refresh coverage when done.
  useEffect(() => {
    if (brainRun?.state !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      getBrainRunProgress()
        .then((next) => {
          setBrainRun(next);
          if (next.state !== "running") {
            getBrainOverview().then(setBrainOverview).catch(() => undefined);
            if (next.state === "failed") {
              setError(`Brain run failed${next.error ? `: ${next.error}` : "."}`);
            } else if (next.state === "budget_exceeded") {
              setNotice("Brain run stopped at its model-call budget; remaining backlog stays pending.");
            } else if (next.state === "completed") {
              setNotice(`Brain run completed: ${next.episodesCommitted} episodes (${next.claimsCommitted} claims).`);
            }
          }
        })
        .catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [brainRun?.state]);

  // Failures are never silent: a failed index build raises the global error
  // toast no matter which panel the user is looking at.
  useEffect(() => {
    if (reindexProgress?.state === "failed") {
      setError(
        `Search index build failed${reindexProgress.error ? `: ${reindexProgress.error}` : "."} Retry from the search panel.`
      );
    }
  }, [reindexProgress?.state]);

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
        // user is already at the bottom; never move them while reading history
        // (including a search-jump window, which is history by definition).
        if (currentSelectedChat && selectedChatChanged && !jumpContext && isNearBottom(messageListRef.current)) {
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
  }, [selectedChat?.sourceChatId, messageQuery, chatSearch, chatType, includeEventOnly, jumpContext]);

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
    } else if (action === "anchor") {
      const anchorId = anchorScrollRef.current;
      const target = anchorId != null ? list.querySelector(`[data-mid="${anchorId}"]`) : null;
      if (target) {
        (target as HTMLElement).scrollIntoView({ block: "center" });
      } else {
        list.scrollTop = list.scrollHeight / 2;
      }
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
      // Discover index/job state independently of the search panel, so a
      // build started earlier (or before a page reload) stays visible.
      getSearchStatus()
        .then((search) => {
          setSearchIndex(search.index);
          setReindexProgress(search.reindex);
        })
        .catch(() => undefined);
      getBrainOverview()
        .then(setBrainOverview)
        .catch(() => undefined);
      getBrainRunProgress()
        .then(setBrainRun)
        .catch(() => undefined);
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
    if (!selectedChat || loadingMessagesRef.current) {
      return;
    }
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    if (messageHasMore && list.scrollTop < 96) {
      void loadMessages(selectedChat, false);
      return;
    }
    // In a search-jump window, scrolling down pages toward the present.
    if (jumpContext && jumpContext.newerCount > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 96) {
      void loadNewerMessages();
    }
  }

  // Open a thread window centered on a message (search deep link).
  async function loadMessagesAroundAnchor(chat: ChatListItem, anchorId: number) {
    if (loadingMessagesRef.current) {
      return;
    }
    loadingMessagesRef.current = true;
    setLoadingMessages(true);
    try {
      const window = await getMessageContext(chat.id, anchorId, 75);
      setMessages(sortMessagesChronologically(window.messages));
      // Older-side paging continues from below the window: the newest-first
      // offset equals everything newer than the window plus the window itself.
      setMessageOffset(window.newerCount + window.messages.length);
      setMessageHasMore(true);
      setJumpContext({ anchorId, newerCount: window.newerCount });
      anchorScrollRef.current = anchorId;
      scrollActionRef.current = "anchor";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the message in its chat.");
    } finally {
      loadingMessagesRef.current = false;
      setLoadingMessages(false);
    }
  }

  async function loadNewerMessages() {
    if (!selectedChat || !jumpContext || jumpContext.newerCount <= 0 || loadingMessagesRef.current) {
      return;
    }
    loadingMessagesRef.current = true;
    setLoadingMessages(true);
    try {
      const pageSize = Math.min(MESSAGE_LIMIT, jumpContext.newerCount);
      const offset = jumpContext.newerCount - pageSize;
      const next = await listMessages(selectedChat.id, { limit: pageSize, offset, order: "desc" });
      setMessages((current) => sortMessagesChronologically([...current, ...next]));
      setJumpContext((current) => (current ? { ...current, newerCount: Math.max(0, current.newerCount - pageSize) } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load newer messages.");
    } finally {
      loadingMessagesRef.current = false;
      setLoadingMessages(false);
    }
  }

  function exitJumpContext() {
    if (!selectedChat) {
      return;
    }
    setJumpContext(null);
    anchorScrollRef.current = null;
    setMessageOffset(0);
    setMessageHasMore(false);
    scrollActionRef.current = "bottom";
    void loadMessages(selectedChat, true);
  }

  function openSearchHit(hit: SearchResultItem) {
    const chat: ChatListItem = chats.find((candidate) => candidate.id === hit.chatId) ?? {
      id: hit.chatId,
      sourceChatId: hit.chatSourceId,
      jid: hit.chatSourceId,
      displayName: hit.chatDisplayName,
      chatType: hit.chatType,
      messageCount: 0,
      participantCount: 0,
      lastMessageAt: null
    };
    if (selectedChat?.id === hit.chatId) {
      void loadMessagesAroundAnchor(chat, hit.messageId);
    } else {
      pendingJumpRef.current = { chatId: hit.chatId, anchorId: hit.messageId };
      setSelectedChat(chat);
    }
  }

  async function handleStartReindex() {
    try {
      const response = await startSearchReindex();
      setReindexProgress(response.reindex);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the search reindex.");
    }
  }

  async function handleStartBrainRun(body: { mode: "model" | "extractive"; model?: string | null }) {
    setError(null);
    try {
      const response = await startBrainRun({ ...body, maxChats: 10 });
      setBrainRun(response.progress);
      setNotice("Brain run started — progress shows below and in the Brain panel.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the brain run.");
    }
  }

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
          <BrainPanel
            overview={brainOverview}
            run={brainRun}
            busy={busy}
            onProviderAction={(body) => void handleBrainProviderAction(body)}
            onRun={(body) => void handleStartBrainRun(body)}
          />

          <ImportLauncher status={status} onOpen={() => setImportWizardOpen(true)} />

          <div className="filterPanel globalSearchPanel">
            <div className="searchBox">
              <Search size={16} />
              <input
                value={globalQuery}
                onChange={(event) => setGlobalQuery(event.target.value)}
                placeholder="Search all messages"
              />
              {globalQuery && (
                <button className="clearSearchButton" onClick={() => setGlobalQuery("")} type="button" aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {globalQuery.trim() ? (
            <GlobalSearchResults
              results={globalResults}
              totalMatches={globalTotalMatches}
              searching={globalSearching}
              error={globalSearchError}
              index={searchIndex}
              reindex={reindexProgress}
              sender={searchSender}
              type={searchType}
              direction={searchDirection}
              after={searchAfter}
              before={searchBefore}
              onSenderChange={setSearchSender}
              onTypeChange={setSearchType}
              onDirectionChange={setSearchDirection}
              onAfterChange={setSearchAfter}
              onBeforeChange={setSearchBefore}
              onOpen={openSearchHit}
              onReindex={() => void handleStartReindex()}
            />
          ) : (
            <>
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
            </>
          )}
        </aside>

        <section className="messagePane">
          {(notice || error) && (
            <div className={`toastLine ${error ? "error" : "notice"}`}>
              {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              <span>{error ?? notice}</span>
            </div>
          )}
          {reindexProgress && (reindexProgress.state === "running" || reindexProgress.state === "finalizing") && (
            <div className="toastLine notice">
              <Loader2 className="spin" size={16} />
              <span>
                Building search index —{" "}
                {reindexProgress.totalMessages > 0
                  ? `${reindexProgress.processedMessages.toLocaleString()} / ${reindexProgress.totalMessages.toLocaleString()} messages`
                  : "preparing…"}
              </span>
            </div>
          )}

          {selectedChat ? (
            <>
              <div className="threadHeader">
                <div>
                  <h2>{chatDisplayLabel(selectedChat)}</h2>
                  <p>
                    {selectedChat.chatType}
                    {/* Search-hit stubs carry messageCount 0 (unknown); showing "0 messages" over a full thread is a lie. */}
                    {selectedChat.messageCount ? ` | ${selectedChat.messageCount.toLocaleString()} messages` : ""}
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
                          highlighted={jumpContext?.anchorId === entry.message.id}
                        />
                      )
                    )}
                  </div>
                ))}
                {loadingMessages && messages.length === 0 && <SkeletonMessages />}
                {!loadingMessages && messages.length === 0 && <EmptyState icon={<MessageCircle size={22} />} text="No messages loaded" />}
                {messages.length > 0 && (
                  <div className="messageWindowNote">
                    {jumpContext
                      ? "Showing a window around the selected search result. Scroll down for newer messages."
                      : `Showing ${messages.length.toLocaleString()} newest matching messages in chronological order.`}
                  </div>
                )}
              </div>
              {jumpContext && (
                <button className="jumpLatestButton" type="button" onClick={exitJumpContext}>
                  <ChevronDown size={14} />
                  <span>Latest messages</span>
                </button>
              )}
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

// The brain's operator panel: coverage truth, run-due alert, and full provider
// control (opt-in, model choice, probe) — manual-first, everything from the UI.
function BrainPanel({
  overview,
  run,
  busy,
  onProviderAction,
  onRun
}: {
  overview: BrainOverview | null;
  run: BrainRunProgress | null;
  busy: string | null;
  onProviderAction: (body: {
    action: "enable" | "disable" | "probe" | "set-model";
    provider?: Exclude<BrainProviderName, "extractive">;
    model?: string;
  }) => void;
  onRun: (body: { mode: "model" | "extractive"; model?: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const provider = overview?.provider;
  const runDue = Boolean(overview?.scheduler.runDue);
  const running = run?.state === "running";
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
          </div>
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
          <div className="brainProviderControls">
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
                <span>Model</span>
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
            <button
              className="primaryButton"
              type="button"
              disabled={Boolean(busy) || running || !overview || overview.chatsWithBacklog === 0}
              onClick={() =>
                onRun(
                  provider && provider.provider !== "extractive"
                    ? { mode: "model", model: provider.model }
                    : { mode: "extractive" }
                )
              }
              title={
                provider && provider.provider !== "extractive"
                  ? `Assimilate the top backlog chats with ${provider.provider}/${provider.model}`
                  : "Assimilate with extractive placeholders (no model calls; regenerable later)"
              }
            >
              {running ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              Run
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
  const pickerAvailable = Boolean(status?.pickerAvailable);
  const [step, setStep] = useState<"folder" | "key" | "mode" | "import">(initialJob ? "import" : "folder");
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

// WhatsApp-style media sizing: pin the bubble to the media's display width (the
// image/video aspect-fit within caps) so the media fills it and the caption
// wraps to that width, instead of a long caption stretching the bubble and
// stranding the media in a corner.
const MEDIA_MIN_W = 220;
const MEDIA_MAX_W = 360;
const MEDIA_MAX_H = 400;
const BUBBLE_H_CHROME = 20; // 2×9px padding + 2×1px border (border-box)

function mediaDisplayWidth(media: MessageListItem["media"], messageType: string): number | null {
  if (!media || media.availability !== "stored" || messageType === "sticker") return null;
  const mime = media.mimeType ?? "";
  if (mime === "image/webp" || !(mime.startsWith("image/") || mime.startsWith("video/"))) return null;
  let w = media.width ?? 0;
  let h = media.height ?? 0;
  if (!w || !h) return MEDIA_MAX_W;
  if (w > MEDIA_MAX_W) {
    h = (h * MEDIA_MAX_W) / w;
    w = MEDIA_MAX_W;
  }
  if (h > MEDIA_MAX_H) {
    w = (w * MEDIA_MAX_H) / h;
  }
  return Math.round(Math.min(MEDIA_MAX_W, Math.max(MEDIA_MIN_W, w)));
}

function MessageBubble({
  message,
  isGroup,
  onOpenMedia,
  highlighted
}: {
  message: MessageListItem;
  isGroup: boolean;
  onOpenMedia: OnOpenMedia;
  highlighted?: boolean;
}) {
  const text = message.body || message.caption;
  const placeholder = messagePlaceholder(message);
  const mediaWidth = mediaDisplayWidth(message.media, message.messageType);
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasHistory = message.editRevisionCount > 0;

  if (isSystemEvent(message)) {
    return (
      <article className={`systemChip ${highlighted ? "jumpHighlight" : ""}`} data-mid={message.id}>
        <span>{text ? renderInlineText(text, message.mentions) : placeholder.label}</span>
        <time>{formatTime(message.sentAt)}</time>
      </article>
    );
  }
  return (
    <article
      className={`messageBubble ${message.direction} ${message.isDeleted ? "deleted" : ""} ${highlighted ? "jumpHighlight" : ""}`}
      data-mid={message.id}
      style={mediaWidth ? { width: `${mediaWidth + BUBBLE_H_CHROME}px` } : undefined}
    >
      <div className="messageMeta">
        {isGroup && message.direction !== "outgoing" && <span className="metaName">{message.senderDisplayName ?? "Unresolved contact"}</span>}
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
    return <VideoBubble assetId={assetId} media={media} />;
  }
  if (mime.startsWith("audio/")) {
    return <AudioBubble assetId={assetId} media={media} />;
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

// A static waveform baseline for the audio player; the played portion fills.
const AUDIO_WAVE = [
  26, 40, 58, 34, 72, 90, 50, 64, 82, 44, 30, 54, 76, 96, 60, 38, 68, 88, 46, 32,
  70, 52, 84, 42, 28, 60, 80, 50, 66, 92, 48, 36, 74, 56, 86, 44, 30, 62, 78, 52,
  68, 94, 46, 34, 72, 54, 82, 40, 26, 58, 76, 50, 64, 88, 44, 32, 70, 48, 60, 36
];

// Shared inline playback state for the custom players: one media element driven
// by our own controls, so the modern UI never swaps to the browser's player.
function useInlinePlayer(mediaRef: RefObject<HTMLMediaElement | null>) {
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [elementDurationMs, setElementDurationMs] = useState(0);
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onTime = () => setCurrentMs(el.currentTime * 1000);
    const onDuration = () => setElementDurationMs(Number.isFinite(el.duration) ? el.duration * 1000 : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      el.currentTime = 0;
      setCurrentMs(0);
      setPlaying(false);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onDuration);
    el.addEventListener("durationchange", onDuration);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onDuration);
      el.removeEventListener("durationchange", onDuration);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [mediaRef]);
  const toggle = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };
  const seekToFraction = (fraction: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const seconds = Number.isFinite(el.duration) ? el.duration : elementDurationMs / 1000;
    if (seconds > 0) {
      el.currentTime = Math.max(0, Math.min(1, fraction)) * seconds;
    }
  };
  return { playing, currentMs, elementDurationMs, toggle, seekToFraction };
}

function seekFractionFromEvent(event: ReactMouseEvent<HTMLElement>): number {
  const rect = event.currentTarget.getBoundingClientRect();
  return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
}

// Custom audio player: the waveform fills with playback progress and is
// click-to-seek; the UI stays identical whether stopped or playing.
function AudioBubble({ assetId, media }: { assetId: number; media: NonNullable<MessageListItem["media"]> }) {
  const ref = useRef<HTMLAudioElement>(null);
  const { playing, currentMs, elementDurationMs, toggle, seekToFraction } = useInlinePlayer(ref);
  const totalMs = elementDurationMs || media.durationMs || 0;
  const fraction = totalMs > 0 ? Math.min(1, currentMs / totalMs) : 0;
  return (
    <div className="audioBubble">
      {media.isViewOnce && <span className="viewOnceBadge audioViewOnce">view once</span>}
      <audio ref={ref} preload="none" src={mediaAssetUrl(assetId)} />
      <button className="audioPlayButton" type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
      <span className="audioWave" onClick={(event) => seekToFraction(seekFractionFromEvent(event))}>
        <span className="audioWaveRow audioWaveBase">
          {AUDIO_WAVE.map((height, index) => (
            <span key={index} style={{ height: `${height}%` }} />
          ))}
        </span>
        <span className="audioWaveRow audioWaveFill" style={{ clipPath: `inset(0 ${(1 - fraction) * 100}% 0 0)` }}>
          {AUDIO_WAVE.map((height, index) => (
            <span key={index} style={{ height: `${height}%` }} />
          ))}
        </span>
      </span>
      <span className="audioDuration">{formatDuration(currentMs > 0 ? currentMs : totalMs)}</span>
    </div>
  );
}

// Custom video player: poster + centered play at the start, then inline
// playback with our own bottom controls (a filling, seekable progress bar) —
// never the native player, and a constant width.
function VideoBubble({ assetId, media }: { assetId: number; media: NonNullable<MessageListItem["media"]> }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { playing, currentMs, elementDurationMs, toggle, seekToFraction } = useInlinePlayer(ref);
  const totalMs = elementDurationMs || media.durationMs || 0;
  const fraction = totalMs > 0 ? Math.min(1, currentMs / totalMs) : 0;
  const atStart = currentMs === 0 && !playing;
  const aspectRatio = media.width && media.height ? `${media.width} / ${media.height}` : "4 / 3";
  return (
    <div className="videoPlayer" style={{ aspectRatio }}>
      <video
        ref={ref}
        className="videoEl"
        preload="none"
        playsInline
        poster={media.hasThumbnail ? mediaThumbnailUrl(assetId) : undefined}
        src={mediaAssetUrl(assetId)}
        onClick={toggle}
      />
      {atStart && !media.hasThumbnail && <span className="videoPosterFallback" />}
      <span className="videoScrim" />
      {atStart ? (
        <>
          <button className="videoCenterPlay" type="button" onClick={toggle} aria-label="Play video">
            <Play size={24} fill="currentColor" />
          </button>
          {media.durationMs ? <span className="videoDurationPill">{formatDuration(media.durationMs)}</span> : null}
        </>
      ) : (
        <div className="videoControls">
          <button className="videoCtlBtn" type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
          </button>
          <span className="videoProgress" onClick={(event) => seekToFraction(seekFractionFromEvent(event))}>
            <span className="videoProgressFill" style={{ width: `${fraction * 100}%` }} />
          </span>
          <span className="videoTime">
            {formatDuration(currentMs)} / {formatDuration(totalMs)}
          </span>
        </div>
      )}
      {media.isViewOnce && <span className="viewOnceBadge">view once</span>}
    </div>
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
