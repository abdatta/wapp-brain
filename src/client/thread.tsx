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
  Loader2,
  MessageCircle,
  MapPin,
  ContactRound,
  Info,
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
import { createPortal } from "react-dom";
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
  ArchiveSignalObservation,
  MessageDetail,
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
  getMessageDetail,
  messageVcardDownloadUrl,
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
  const text = visibleMessageText(message);
  const placeholder = messagePlaceholder(message);
  const mediaWidth = mediaDisplayWidth(message.media, message.messageType);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailFocus, setDetailFocus] = useState<MessageDetailFocus | null>(null);
  const hasHistory = message.editRevisionCount > 0 || Boolean(message.structuredSignals?.edit);
  const hasDeletionDetail = Boolean(message.structuredSignals?.deletion);
  const hasStructuredCard = Boolean(message.structuredSignals?.location || message.structuredSignals?.vcards.length);

  if (isSystemEvent(message)) {
    const summaries = message.systemEvents ?? [];
    const visibleSummaries = summaries.slice(0, 2);
    const remainingSummaryCount = Math.max(0, summaries.length - visibleSummaries.length);
    const isBundle = summaries.length > 2;
    return (
      <article className={`systemChip ${highlighted ? "jumpHighlight" : ""}`} data-mid={message.id}>
        <button className="systemEventTrigger" type="button" onClick={() => setDetailFocus("system")} aria-label="Open details for this system event">
          <span className="systemEventDetails">
            {summaries.length ? (
              isBundle ? (
                <>
                  <strong>{summaries.length} group changes</strong>
                  <span>{systemEventDisplaySummary(visibleSummaries[0]!)}</span>
                  <small>+{remainingSummaryCount + 1} more</small>
                </>
              ) : visibleSummaries.map((event, index) => <span key={`${event.kind}:${event.captureVersion}:${index}`}>{systemEventDisplaySummary(event)}</span>)
            ) : (
              <span>{text && text.trim().toLowerCase() !== "system event" ? renderInlineText(text, message.mentions) : placeholder.label === "System event" || text?.trim().toLowerCase() === "system event" ? "Unclassified system event" : placeholder.label}</span>
            )}
          </span>
          <Info className="systemEventInfo" size={13} aria-hidden="true" />
        </button>
        <time>{formatTime(message.sentAt)}</time>
        {detailFocus && <MessageDetailModal message={message} focus={detailFocus} onClose={() => setDetailFocus(null)} />}
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
          {message.isDeleted && (hasDeletionDetail ? (
            <button
              className="deletedChip clickable"
              type="button"
              onClick={() => setDetailFocus("deletion")}
              title="View deletion details"
              aria-haspopup="dialog"
              aria-expanded={detailFocus === "deletion"}
            >
              deleted
            </button>
          ) : <span className="deletedChip">deleted</span>)}
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
        !message.media && !hasStructuredCard && (
          <p className="placeholderText">
            {placeholder.label}
            {placeholder.reason && <span className="placeholderReason">{placeholder.reason}</span>}
          </p>
        )
      )}
      {message.linkPreview && <LinkPreviewCard message={message} />}
      {message.structuredSignals && <StructuredSignalDetails message={message} onOpenDetails={setDetailFocus} />}
      {(message.isForwarded || message.isStarred || (message.hasMedia && !message.media)) && (
        <div className="messageFlags">
          {message.hasMedia && !message.media && <span>{message.mediaMimeType ?? message.messageType}</span>}
          {message.isForwarded && <span>forwarded</span>}
          {message.isStarred && <span>starred</span>}
        </div>
      )}
      {historyOpen && <EditHistoryModal message={message} onClose={() => setHistoryOpen(false)} />}
      {detailFocus && <MessageDetailModal message={message} focus={detailFocus} onClose={() => setDetailFocus(null)} />}
    </article>
  );
}

