import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SearchMatchTier, SearchRelaxationInfo, SearchResultItem, SearchTypeFilter } from "../../../shared/types";
import { getSearchStatus, searchArchive, startSearchReindex } from "../../api";
import { buildChatDeepLink } from "../../lib/deepLinks";
import { GlobalSearchResults } from "../../panels";
import { useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";

// The global archive search surface. A result opens its message by navigating to
// the thread deep link (`/chats/:id?at=<messageId>`) rather than switching an
// in-component panel, so hits are shareable and reload-safe.
export function SearchPage() {
  const navigate = useNavigate();
  const { setError } = useToast();
  const { searchIndex, setSearchIndex, reindexProgress, setReindexProgress } = useStatus();

  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResults, setGlobalResults] = useState<SearchResultItem[]>([]);
  const [globalTotalMatches, setGlobalTotalMatches] = useState(0);
  const [globalMatchTier, setGlobalMatchTier] = useState<SearchMatchTier>("exact");
  const [globalRelaxation, setGlobalRelaxation] = useState<SearchRelaxationInfo | null>(null);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);
  const [searchSender, setSearchSender] = useState("");
  const [searchType, setSearchType] = useState<"all" | SearchTypeFilter>("all");
  const [searchDirection, setSearchDirection] = useState<"all" | "incoming" | "outgoing">("all");
  const [searchAfter, setSearchAfter] = useState("");
  const [searchBefore, setSearchBefore] = useState("");

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
          setGlobalMatchTier(response.matchTier ?? "exact");
          setGlobalRelaxation(response.relaxation ?? null);
          setSearchIndex(response.index ?? null);
          setGlobalSearchError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setGlobalResults([]);
          setGlobalTotalMatches(0);
          setGlobalMatchTier("exact");
          setGlobalRelaxation(null);
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
  }, [globalQuery, searchSender, searchType, searchDirection, searchAfter, searchBefore, searchIndex?.state, setSearchIndex, setReindexProgress]);

  async function handleStartReindex() {
    try {
      const response = await startSearchReindex();
      setReindexProgress(response.reindex);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the search reindex.");
    }
  }

  return (
    <div className="searchPage">
      <div className="filterPanel globalSearchPanel">
        <div className="searchBox">
          <Search size={16} />
          <input
            value={globalQuery}
            onChange={(event) => setGlobalQuery(event.target.value)}
            placeholder="Search all messages"
            autoFocus
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
          matchTier={globalMatchTier}
          relaxation={globalRelaxation}
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
          onOpen={(hit) =>
            navigate(buildChatDeepLink(hit.chatId, hit.messageId), {
              // Seed the thread header with the hit's chat info so a fresh
              // navigation shows the real name/type (a reload derives from the
              // chat list instead).
              state: {
                chat: {
                  id: hit.chatId,
                  sourceChatId: hit.chatSourceId,
                  jid: hit.chatSourceId,
                  displayName: hit.chatDisplayName,
                  chatType: hit.chatType,
                  messageCount: 0,
                  participantCount: 0,
                  lastMessageAt: null
                }
              }
            })
          }
          onReindex={() => void handleStartReindex()}
        />
      ) : (
        <div className="searchIntro">
          <Search size={28} />
          <p>Search every message in the local archive. Open a result to jump to it in its thread.</p>
        </div>
      )}
    </div>
  );
}
