export function normalizeTimestampMs(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric < 10_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
}

// Android msgstore type codes. Codes beyond the classic set were confirmed one
// by one against real examples on the user's phone (worksheet, 2026-07-07);
// unconfirmed codes stay unknown_<code> — mappings are never guessed.
export function messageTypeFromCode(value: unknown): string {
  if (value == null || value === "") {
    return "text";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value).toLowerCase() || "unknown";
  }
  switch (numeric) {
    case 0:
      return "text";
    case 1:
      return "image";
    case 2:
      return "audio";
    case 3:
      return "video";
    case 4:
    case 14:
      return "contact";
    case 5:
      return "location";
    case 7:
    case 36: // disappearing-message timer change
      return "system";
    case 8: // legacy audio/video call per forensic documentation (whapa); zero rows in the current archive
      return "call";
    case 9:
      return "document";
    case 10: // verified: every row joins missed_call_logs
      return "missed_call";
    case 11:
      return "waiting_for_message";
    case 13:
      return "gif";
    case 15: // verified: every row joins message_revoked ("deleted for everyone"), none carry sticker media
      return "revoked";
    case 16:
      return "live_location";
    case 20: // verified: all rows carry image/webp sticker media, none reference message_product
      return "sticker";
    case 24:
      return "group_invite";
    case 25: // image + action buttons
    case 26: // document + action buttons
    case 27: // text + action buttons
    case 28: // video + action buttons
    case 32: // flow follow-up after selecting an option
    case 49: // quick-reply buttons
    case 55: // single URL button
    case 57: // image + link + action buttons
    case 62: // video + text + action buttons
      return "template";
    case 42:
      return "view_once_image";
    case 43:
      return "view_once_video";
    case 45: // choose-one option menu
    case 46: // button opening multiple-choice options
      return "list";
    case 51:
      return "payment_invite";
    case 64:
      return "admin_revoked";
    case 66:
      return "poll";
    case 82: // verified: opus voice-note media joined to message_view_once_media (the 42/43 view-once family)
      return "view_once_audio";
    case 88: // verified: 1:1 join with message_bot_feedback (thumbs up/down on an AI response)
      return "bot_feedback";
    case 90: // verified: every row joins message_call_log — call entries, not status posts
      return "call";
    case 92:
      return "event";
    case 99:
      return "album";
    case 103:
      return "status_mention";
    case 118:
      return "history_share";
    default:
      return `unknown_${numeric}`;
  }
}

const MEDIA_MESSAGE_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "gif",
  "view_once_image",
  "view_once_video",
  "view_once_audio",
  "album",
  "product"
]);

export function isMediaMessageType(messageType: string): boolean {
  return MEDIA_MESSAGE_TYPES.has(messageType);
}

export function directionFromFromMe(fromMe: unknown, messageType: string): "incoming" | "outgoing" | "system" | "unknown" {
  if (messageType === "system") {
    return "system";
  }
  if (fromMe === 1 || fromMe === true || fromMe === "1") {
    return "outgoing";
  }
  if (fromMe === 0 || fromMe === false || fromMe === "0") {
    return "incoming";
  }
  return "unknown";
}

export function boolish(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