export function visibleMessageText(message: MessageListItem): string | null {
  const text = message.body || message.caption;
  if (!message.body || !message.structuredSignals) return text;
  const body = message.body.trim();
  if (message.structuredSignals.location) {
    const generatedLocationLabel = message.structuredSignals.location.isLive ? /^live location$/i : /^location$/i;
    if (generatedLocationLabel.test(body)) return message.caption;
  }
  if (message.structuredSignals.vcards.length) {
    const generatedCount = body.match(/^(\d+)\s+contacts?$/i);
    if (generatedCount && Number(generatedCount[1]) === message.structuredSignals.vcards.length) return message.caption;
  }
  return text;
}

export type MessageDetailFocus = "location" | "vcard" | "deletion" | "interpretation" | "system";

function systemEventDisplaySummary(event: NonNullable<MessageListItem["systemEvents"]>[number]): string {
  return event.kind === "generic" && event.summary === "System event" ? "Unclassified system event" : event.summary;
}

// Thread rows retain compact, scannable summaries. Complete retained archive
// data is loaded only when the user explicitly opens details.
function StructuredSignalDetails({ message, onOpenDetails }: { message: MessageListItem; onOpenDetails: (focus: MessageDetailFocus) => void }) {
  const signals = message.structuredSignals;
  if (!signals) return null;
  return (
    <div className="structuredSignals">
      {signals.location && (
        <button className="structuredCard locationCard" type="button" onClick={() => onOpenDetails("location")}>
          <MapPin size={16} />
          <span><strong>{signals.location.isLive ? "Live location" : "Location"}</strong><small>{compactLocationLabel(signals.location.name, signals.location.address) || "Open local location details"}</small></span>
          <ChevronRight size={15} />
        </button>
      )}
      {signals.vcards.length > 0 && (
        <button className="structuredCard vcardCard" type="button" onClick={() => onOpenDetails("vcard")}>
          <ContactRound size={16} />
          <span><strong>{signals.vcards.length} contact card{signals.vcards.length === 1 ? "" : "s"}</strong><small>{signals.vcards.map((card) => card.displayName).filter(Boolean).join(" · ") || "Open contact details"}</small></span>
          <ChevronRight size={15} />
        </button>
      )}
      {signals.mediaInterpretations.length > 0 && <button className="detailDisclosure" type="button" onClick={() => onOpenDetails("interpretation")}><FileText size={13} /> Transcript <ChevronRight size={13} /></button>}
    </div>
  );
}

function MessageDetailModal({ message, focus, onClose }: { message: MessageListItem; focus: MessageDetailFocus; onClose: () => void }) {
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let cancelled = false;
    getMessageDetail(message.id).then((result) => {
      if (!cancelled) setDetail(result);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load local message details.");
    });
    return () => { cancelled = true; };
  }, [message.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);
  return createPortal(
    <div className="modalBackdrop detailBackdrop" role="dialog" aria-modal="true" aria-label="Message details" onClick={onClose}>
      <section className="messageDetailModal" onClick={(event) => event.stopPropagation()}>
        <header className="detailModalHeader">
          <div>
            <span className="eyebrow"><Info size={14} /> Local archive</span>
            <h2>{detail ? messageDetailTitle(detail, focus) : "Loading details"}</h2>
            {detail && <p>{messageDetailSubtitle(detail, focus)}</p>}
          </div>
          <button ref={closeButtonRef} className="iconButton" type="button" onClick={onClose} aria-label="Close message details"><X size={16} /></button>
        </header>
        {error ? <p className="detailError">{error}</p> : !detail ? <div className="editTimelineLoading"><Loader2 className="spin" size={18} /> Loading local detail...</div> : <MessageDetailContent detail={detail} focus={focus} />}
      </section>
    </div>,
    document.body
  );
}

export function messageDetailTitle(detail: MessageDetail, focus: MessageDetailFocus): string {
  if (focus === "system") return detail.systemEvents.length > 1 ? `${detail.systemEvents.length} group changes` : detail.systemEvents[0]?.kind === "generic" ? "Unclassified system event" : "System event";
  if (focus === "deletion") return "Deleted message";
  if (focus === "location") return detail.locations.some((location) => location.isLive) ? "Live location" : "Location";
  if (focus === "vcard") return detail.vcards.length === 1 ? "Shared contact" : `${detail.vcards.length} shared contacts`;
  return detail.mediaInterpretations.some((item) => item.kind === "transcription" || item.kind === "transcription_segment") ? "Transcript" : "Accessibility details";
}

