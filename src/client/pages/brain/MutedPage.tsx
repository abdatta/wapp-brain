import { ArrowLeft, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  BrainDocListItem,
  BrainEpisodeRecord,
  BrainLifecycleItem,
  BrainMutedChatItem,
  BrainMutedListResponse
} from "../../../shared/types";
import { listBrainDocs, listBrainEpisodes, listBrainLifecycleItems, listMutedChats, unmuteChat } from "../../api";
import { useToast } from "../../state/ToastContext";
import { chatDisplayLabel } from "../../thread";

// The muted-items view (`/brain/muted`): every chat the brain is not reading,
// what muting is saving (messages/media piled up since the watermark froze),
// and what it hid. Nothing here was deleted — every count drills into artifacts
// that are still fully stored and come straight back on unmute.
//
// Every number is DERIVED server-side from the frozen watermark and the message
// store; this page renders, it never decides what counts as muted.

const formatDay = (ms: number | null): string =>
  ms == null || ms <= 0
    ? "its entire history"
    : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

type Drill = {
  chatSourceId: string;
  episodes: BrainEpisodeRecord[];
  commitments: BrainLifecycleItem[];
  docs: BrainDocListItem[];
};

// Loading shimmer matching the loaded .evalCard box exactly (same border,
// radius, padding, gaps) so the list does not jump when the data arrives.
function MutedSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }).map((_unused, index) => (
        <section className="evalCard mutedSkeletonCard" key={index} aria-hidden="true">
          <div className="mutedSkel mutedSkelTitle" />
          <div className="mutedSkelChips">
            <div className="mutedSkel mutedSkelChip" />
            <div className="mutedSkel mutedSkelChip" />
          </div>
          <div className="mutedSkel mutedSkelText" />
          <div className="mutedSkel mutedSkelAction" />
        </section>
      ))}
    </>
  );
}

