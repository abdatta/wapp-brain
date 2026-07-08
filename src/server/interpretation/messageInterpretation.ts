// One source of truth for what a message *is* when its body cannot speak for
// itself: a human label naming the kind, plus a reason when the content is
// genuinely unreadable. Every consumer — thread view, second-brain evidence,
// search indexing, future MCP/agent surfaces — reads this instead of
// reimplementing string logic. A bare "Unsupported message" is never produced,
// and media availability is reported honestly: no "not kept" claim when the
// bytes are stored, and a specific reason when they are not.

import type { MediaAvailabilityState } from "../../shared/types";

export interface MessageInterpretation {
  label: string;
  reason: string | null;
}

const TYPE_LABELS: Record<string, MessageInterpretation> = {
  image: { label: "Photo", reason: null },
  video: { label: "Video", reason: null },
  audio: { label: "Audio message", reason: null },
  document: { label: "Document", reason: null },
  sticker: { label: "Sticker", reason: null },
  gif: { label: "GIF", reason: null },
  contact: { label: "Contact card", reason: null },
  location: { label: "Location", reason: null },
  live_location: { label: "Live location", reason: null },
  call: { label: "Call", reason: null },
  missed_call: { label: "Missed call", reason: null },
  revoked: { label: "Deleted message", reason: null },
  product: { label: "Product", reason: null },
  status: { label: "Status event", reason: null },
  system: { label: "System event", reason: null },
  reaction: { label: "Reaction", reason: null },
  poll: { label: "Poll", reason: null },
  event: { label: "Event", reason: null },
  album: { label: "Photo album", reason: null },
  template: { label: "Business message", reason: null },
  interactive: { label: "Business message", reason: null },
  list: { label: "Business message with options", reason: null },
  list_response: { label: "Selected an option", reason: null },
  group_invite: { label: "Group invite", reason: null },
  payment_invite: { label: "Payment invite", reason: null },
  status_mention: { label: "Mentioned in a status", reason: null },
  bot_feedback: { label: "Feedback on an AI response", reason: null },
  history_share: { label: "Shared message history", reason: null },
  view_once_image: { label: "View once photo", reason: null },
  view_once_video: { label: "View once video", reason: null },
  view_once_audio: { label: "View once voice message", reason: null },
  // Live view-once whose content WhatsApp withheld from linked devices: the
  // envelope arrives explicitly marked unavailable, with no ciphertext, so
  // there was never anything to capture. Platform reality, stated honestly.
  view_once: {
    label: "View once media",
    reason: "WhatsApp delivers view-once content only to your phone; linked devices never receive it."
  },
  waiting_for_message: {
    label: "Waiting for this message",
    reason: "The phone never received or decrypted it; it never became readable."
  },
  admin_revoked: { label: "Deleted by a group admin", reason: null },
  encrypted_update: {
    label: "Encrypted edit of an earlier message",
    reason: "Encrypted with a key the archive does not hold."
  }
};

// Honest per-availability reasons for media whose bytes are not present.
// `stored` intentionally maps to no reason — the media is right there.
const MEDIA_AVAILABILITY_REASONS: Record<Exclude<MediaAvailabilityState, "stored">, string> = {
  pending: "Media download is queued.",
  downloading: "Media is downloading.",
  expired_unrecoverable: "The media could not be recovered before its link expired.",
  not_captured: "The media arrived while the archive was offline and was not captured.",
  import_missing: "The media file was not found in the imported media folder."
};

export function interpretMessage(input: {
  messageType: string;
  isDeleted?: boolean;
  // True when the archive holds content for this message (text, caption, or
  // stored media) — deleted messages with held content keep it visible.
  hasHeldContent?: boolean;
  mediaAvailability?: MediaAvailabilityState | null;
}): MessageInterpretation | null {
  if (input.isDeleted && !input.hasHeldContent) {
    return input.messageType === "admin_revoked" ? TYPE_LABELS.admin_revoked : { label: "Deleted message", reason: null };
  }
  // Deleted with held content falls through: the content (and its media
  // availability) speaks for itself; the deleted state rides on the record so
  // consumers can decorate it.
  if (input.messageType === "text") {
    return null;
  }
  const known = TYPE_LABELS[input.messageType];
  if (known) {
    return input.mediaAvailability ? withMediaReason(known, input.mediaAvailability) : known;
  }
  if (input.messageType.startsWith("unknown")) {
    const code = input.messageType.replace(/^unknown_?/, "");
    return {
      label: "Legacy message",
      reason: code ? `Unrecognized message type (${code}); kept exactly as stored.` : "Unrecognized message type; kept exactly as stored."
    };
  }
  const fallback = { label: `${humanizeType(input.messageType)} message`, reason: null };
  return input.mediaAvailability ? withMediaReason(fallback, input.mediaAvailability) : fallback;
}

function withMediaReason(base: MessageInterpretation, availability: MediaAvailabilityState): MessageInterpretation {
  if (availability === "stored") {
    return { label: base.label, reason: null };
  }
  return { label: base.label, reason: MEDIA_AVAILABILITY_REASONS[availability] };
}

function humanizeType(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