export function messageDetailSubtitle(detail: MessageDetail, focus: MessageDetailFocus): string {
  if (focus === "system") return detail.systemEvents.some((event) => event.kind === "generic")
    ? "The source event is preserved, but its action could not be decoded safely."
    : "Who acted and who was affected are kept as separate facts.";
  if (focus === "deletion") return "What WhatsApp retained about when this message was removed.";
  if (focus === "location") return "Exact coordinates and the location metadata retained by WhatsApp.";
  if (focus === "vcard") return "Contact data exactly as preserved in your local archive.";
  return "Source-provided text from WhatsApp — not generated by Wapp Brain.";
}

export function MessageDetailContent({ detail, focus }: { detail: MessageDetail; focus: MessageDetailFocus }) {
  return (
    <div className="messageDetailContent">
      {focus === "location" && detail.locations.map((location, index) => <LocationDetailView location={location} key={`location:${index}`} />)}
      {focus === "vcard" && detail.vcards.map((card) => <VCardDetailView card={card} messageId={detail.id} key={`vcard:${card.cardIndex}`} />)}
      {focus === "deletion" && detail.deletion && <DeletionDetailView deletion={detail.deletion} />}
      {focus === "interpretation" && <InterpretationDetailView items={detail.mediaInterpretations} />}
      {focus === "system" && detail.systemEvents.map((event) => <SystemEventDetailSection event={event} compact={detail.systemEvents.length > 1} key={event.eventKey} />)}
    </div>
  );
}

function VCardDetailView({ card, messageId }: { card: MessageDetail["vcards"][number]; messageId: number }) {
  const properties = card.properties ?? [];
  const primaryProperties = properties.filter((property) => !["BEGIN", "END", "VERSION", "N", "FN"].includes(property.name.toUpperCase()));
  return (
    <section className="detailSection vcardDetail">
      <div className="contactDetailHero">
        <span className="detailIcon"><ContactRound size={18} /></span>
        <div><span className="detailKind">Contact {card.cardIndex + 1}</span><h3>{card.displayName ?? `Contact card ${card.cardIndex + 1}`}</h3></div>
      </div>
      <DetailFieldGrid values={{
        "Resolved identity": card.resolvedJid,
        "vCard file": card.downloadKind === "source" ? "Original source retained" : card.downloadKind === "constructed" ? "Constructed from retained fields" : "Unavailable",
        "Download filename": card.downloadFileName,
        Observed: formatDetailDateTime(card.observedAtMs)
      }} />
      {primaryProperties.length > 0 && (
        <div className="vcardPrimaryFields">
          <span className="detailKind">Contact fields</span>
          <VCardPropertyList properties={primaryProperties} />
        </div>
      )}
      {card.downloadKind !== "unavailable" ? <a className="detailDownload" href={messageVcardDownloadUrl(messageId, card.cardIndex)} download><Download size={14} /> Download .vcf{card.downloadKind === "constructed" ? " (constructed)" : ""}</a> : <p className="detailEmpty">No trustworthy downloadable vCard can be constructed from the retained data.</p>}
      {properties.length > 0 && <details><summary>All {properties.length} retained vCard fields</summary><VCardPropertyList properties={properties} /></details>}
      {card.vcard && <details><summary>Original vCard source</summary><pre className="sourcePayload">{card.vcard}</pre></details>}
      <SourceObservationDisclosure observations={card.provenance} />
    </section>
  );
}

function VCardPropertyList({ properties }: { properties: NonNullable<MessageDetail["vcards"][number]["properties"]> }) {
  return (
    <div className="vcardProperties">
      {properties.map((property, index) => (
        <div key={`${property.name}:${index}`}>
          <strong>{property.group ? `${property.group}.` : ""}{property.name}{property.parameters.length ? `; ${property.parameters.map((parameter) => `${parameter.name}=${parameter.values.join(",")}`).join("; ")}` : ""}</strong>
          <span>{property.value}</span>
        </div>
      ))}
    </div>
  );
}