export function MutedPage() {
  const { setError, setNotice } = useToast();
  const [data, setData] = useState<BrainMutedListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyChat, setBusyChat] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listMutedChats());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load muted chats.");
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Drill-in loads on demand: the muted estate can be large (every channel is
  // muted by the standing rule), so fetching every chat's hidden artifacts up
  // front would be exactly the per-row shape this codebase avoids.
  async function openDrill(item: BrainMutedChatItem): Promise<void> {
    if (drill?.chatSourceId === item.chatSourceId) {
      setDrill(null);
      return;
    }
    setDrillLoading(true);
    try {
      const [episodes, commitments, docs] = await Promise.all([
        listBrainEpisodes({ chatSourceId: item.chatSourceId, onlyMuted: true, limit: 50 }),
        listBrainLifecycleItems({ status: "all", chatSourceId: item.chatSourceId, onlyMuted: true, limit: 50 }),
        listBrainDocs({ onlyMuted: true, limit: 200 })
      ]);
      setDrill({ chatSourceId: item.chatSourceId, episodes, commitments: commitments.items, docs: docs.items });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load hidden artifacts.");
    } finally {
      setDrillLoading(false);
    }
  }

  async function handleUnmute(item: BrainMutedChatItem): Promise<void> {
    setBusyChat(item.chatSourceId);
    try {
      await unmuteChat(item.chatSourceId, "epoch");
      setNotice(
        `Unmuted ${chatDisplayLabel({ displayName: item.chatDisplayName, chatType: item.chatType })}. Its hidden artifacts are back; the vault is reprojecting in the background.`
      );
      setDrill(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unmute this chat.");
    } finally {
      setBusyChat(null);
    }
  }

  const summary = data?.summary;

  return (
    <div className="evalPage">
      <header className="evalHeader">
        <Link className="evalBackLink" to="/brain">
          <ArrowLeft size={14} /> Brain
        </Link>
        <h2>
          <EyeOff size={18} /> Muted from the brain
        </h2>
        <p className="brainHint">
          These chats keep archiving every message and media file — the brain simply does not read them, so they cost no
          model spend and add no noise. Nothing below was deleted: unmuting brings all of it back exactly as it was.
        </p>
      </header>

      <section className="evalCard">
        <div className="evalCardHeader">
          <h3>
            {summary ? `${summary.mutedChats.toLocaleString()} muted chat${summary.mutedChats === 1 ? "" : "s"}` : "Muted chats"}
          </h3>
          <button type="button" className="evalButton" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
        {summary && summary.mutedChats > 0 && (
          <div className="lifecycleCounts">
            <span className="chip">{summary.piledUpMessages.toLocaleString()} messages piled up</span>
            <span className="chip">{summary.piledUpMedia.toLocaleString()} media piled up</span>
            <span className="chip">{summary.hiddenEpisodes.toLocaleString()} episodes hidden (kept)</span>
          </div>
        )}
      </section>

      {loading && !data && <MutedSkeleton />}
      {!loading && data?.items.length === 0 && (
        <section className="evalCard">
          <p className="brainHint">
            No chats are muted. Mute one from any chat's thread header — WhatsApp Channels are muted automatically.
          </p>
        </section>
      )}

      {data?.items.map((item) => (
        <section className="evalCard" key={item.chatSourceId}>
          <div className="evalCardHeader">
            {/* Never a raw JID: an unnamed chat says so, per the app's
                unresolved-identity convention. */}
            <h3>{chatDisplayLabel({ displayName: item.chatDisplayName, chatType: item.chatType })}</h3>
            <button
              type="button"
              className="evalButton"
              onClick={() => void handleUnmute(item)}
              disabled={busyChat === item.chatSourceId}
              title="Unmute the entire history: hidden artifacts reappear everywhere and the brain resumes from its frozen watermark."
            >
              {busyChat === item.chatSourceId ? <Loader2 className="spin" size={14} /> : <Eye size={14} />} Unmute
            </button>
          </div>

          <div className="lifecycleCounts">
            <span className="chip">{item.chatType}</span>
            <span className="chip">muted since {formatDay(item.mutedSinceMs)}</span>
            {item.origin === "channel-default" && <span className="chip">muted by default (channel)</span>}
          </div>

          {/* An empty subscription stub and a chat holding back real volume are
              very different things, and the row should not read the same. */}
          {(item.archivedMessages ?? 0) === 0 ? (
            <p className="brainHint">Nothing archived in this chat yet — a subscription with no messages received.</p>
          ) : (
            <p className="brainHint">
              <strong>{(item.archivedMessages ?? 0).toLocaleString()}</strong> messages archived
              {item.piledUpMessages > 0 ? (
                <>
                  , of which <strong>{item.piledUpMessages.toLocaleString()}</strong> messages and{" "}
                  <strong>{item.piledUpMedia.toLocaleString()}</strong> media items have piled up since the brain last
                  processed this chat — every one kept, none processed.
                </>
              ) : (
                <> — nothing new since the brain last processed this chat.</>
              )}
            </p>
          )}

          {item.hiddenEpisodes + item.hiddenCommitments + item.hiddenDocs > 0 ? (
            <button type="button" className="evalButton" onClick={() => void openDrill(item)} disabled={drillLoading}>
              {drill?.chatSourceId === item.chatSourceId ? "Hide" : "Show"} what muting hid —{" "}
              {item.hiddenEpisodes.toLocaleString()} episodes, {item.hiddenClaims.toLocaleString()} claims,{" "}
              {item.hiddenCommitments.toLocaleString()} commitments, {item.hiddenDocs.toLocaleString()} pages
            </button>
          ) : (
            <p className="brainHint">Nothing was hidden — the brain had not produced anything from this chat.</p>
          )}

          {drill?.chatSourceId === item.chatSourceId && (
            <div className="mutedDrill">
              {drillLoading && <Loader2 className="spin" size={14} />}

              <h4>Hidden episodes</h4>
              {drill.episodes.length === 0 ? (
                <p className="brainHint">None.</p>
              ) : (
                <ul className="mutedDrillList">
                  {drill.episodes.map((episode) => (
                    <li key={episode.id}>
                      <span className="mutedDrillDate">{formatDay(episode.startAtMs)}</span> {episode.summary}
                    </li>
                  ))}
                </ul>
              )}

              <h4>Hidden commitments and questions</h4>
              {drill.commitments.length === 0 ? (
                <p className="brainHint">None.</p>
              ) : (
                <ul className="mutedDrillList">
                  {drill.commitments.map((commitment) => (
                    <li key={commitment.claimId}>
                      <span className="mutedDrillDate">{commitment.kind}</span> {commitment.text}
                    </li>
                  ))}
                </ul>
              )}

              <h4>Pages fed only by muted material</h4>
              {drill.docs.length === 0 ? (
                <p className="brainHint">
                  None. A page fed by both muted and live chats keeps showing normally — only its muted-source links point
                  back here.
                </p>
              ) : (
                <ul className="mutedDrillList">
                  {drill.docs.map((doc) => (
                    <li key={doc.docId}>
                      <Link to={`/brain/pages/${encodeURIComponent(doc.docId)}`}>{doc.title}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
