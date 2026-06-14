import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Eye,
  FileKey2,
  HardDrive,
  Loader2,
  MessageCircle,
  Moon,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload
} from "lucide-react";
import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatListItem, ImportRequest, MessageListItem, StatusSummary } from "../shared/types";
import { cleanupTempFiles, getStatus, initDatabase, listChats, listMessages, runImport } from "./api";

const CHAT_LIMIT = 60;
const MESSAGE_LIMIT = 150;

export function App() {
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
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
  const [importPanelOpen, setImportPanelOpen] = useState(true);
  const [importPanelTouched, setImportPanelTouched] = useState(false);
  const [form, setForm] = useState<ImportRequest>({
    msgstorePath: "",
    waPath: "",
    mediaPath: "",
    key: "",
    keyPath: "",
    keepDecrypted: false
  });
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const loadingMessagesRef = useRef(false);
  const scrollActionRef = useRef<"bottom" | "preserve" | null>(null);
  const previousScrollHeightRef = useRef(0);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    void loadChats(true);
  }, [chatSearch, chatType, includeEventOnly]);

  useEffect(() => {
    if (status && !importPanelTouched) {
      setImportPanelOpen(!hasArchiveData(status));
    }
  }, [status, importPanelTouched]);

  useEffect(() => {
    if (selectedChat) {
      setMessageOffset(0);
      setMessageHasMore(false);
      setMessages([]);
      scrollActionRef.current = "bottom";
      void loadMessages(selectedChat, true);
    }
  }, [selectedChat?.id, messageQuery]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    const action = scrollActionRef.current;
    if (!list || !action) {
      return;
    }
    if (action === "bottom") {
      list.scrollTop = list.scrollHeight;
    } else {
      const heightDelta = list.scrollHeight - previousScrollHeightRef.current;
      list.scrollTop += heightDelta;
    }
    scrollActionRef.current = null;
  }, [messages.length]);

  async function refreshStatus() {
    try {
      setStatusError(null);
      const next = await getStatus();
      setStatus(next);
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
      if (reset && selectedChat && !next.some((chat) => chat.id === selectedChat.id)) {
        setSelectedChat(null);
        setMessages([]);
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

  async function handleImport(event: FormEvent) {
    event.preventDefault();
    setBusy("Importing archive");
    setError(null);
    setNotice(null);
    try {
      const result = await runImport({
        msgstorePath: form.msgstorePath,
        waPath: form.waPath || null,
        mediaPath: form.mediaPath || null,
        key: form.key || null,
        keyPath: form.keyPath || null,
        keepDecrypted: form.keepDecrypted
      });
      setForm((current) => ({ ...current, key: "" }));
      setImportPanelOpen(false);
      setImportPanelTouched(true);
      setNotice(`Import complete: ${result.totals.messages.toLocaleString()} messages.`);
      await refreshStatus();
      await loadChats(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
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
          <StatusPanel
            status={status}
            statusError={statusError}
            busy={busy}
            onInit={() => void handleInit()}
            onCleanup={() => void handleCleanup()}
          />

          <form className={`importPanel ${importPanelOpen ? "" : "collapsed"}`} onSubmit={(event) => void handleImport(event)}>
            <button
              className="panelToggle"
              type="button"
              aria-expanded={importPanelOpen}
              onClick={() => {
                setImportPanelTouched(true);
                setImportPanelOpen((current) => !current);
              }}
            >
              <span className="panelTitle">
                <Upload size={16} />
                <span>{hasArchiveData(status) ? "Import / re-import" : "Import"}</span>
              </span>
              {importPanelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {importPanelOpen && (
              <>
                <label>
                  <span>msgstore</span>
                  <input
                    value={form.msgstorePath}
                    onChange={(event) => setForm((current) => ({ ...current, msgstorePath: event.target.value }))}
                    placeholder="C:\\path\\msgstore.db.crypt15"
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>wa.db</span>
                  <input
                    value={form.waPath ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, waPath: event.target.value }))}
                    placeholder="C:\\path\\wa.db"
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>media</span>
                  <input
                    value={form.mediaPath ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, mediaPath: event.target.value }))}
                    placeholder="C:\\path\\WhatsApp\\Media"
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>key</span>
                  <input
                    value={form.key ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
                    placeholder="64-character key"
                    type="password"
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>key file</span>
                  <input
                    value={form.keyPath ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, keyPath: event.target.value }))}
                    placeholder="C:\\path\\encrypted_backup.key"
                    autoComplete="off"
                  />
                </label>
                <div className="importFooter">
                  <label className="checkRow">
                    <input
                      type="checkbox"
                      checked={Boolean(form.keepDecrypted)}
                      onChange={(event) => setForm((current) => ({ ...current, keepDecrypted: event.target.checked }))}
                    />
                    <span>Keep decrypted DB</span>
                  </label>
                  <button className="primaryButton" type="submit" disabled={Boolean(busy) || !form.msgstorePath}>
                    {busy === "Importing archive" ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    Import
                  </button>
                </div>
              </>
            )}
          </form>

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
                <span className="chatName">{chat.displayName}</span>
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
                  <h2>{selectedChat.displayName}</h2>
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
                    {group.items.map((message) => (
                      <MessageBubble key={message.id} message={message} isGroup={selectedChat.chatType === "group"} />
                    ))}
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

function MessageBubble({ message, isGroup }: { message: MessageListItem; isGroup: boolean }) {
  const text = message.body || message.caption;
  const placeholder = messagePlaceholder(message);
  if (isSystemEvent(message)) {
    return (
      <article className="systemChip">
        <span>{text || placeholder}</span>
        <time>{formatTime(message.sentAt)}</time>
      </article>
    );
  }
  return (
    <article className={`messageBubble ${message.direction}`}>
      <div className="messageMeta">
        {isGroup && message.direction !== "outgoing" && <span>{message.senderDisplayName ?? "Unknown sender"}</span>}
        <time>{formatTime(message.sentAt)}</time>
      </div>
      {text ? (
        <p>{text}</p>
      ) : (
        <p className="placeholderText">{placeholder}</p>
      )}
      {(message.hasMedia || message.isForwarded || message.isStarred) && (
        <div className="messageFlags">
          {message.hasMedia && <span>{message.mediaMimeType ?? message.messageType}</span>}
          {message.isForwarded && <span>forwarded</span>}
          {message.isStarred && <span>starred</span>}
        </div>
      )}
    </article>
  );
}

function isSystemEvent(message: MessageListItem): boolean {
  return message.direction === "system" || message.messageType === "system" || message.messageType === "status";
}

function messagePlaceholder(message: MessageListItem): string {
  if (message.isDeleted) return "Deleted message";
  if (message.messageType === "call") return "Call";
  if (message.messageType === "system") return "System event";
  if (message.messageType === "status") return "Status event";
  if (message.hasMedia) return `${humanizeMessageType(message.messageType)} message`;
  if (message.messageType.startsWith("unknown")) return "Unsupported message";
  return `${humanizeMessageType(message.messageType)} message`;
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

function formatTime(value: string | null | undefined): string {
  if (!value) return "No time";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