function LocationDetailView({ location }: { location: MessageDetail["locations"][number] }) {
  const hasContext = Boolean(location.name || location.address || location.url || location.comment || location.caption);
  const hasTelemetry = location.accuracyMeters != null || location.speedMps != null || location.headingDegrees != null;
  const heroAddress = location.address && location.address.trim().toLocaleLowerCase() !== location.name?.trim().toLocaleLowerCase() ? location.address : null;
  return (
    <>
      <section className="locationDetailHero">
        <span className="locationTypeBadge"><Signal size={13} /> {location.isLive ? "Live share" : "Pinned location"}</span>
        <code className="coordinatePair">{location.latitude ?? "—"}, {location.longitude ?? "—"}</code>
        {(location.name || location.address) && <div className="locationPlace"><strong>{location.name ?? location.address}</strong>{heroAddress && <span>{heroAddress}</span>}</div>}
      </section>
      {location.isLive && (
        <section className="detailSection">
          <h3><History size={16} /> Share timeline</h3>
          <DetailFactCards values={{
            "First observed": formatDetailDateTime(location.observedAtMs),
            "Share duration": location.liveShareDurationMs == null ? null : formatDetailDuration(location.liveShareDurationMs),
            "Final update": location.finalAtMs == null ? null : formatDetailDateTime(location.finalAtMs)
          }} />
        </section>
      )}
      {hasContext && (
        <section className="detailSection">
          <h3><MapPin size={16} /> Place details</h3>
          <DetailFieldGrid values={{ Name: location.name, Address: location.address, URL: location.url ?? null, Comment: location.comment ?? null, Caption: location.caption ?? null }} />
        </section>
      )}
      {hasTelemetry && (
        <section className="detailSection">
          <h3><Signal size={16} /> Accuracy and motion</h3>
          <DetailFactCards values={{ "Accuracy": location.accuracyMeters == null ? null : `${location.accuracyMeters} m`, "Speed": location.speedMps == null ? null : `${location.speedMps} m/s`, "Heading": location.headingDegrees == null ? null : `${location.headingDegrees}°` }} />
        </section>
      )}
      <section className="detailSection quietDetailSection">
        <details className="technicalDetails detailTechnicalDisclosure">
          <summary>Retained source details</summary>
          <DetailFieldGrid values={{
            Latitude: location.latitude,
            Longitude: location.longitude,
            Sequence: location.sequenceNumber ?? null,
            "Time offset": location.timeOffsetMs == null ? null : formatOffset(location.timeOffsetMs),
            "Embedded thumbnail": location.hasThumbnail ? "Yes" : "No",
            "Observed": formatDetailDateTime(location.observedAtMs)
          }} />
          {location.observations.length > 0 && <details><summary>{location.observations.length} retained update{location.observations.length === 1 ? "" : "s"}</summary><div className="detailList">{location.observations.map((sample, index) => <div className="locationObservation" key={sample.observationKey}><span>Update {index + 1}</span><DetailFieldGrid values={{ Sequence: sample.sequenceNumber, Latitude: sample.latitude, Longitude: sample.longitude, "Accuracy": sample.accuracyMeters == null ? null : `${sample.accuracyMeters} m`, "Speed": sample.speedMps == null ? null : `${sample.speedMps} m/s`, "Heading": sample.headingDegrees == null ? null : `${sample.headingDegrees}°`, "Observed": formatDetailDateTime(sample.observedAtMs) }} /></div>)}</div></details>}
          <SourceObservationDisclosure observations={location.provenance} />
        </details>
      </section>
    </>
  );
}

function compactLocationLabel(name: string | null, address: string | null): string {
  const values = [name, address].filter((value): value is string => Boolean(value?.trim()));
  return values.filter((value, index) => values.findIndex((candidate) => candidate.trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase()) === index).join(" · ");
}

