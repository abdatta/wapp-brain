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
import { parseInlineSegments, parseWhatsAppBlocks, type InlineSegment } from "./whatsappFormat";
import { quotePreviewModel } from "./quotePreview";
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
  StatusSummary,
  GoogleContactsStatus
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

// Message-thread + media rendering toolkit, extracted verbatim from the former
// App.tsx monolith. Presentational only — no cross-cutting state; consumed by the
// chats page (ChatList/ThreadView) and referenced by shared panels for formatting.
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
  highlighted,
  onJumpToMessage
}: {
  message: MessageListItem;
  isGroup: boolean;
  onOpenMedia: OnOpenMedia;
  highlighted?: boolean;
  onJumpToMessage?: (messageId: number) => void;
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
      {message.quotedSnapshot && <QuotedPreview message={message} onJumpToMessage={onJumpToMessage} />}
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

export function QuotedPreview({ message, onJumpToMessage }: { message: MessageListItem; onJumpToMessage?: (messageId: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const preview = quotePreviewModel(message);
  if (!preview) return null;
  const canJump = preview.jumpMessageId != null && onJumpToMessage != null;
  const previewContent = (
    <>
      {preview.thumbnailUrl && <img className="quotedPreviewThumb" loading="lazy" src={preview.thumbnailUrl} alt="" />}
      <div className="quotedPreviewBody">
        <strong>{preview.sender}</strong>
        <span className={expanded ? "quotedPreviewText full" : "quotedPreviewText"}>{preview.text}</span>
      </div>
    </>
  );
  return (
    <section className={`quotedPreview ${expanded ? "expanded" : ""}`} aria-label={`Replying to ${preview.sender}`}>
      {canJump ? (
        <button
          className="quotedPreviewTarget"
          type="button"
          onClick={() => onJumpToMessage(preview.jumpMessageId!)}
          aria-label={`Jump to original message from ${preview.sender}`}
        >
          {previewContent}
        </button>
      ) : (
        <div className="quotedPreviewStatic">{previewContent}</div>
      )}
      {preview.isLong && (
        <button className="quotedPreviewAction" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </section>
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

export {
  formatDate,
  formatTime,
  formatDateTime,
  formatBytes,
  msToIso,
  EmptyState,
  SkeletonRows,
  SkeletonMessages,
  chatDisplayLabel,
  groupMessagesByDay,
  sortMessagesChronologically,
  groupConsecutiveMedia,
  isNearBottom,
  MessageBubble,
  MediaGridBubble,
  MediaLightbox
};
