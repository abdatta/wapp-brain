import { HardDrive } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { ChatListItem } from "../../../shared/types";
import { MUTE_CHANGED_EVENT, getChatById, listChats } from "../../api";
import { useArchiveEvents, useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";
import { ChatList } from "./ChatList";
import { ThreadView } from "./ThreadView";

const CHAT_LIMIT = 60;

// The chats surface (`/chats` and `/chats/:id`). Owns the chat list + filters
// (page-local) and derives the open chat from the URL param. The thread pane is
// keyed on the chat id so switching chats fully remounts its message state.
export function ChatsPage() {
  const { id } = useParams();
  const location = useLocation();
  const chatId = id ? Number(id) : null;
  const { status } = useStatus();
  const { setError } = useToast();

  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [chatOffset, setChatOffset] = useState(0);
  const [chatSearch, setChatSearch] = useState("");
  const [chatType, setChatType] = useState("all");
  const [includeEventOnly, setIncludeEventOnly] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  // The muted fold: the list shows either live chats or muted ones, never both,
  // so the pane stays one list the way WhatsApp's archive does.
  const [showMuted, setShowMuted] = useState(false);
  const [mutedCount, setMutedCount] = useState(0);

  const loadChats = useCallback(
    async (reset: boolean, offsetOverride?: number) => {
      setLoadingChats(true);
      try {
        const offset = reset ? 0 : offsetOverride ?? 0;
        const next = await listChats({
          search: chatSearch,
          type: chatType,
          includeEventOnly,
          // Undefined means "no filter": the default list is unfiltered rather
          // than explicitly unmuted, so nothing changes for a user who never
          // mutes anything.
          muted: showMuted ? true : undefined,
          limit: CHAT_LIMIT,
          offset
        });
        setChats((current) => (reset ? next : [...current, ...next]));
        setChatOffset(offset + next.length);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load chats.");
      } finally {
        setLoadingChats(false);
      }
    },
    [chatSearch, chatType, includeEventOnly, showMuted, setError]
  );

  // The fold row's count is "muted chats you could actually read" — the same
  // visible-exchange rule the list itself uses, so it never promises rows that
  // are not there.
  const refreshMutedCount = useCallback(async () => {
    try {
      setMutedCount((await listChats({ muted: true, limit: 200, offset: 0 })).length);
    } catch {
      // A count is an affordance, not data; a failure just hides the row.
      setMutedCount(0);
    }
  }, []);

  useEffect(() => {
    void loadChats(true);
  }, [loadChats]);

  useEffect(() => {
    void refreshMutedCount();
  }, [refreshMutedCount]);

  // Muting from a thread header must move the fold row's count immediately —
  // the archive-changed event only fires once the vault has caught up.
  useEffect(() => {
    const onMuteChanged = () => {
      void refreshMutedCount();
      void loadChats(true);
    };
    window.addEventListener(MUTE_CHANGED_EVENT, onMuteChanged);
    return () => window.removeEventListener(MUTE_CHANGED_EVENT, onMuteChanged);
  }, [refreshMutedCount, loadChats]);

  // Live archive changes refresh the list (throttled by the status provider).
  const onArchive = useCallback(() => {
    void loadChats(true);
    void refreshMutedCount();
  }, [loadChats, refreshMutedCount]);
  useArchiveEvents(onArchive);

  // Resolve the open chat: prefer the loaded list, then rich router state from a
  // search hit, then a direct fetch. The direct fetch matters because the list
  // is filtered — leaving the muted fold, narrowing the search, or deep-linking
  // cold all leave the open chat outside it, and the old stub fallback rendered
  // those as "Unresolved contact".
  const stateChat = (location.state as { chat?: ChatListItem } | null)?.chat ?? null;
  const [fetchedChat, setFetchedChat] = useState<ChatListItem | null>(null);

  const selectedChat = useMemo<ChatListItem | null>(() => {
    if (chatId == null || Number.isNaN(chatId)) {
      return null;
    }
    const found = chats.find((candidate) => candidate.id === chatId);
    if (found) {
      return found;
    }
    if (stateChat && stateChat.id === chatId) {
      return stateChat;
    }
    if (fetchedChat && fetchedChat.id === chatId) {
      return fetchedChat;
    }
    // Nothing resolved yet — the thread still loads by id while the fetch lands.
    return {
      id: chatId,
      sourceChatId: "",
      jid: "",
      displayName: null,
      chatType: "dm",
      messageCount: 0,
      participantCount: 0,
      lastMessageAt: null
    };
  }, [chatId, chats, stateChat, fetchedChat]);

  useEffect(() => {
    if (chatId == null || Number.isNaN(chatId)) {
      return;
    }
    if (chats.some((candidate) => candidate.id === chatId) || stateChat?.id === chatId || fetchedChat?.id === chatId) {
      return;
    }
    let cancelled = false;
    void getChatById(chatId)
      .then((chat) => {
        if (!cancelled && chat) setFetchedChat(chat);
      })
      .catch(() => {
        // The thread still renders by id; only the header stays unresolved.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, chats, stateChat, fetchedChat]);

  return (
    <div className="workspace chatsWorkspace">
      <ChatList
        chats={chats}
        chatSearch={chatSearch}
        chatType={chatType}
        includeEventOnly={includeEventOnly}
        showMuted={showMuted}
        mutedCount={mutedCount}
        loadingChats={loadingChats}
        selectedId={selectedChat?.id ?? null}
        onSearchChange={setChatSearch}
        onTypeChange={setChatType}
        onIncludeEventOnlyChange={(value) => {
          setIncludeEventOnly(value);
          setChatOffset(0);
        }}
        onShowMutedChange={(value) => {
          setShowMuted(value);
          setChatOffset(0);
        }}
        onLoadMore={() => void loadChats(false, chatOffset)}
      />
      <section className="messagePane">
        {selectedChat ? (
          <ThreadView key={selectedChat.id} chat={selectedChat} />
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
    </div>
  );
}