function DeletionDetailView({ deletion }: { deletion: NonNullable<MessageDetail["deletion"]> }) {
  const elapsed = formatElapsed(deletion.sentAtMs, deletion.deletedAtMs);
  return (
    <>
      <section className="deletionTimeline" aria-label="Deletion timeline">
        <div><span>Sent</span><strong>{formatDetailDateTime(deletion.sentAtMs)}</strong></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>Deleted</span><strong>{formatDetailDateTime(deletion.deletedAtMs)}</strong></div>
        {elapsed && <span className="elapsedBadge">{elapsed} later</span>}
      </section>
      <p className={`detailNotice ${deletion.contentState === "retained" ? "success" : "neutral"}`}>
        {deletion.contentState === "retained"
          ? "The message was later deleted. Content already captured by the archive remains visible in the thread."
          : "The archive received the deletion marker, but never captured the original message content."}
      </p>
      <section className="detailSection">
        <h3><Trash2 size={16} /> Deletion source</h3>
        <DetailFieldGrid values={{
          "Deleted by": deletion.revokedByJid ?? "Unknown / not provided",
          "Admin deletion": deletion.revokedByAdmin == null ? "Not provided" : deletion.revokedByAdmin ? "Yes" : "No",
          "Deletion kind": deletion.deletionKind ?? "Not provided"
        }} />
        <SourceObservationDisclosure observations={deletion.observations} />
      </section>
    </>
  );
}

function InterpretationDetailView({ items }: { items: MessageDetail["mediaInterpretations"] }) {
  const primary = items.filter((item) => item.kind !== "transcription_segment");
  const segments = items.filter((item) => item.kind === "transcription_segment");
  return (
    <>
      {primary.map((item) => (
        <section className="detailSection interpretationPrimary" key={`${item.kind}:${item.segmentIndex}`}>
          <span className="detailKind">{item.kind === "accessibility_label" ? "WhatsApp accessibility description" : "WhatsApp transcription"}</span>
          <p>{item.text}</p>
          <small>Source-provided · {item.source === "live" ? "Live sync" : "Backup"} · {formatDetailDateTime(item.observedAtMs)}</small>
        </section>
      ))}
      {segments.length > 0 && (
        <section className="detailSection transcriptSegments">
          <details open={primary.length === 0}>
            <summary>{segments.length} transcript segment{segments.length === 1 ? "" : "s"}</summary>
            <div className="detailList">{segments.map((item, index) => <div className="interpretationDetail" key={`${item.kind}:${item.segmentIndex}`}><strong>Segment {index + 1}</strong><span>{item.text}</span><small>{formatSegmentTiming(item.startMs, item.endMs)}</small></div>)}</div>
          </details>
        </section>
      )}
    </>
  );
}

function DetailFactCards({ values }: { values: Record<string, string | number | null | undefined> }) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return <div className="detailFactCards">{entries.map(([label, value]) => <div key={label}><span>{label}</span><strong>{String(value)}</strong></div>)}</div>;
}

function SystemEventDetailSection({ event, compact = false }: { event: MessageDetail["systemEvents"][number]; compact?: boolean }) {
  const actorApplies = event.kind === "number_change" || event.kind === "chat_metadata" || (event.kind === "membership" && !["join", "leave", "accept"].includes(event.action ?? ""));
  const hasTechnical = Boolean(event.actorJid || event.participantJid || event.oldJid || event.newJid || event.rawType || event.rawParameters);
  const technicalFields = { "Actor identity": event.actorJid, "Participant identity": event.participantJid, "Previous identity JID": event.oldJid, "New identity JID": event.newJid, "Raw event type": event.rawType };
  return (
    <section className={`detailSection systemEventDetailCard ${compact ? "compact" : ""}`}>
      <div className="detailSectionHeading">
        <span className="detailKind">{event.kind === "generic" ? "Unclassified" : event.kind.replaceAll("_", " ")}{event.action ? ` · ${event.action}` : ""}</span>
        <h3><Info size={16} /> {event.summary}</h3>
      </div>
      {event.kind === "generic" && <p className="detailNotice neutral">No join, leave, role, number-change, or group-setting meaning could be verified from this source row. The original type is still available below.</p>}
      <DetailFieldGrid values={{
        "Event time": formatDetailDateTime(event.occurredAtMs),
        Actor: actorApplies ? resolvedIdentityDisplay(event.actorLabel) : null,
        "Affected participant": event.kind === "membership" ? resolvedIdentityDisplay(event.participantLabel) : null,
        "Previous identity": event.kind === "number_change" ? resolvedIdentityDisplay(event.oldIdentityLabel) : null,
        "New identity": event.kind === "number_change" ? resolvedIdentityDisplay(event.newIdentityLabel) : null,
        Field: event.field,
        "Previous value": event.oldValue,
        "New value": event.newValue
      }} />
      {compact && (hasTechnical || event.observations.length > 0) ? (
        <details className="technicalDetails">
          <summary>Source details{event.observations.length ? ` · ${event.observations.length} record${event.observations.length === 1 ? "" : "s"}` : ""}</summary>
          {hasTechnical && <DetailFieldGrid values={technicalFields} />}
          {event.rawParameters && <pre className="sourcePayload">{formatRawPayload(event.rawParameters)}</pre>}
          <SourceObservationRows observations={event.observations} />
        </details>
      ) : (
        <>
          {hasTechnical && (
            <details className="technicalDetails">
              <summary>Technical source data</summary>
              <DetailFieldGrid values={technicalFields} />
              {event.rawParameters && <pre className="sourcePayload">{formatRawPayload(event.rawParameters)}</pre>}
            </details>
          )}
          <SourceObservationDisclosure observations={event.observations} />
        </>
      )}
    </section>
  );
}

