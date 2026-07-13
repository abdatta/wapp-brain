import { HardDrive } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import type { ChatListItem } from "../../../shared/types";
import { listChats } from "../../api";
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

  const loadChats = useCallback(
    async (reset: boolean, offsetOverride?: number) => {
      setLoadingChats(true);
      try {
        const offset = reset ? 0 : offsetOverride ?? 0;
        const next = await listChats({ search: chatSearch, type: chatType, includeEventOnly, limit: CHAT_LIMIT, offset });
        setChats((current) => (reset ? next : [...current, ...next]));
        setChatOffset(offset + next.length);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load chats.");
      } finally {
        setLoadingChats(false);
      }
    },
    [chatSearch, chatType, includeEventOnly, setError]
  );

  useEffect(() => {
    void loadChats(true);
  }, [loadChats]);

  // Live archive changes refresh the list (throttled by the status provider).
  const onArchive = useCallback(() => {
    void loadChats(true);
  }, [loadChats]);
  useArchiveEvents(onArchive);

  // Resolve the open chat: prefer the loaded list, then rich router state from a
  // search hit, then a minimal stub so a cold deep link still loads by id.
  const stateChat = (location.state as { chat?: ChatListItem } | null)?.chat ?? null;
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
  }, [chatId, chats, stateChat]);

  return (
    <div className="workspace chatsWorkspace">
      <ChatList
        chats={chats}
        chatSearch={chatSearch}
        chatType={chatType}
        includeEventOnly={includeEventOnly}
        loadingChats={loadingChats}
        selectedId={selectedChat?.id ?? null}
        onSearchChange={setChatSearch}
        onTypeChange={setChatType}
        onIncludeEventOnlyChange={(value) => {
          setIncludeEventOnly(value);
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
