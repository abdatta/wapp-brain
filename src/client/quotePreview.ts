import type { MessageListItem, QuotedMessageSnapshotSummary } from "../shared/types";
import { quotedSnapshotThumbnailUrl } from "./api";

export interface QuotePreviewModel {
  sender: string;
  text: string;
  isLong: boolean;
  thumbnailUrl: string | null;
  jumpMessageId: number | null;
}

export function quotePreviewText(quote: QuotedMessageSnapshotSummary): string {
  if (quote.body) return quote.body;
  if (quote.caption) return quote.caption;
  if (quote.location) return quote.location.name || quote.location.address || "Location";
  if (quote.vcard) return quote.vcard.name || "Contact card";
  return quote.mediaName || quote.mediaMimeType || quote.messageType;
}

// Keep rendering decisions pure so backup-imported and live-synced summaries
// share exactly the same presentation contract before React owns local state.
export function quotePreviewModel(message: MessageListItem): QuotePreviewModel | null {
  const quote = message.quotedSnapshot;
  if (!quote) return null;
  return {
    sender: quote.quotedFromMe ? "You" : quote.quotedSenderDisplayName ?? "Unknown sender",
    text: quotePreviewText(quote),
    isLong: quotePreviewText(quote).length > 180,
    thumbnailUrl: quote.hasThumbnail ? quotedSnapshotThumbnailUrl(message.id) : null,
    jumpMessageId: quote.originalMessageId ?? null
  };
}