function resolvedIdentityDisplay(label: string | null): string {
  if (!label || /^(unknown|unresolved)(\s*\/\s*(unknown|unresolved|not provided))?( contact)?$/i.test(label.trim())) return "Unknown";
  return label;
}

function EditTimeline({ entries }: { entries: MessageDetail["editTimeline"] }) {
  return (
    <div className="editTimeline">
      {entries.map((entry, index) => (
        <div className={`editTimelineEntry ${entry.kind === "current" ? "current" : ""}`} key={`${entry.kind}:${entry.timestampMs ?? ""}:${index}`}>
          <div className="editTimelineHead">
            <span className="editTimelineLabel">{editTimelineLabel(entry.kind)}</span>
            <time>{formatDetailDateTime(entry.timestampMs)}</time>
          </div>
          {entry.text != null ? <p className="editTimelineText">{entry.text}</p> : <p className="editTimelineUnavailable">{entry.kind === "sent" ? "Original text was not retained" : "Text for this state was not retained"}</p>}
          {entry.source !== "archive" && <small className="timelineSource">Timestamp from {entry.source === "live" ? "live sync" : "the backup edit record"}</small>}
        </div>
      ))}
    </div>
  );
}

function editTimelineLabel(kind: MessageDetail["editTimeline"][number]["kind"]): string {
  if (kind === "sent") return "Original message sent";
  if (kind === "held_revision") return "Previous text";
  if (kind === "metadata_only_edit") return "Edit recorded";
  return "Current text after edit";
}

export function editHistoryPresentation(detail: MessageDetail | null): {
  sentAtMs: number | null;
  lastEditedMs: number | null;
  originalTextMissing: boolean;
  hasDistinctTimes: boolean;
} {
  const entries = detail?.editTimeline ?? [];
  const sent = entries.find((entry) => entry.kind === "sent") ?? null;
  const editTimes = entries.filter((entry) => entry.kind !== "sent").map((entry) => entry.timestampMs).filter((value): value is number => value != null && Number.isFinite(value));
  const lastEditedMs = editTimes.length ? Math.max(...editTimes) : null;
  return {
    sentAtMs: sent?.timestampMs ?? detail?.sentAtMs ?? null,
    lastEditedMs,
    originalTextMissing: Boolean(sent && sent.text == null),
    hasDistinctTimes: sent?.timestampMs != null && lastEditedMs != null && sent.timestampMs !== lastEditedMs
  };
}

function SourceObservationDisclosure({ observations }: { observations: ArchiveSignalObservation[] }) {
  if (observations.length === 0) return null;
  return (
    <details className="technicalDetails">
      <summary>{observations.length} source record{observations.length === 1 ? "" : "s"}</summary>
      <SourceObservationRows observations={observations} />
    </details>
  );
}

