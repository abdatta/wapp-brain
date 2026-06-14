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
      return "contact";
    case 5:
      return "location";
    case 7:
      return "system";
    case 8:
      return "audio";
    case 9:
      return "document";
    case 10:
      return "call";
    case 13:
      return "gif";
    case 15:
      return "sticker";
    case 16:
      return "live_location";
    case 20:
      return "product";
    case 90:
      return "status";
    default:
      return `unknown_${numeric}`;
  }
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
