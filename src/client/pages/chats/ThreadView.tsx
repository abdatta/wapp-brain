import { ChevronDown, Loader2, MessageCircle, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ArchiveChangeEvent, ChatListItem, MessageListItem } from "../../../shared/types";
import { getMessageContext, listMessages } from "../../api";
import { buildChatDeepLink, parseAnchorParam } from "../../lib/deepLinks";
import { useArchiveEvents } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";
import { MuteControl } from "./MuteControl";
import {
  EmptyState,
  MediaGridBubble,
  MediaLightbox,
  MessageBubble,
  SkeletonMessages,
  chatDisplayLabel,
  groupConsecutiveMedia,
  groupMessagesByDay,
  isNearBottom,
  sortMessagesChronologically
} from "../../thread";

const MESSAGE_LIMIT = 150;

// The thread pane for `/chats/:id`. The URL is the source of truth for the
// centered anchor (`?at=<messageId>`): with an anchor it loads a window around
// that message; without one it opens at the newest messages. Scroll anchoring,
// upward auto-load, and SSE-follow are ported verbatim from the monolith.
export function ThreadView({ chat }: { chat: ChatListItem }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const anchorId = parseAnchorParam(searchParams);
  const { setError } = useToast();

  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [messageOffset, setMessageOffset] = useState(0);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [messageQuery, setMessageQuery] = useState("");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [jumpContext, setJumpContext] = useState<{ anchorId: number; newerCount: number } | null>(null);
  const [lightbox, setLightbox] = useState<{ assetId: number; mimeType: string | null } | null>(null);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const loadingMessagesRef = useRef(false);
  const previousScrollHeightRef = useRef(0);
  const scrollActionRef = useRef<"bottom" | "preserve" | "anchor" | null>(null);
  const anchorScrollRef = useRef<number | null>(null);

  async function loadMessages(target: ChatListItem, reset = false) {
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
      const next = await listMessages(target.id, { limit: MESSAGE_LIMIT, offset, query: messageQuery, order: "desc" });
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

  // Open a thread window centered on a message (search deep link).
  async function loadMessagesAroundAnchor(target: ChatListItem, anchor: number) {
    if (loadingMessagesRef.current) {
      return;
    }
    loadingMessagesRef.current = true;
    setLoadingMessages(true);
    try {
      const window = await getMessageContext(target.id, anchor, 75);
      setMessages(sortMessagesChronologically(window.messages));
      // Older-side paging continues from below the window: the newest-first
      // offset equals everything newer than the window plus the window itself.
      setMessageOffset(window.newerCount + window.messages.length);
      setMessageHasMore(true);
      setJumpContext({ anchorId: anchor, newerCount: window.newerCount });
      anchorScrollRef.current = anchor;
      scrollActionRef.current = "anchor";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the message in its chat.");
    } finally {
      loadingMessagesRef.current = false;
      setLoadingMessages(false);
    }
  }

  async function loadNewerMessages() {
    if (!jumpContext || jumpContext.newerCount <= 0 || loadingMessagesRef.current) {
      return;
    }
    loadingMessagesRef.current = true;
    setLoadingMessages(true);
    try {
      const pageSize = Math.min(MESSAGE_LIMIT, jumpContext.newerCount);
      const offset = jumpContext.newerCount - pageSize;
      const next = await listMessages(chat.id, { limit: pageSize, offset, order: "desc" });
      setMessages((current) => sortMessagesChronologically([...current, ...next]));
      setJumpContext((current) => (current ? { ...current, newerCount: Math.max(0, current.newerCount - pageSize) } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load newer messages.");
    } finally {
      loadingMessagesRef.current = false;
      setLoadingMessages(false);
    }
  }

  function handleMessageScroll() {
    if (loadingMessagesRef.current) {
      return;
    }
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    if (messageHasMore && list.scrollTop < 96) {
      void loadMessages(chat, false);
      return;
    }
    // In a search-jump window, scrolling down pages toward the present.
    if (jumpContext && jumpContext.newerCount > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 96) {
      void loadNewerMessages();
    }
  }

  // The URL drives what loads: an anchor opens a centered window; no anchor (or a
  // changed message-search query) resets to the newest messages.
  useEffect(() => {
    setMessages([]);
    if (anchorId != null) {
      void loadMessagesAroundAnchor(chat, anchorId);
    } else {
      setJumpContext(null);
      anchorScrollRef.current = null;
      setMessageOffset(0);
      setMessageHasMore(false);
      scrollActionRef.current = "bottom";
      void loadMessages(chat, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, anchorId, messageQuery]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    const action = scrollActionRef.current;
    if (!list || !action) {
      return;
    }
    if (messages.length === 0) {
      // Chat switches render an intermediate empty list; keep the pending scroll
      // intent alive until real content exists to scroll to.
      return;
    }
    if (action === "bottom") {
      list.scrollTop = list.scrollHeight;
    } else if (action === "anchor") {
      const anchor = anchorScrollRef.current;
      const targetEl = anchor != null ? list.querySelector(`[data-mid="${anchor}"]`) : null;
      if (targetEl) {
        (targetEl as HTMLElement).scrollIntoView({ block: "center" });
      } else {
        list.scrollTop = list.scrollHeight / 2;
      }
    } else {
      const heightDelta = list.scrollHeight - previousScrollHeightRef.current;
      list.scrollTop += heightDelta;
    }
    scrollActionRef.current = null;
  }, [messages]);

  // WhatsApp behavior: live updates follow the conversation only when the user is
  // already at the bottom; never move them while reading history (a search-jump
  // window is history by definition).
  const onArchive = useCallback(
    (change: ArchiveChangeEvent) => {
      const affects =
        change.chatSourceIds.length === 0 || (chat.sourceChatId ? change.chatSourceIds.includes(chat.sourceChatId) : false);
      if (affects && !jumpContext && isNearBottom(messageListRef.current)) {
        setMessageOffset(0);
        setMessageHasMore(false);
        scrollActionRef.current = "bottom";
        void loadMessages(chat, true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.id, chat.sourceChatId, jumpContext, messageQuery]
  );
  useArchiveEvents(onArchive);

  const groupedMessages = useMemo(() => groupMessagesByDay(messages), [messages]);

  return (
    <>
      <div className="threadHeader">
        <div>
          <h2>{chatDisplayLabel(chat)}</h2>
          <p>
            {chat.chatType}
            {/* Search-hit stubs carry messageCount 0 (unknown); showing "0 messages" over a full thread is a lie. */}
            {chat.messageCount ? ` | ${chat.messageCount.toLocaleString()} messages` : ""}
            {chat.participantCount ? ` | ${chat.participantCount.toLocaleString()} participants` : ""}
            {chat.sourceChatId && (
              <>
                {" | "}
                <Link className="linkButton" to={`/graph?chat=${encodeURIComponent(chat.sourceChatId)}`} title="See this conversation's people and topics in the graph">
                  view in graph
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="threadHeaderActions">
          <MuteControl chat={chat} />
          <div className="threadSearch">
            <Search size={16} />
            <input value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} placeholder="Search messages" />
          </div>
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
                  isGroup={chat.chatType === "group"}
                  onOpenMedia={(assetId, mimeType) => setLightbox({ assetId, mimeType })}
                />
              ) : (
                <MessageBubble
                  key={entry.message.id}
                  message={entry.message}
                  isGroup={chat.chatType === "group"}
                  onOpenMedia={(assetId, mimeType) => setLightbox({ assetId, mimeType })}
                  highlighted={jumpContext?.anchorId === entry.message.id}
                  onJumpToMessage={(messageId) => navigate(buildChatDeepLink(chat.id, messageId))}
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
        <button className="jumpLatestButton" type="button" onClick={() => navigate(buildChatDeepLink(chat.id))}>
          <ChevronDown size={14} />
          <span>Latest messages</span>
        </button>
      )}
      {lightbox && <MediaLightbox assetId={lightbox.assetId} mimeType={lightbox.mimeType} onClose={() => setLightbox(null)} />}
    </>
  );
}
