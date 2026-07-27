import { Eye, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ChatListItem } from "../../../shared/types";
import { buildChatDeepLink } from "../../lib/deepLinks";
import { EmptyState, SkeletonRows, chatDisplayLabel, formatDate } from "../../thread";

// The chat-list master pane. Selecting a chat is a route change to `/chats/:id`,
// and the active chat is highlighted from the URL-derived `selectedId`. Filter
// state is page-local (owned by ChatsPage) and passed down here.
export function ChatList({
  chats,
  chatSearch,
  chatType,
  includeEventOnly,
  loadingChats,
  selectedId,
  onSearchChange,
  onTypeChange,
  onIncludeEventOnlyChange,
  onLoadMore
}: {
  chats: ChatListItem[];
  chatSearch: string;
  chatType: string;
  includeEventOnly: boolean;
  loadingChats: boolean;
  selectedId: number | null;
  onSearchChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onIncludeEventOnlyChange: (value: boolean) => void;
  onLoadMore: () => void;
}) {
  const navigate = useNavigate();
  return (
    <aside className="sidebar chatSidebar">
      <div className="filterPanel">
        <div className="searchBox">
          <Search size={16} />
          <input value={chatSearch} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search chats" />
        </div>
        <div className="segmented">
          {/* No `status` filter: WhatsApp Status is not a chat and never enters the archive. */}
          {["all", "dm", "group", "broadcast"].map((type) => (
            <button key={type} className={chatType === type ? "active" : ""} onClick={() => onTypeChange(type)} type="button">
              {type}
            </button>
          ))}
        </div>
        <label className="filterToggle">
          <input
            type="checkbox"
            checked={includeEventOnly}
            onChange={(event) => onIncludeEventOnlyChange(event.target.checked)}
          />
          <span>Show event-only chats</span>
        </label>
      </div>

      <div className="chatList" aria-live="polite">
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`chatRow ${selectedId === chat.id ? "selected" : ""}`}
            onClick={() => navigate(buildChatDeepLink(chat.id))}
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
          <button className="loadButton" onClick={onLoadMore} disabled={loadingChats} type="button">
            Load more
          </button>
        )}
      </div>
    </aside>
  );
}