function SourceObservationRows({ observations }: { observations: ArchiveSignalObservation[] }) {
  if (observations.length === 0) return null;
  return (
    <div className="detailList">
      {observations.map((observation, index) => <DetailFieldGrid key={`${observation.source}:${observation.sourceEventKey}:${index}`} values={{ Source: observation.source === "live" ? "Live sync" : "Backup", Observed: formatDetailDateTime(observation.observedAtMs), "Capture version": observation.captureVersion, "Source event key": observation.sourceEventKey }} />)}
    </div>
  );
}

function formatRawPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function DetailFieldGrid({ values }: { values: Record<string, string | number | boolean | null | undefined> }) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return entries.length ? <dl className="detailFieldGrid">{entries.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{String(value)}</dd></Fragment>)}</dl> : <p className="detailEmpty">Not available from this source.</p>;
}

function formatOffset(value: number | null): string {
  if (value == null) return "Time unavailable";
  return `${value} ms`;
}

function formatSegmentTiming(startMs: number | null, endMs: number | null): string {
  if (startMs != null && endMs != null) return `${formatOffset(startMs)} – ${formatOffset(endMs)}`;
  if (startMs != null) return `At ${formatOffset(startMs)}`;
  if (endMs != null) return `Through ${formatOffset(endMs)}`;
  return "Timing unavailable";
}

function formatElapsed(startMs: number | null, endMs: number | null): string | null {
  if (startMs == null || endMs == null || endMs < startMs) return null;
  const seconds = Math.floor((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainingMinutes ? ` ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}` : ""}`;
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

// Modal timeline of a message's edits, oldest to newest, each version labeled
// with when it became the message's content.
function EditHistoryModal({ message, onClose }: { message: MessageListItem; onClose: () => void }) {
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Fetch fresh whenever the modal opens, and re-fetch when a live edit adds a
  // revision (the count changes) — so the history never shows a stale snapshot.
  // Kept in the modal (not cached on the bubble) so reopening always reloads.
  useEffect(() => {
    let cancelled = false;
    getMessageDetail(message.id)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
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
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);
  const timeline = detail?.editTimeline ?? null;
  const presentation = editHistoryPresentation(detail);
  return createPortal(
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-label="Message edit history" onClick={onClose}>
      <section className="editHistoryModal" onClick={(event) => event.stopPropagation()}>
        <div className="editHistoryModalHeader">
          <div>
            <span className="eyebrow">
              <History size={14} />
              Edited message
            </span>
            <h2>{timeline ? "Edit details" : "Loading…"}</h2>
            {timeline && <p className="editFactLine"><span>Sent {formatDetailDateTime(presentation.sentAtMs)}</span><ArrowRight size={13} /><span>{presentation.lastEditedMs == null ? "Edit time unavailable" : `Edit recorded ${formatDetailDateTime(presentation.lastEditedMs)}`}</span></p>}
          </div>
          <button ref={closeButtonRef} className="iconButton" type="button" onClick={onClose} aria-label="Close edit history">
            <X size={16} />
          </button>
        </div>
        <div className="editHistoryBody">
          {timeline == null ? (
            <div className="editTimelineLoading">
              <Loader2 className="spin" size={18} />
              Loading history…
            </div>
          ) : (
            <>
              {presentation.originalTextMissing && <p className="detailNotice neutral editHistoryNotice">WhatsApp preserved a separate edit record, so the edit is certain. This backup did not retain the original text.</p>}
              {!presentation.hasDistinctTimes && presentation.lastEditedMs == null && <p className="detailNotice neutral editHistoryNotice">The source proves an edit occurred but did not provide a trustworthy edit time. The sent time is never reused as the edit time.</p>}
              <EditTimeline entries={timeline} />
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
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
    !message.isDeleted &&
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

function formatDetailDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours ? `${hours} hr` : null,
    minutes ? `${minutes} min` : null,
    seconds || (!hours && !minutes) ? `${seconds} sec` : null
  ].filter(Boolean).join(" ");
}

function isSystemEvent(message: MessageListItem): boolean {
  if (message.isDeleted || message.messageType === "revoked") return false;
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
  if (ms == null || !Number.isFinite(ms)) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// Focused detail views show seconds and the year. This keeps distinct source
// facts visibly distinct even when WhatsApp recorded them within one minute.
function formatDetailDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
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
  formatDetailDateTime,
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
