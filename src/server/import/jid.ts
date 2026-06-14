import type { ChatType } from "../../shared/types";

export function normalizeJid(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  if (raw.includes("@")) {
    return raw;
  }
  if (/^\d+$/.test(raw)) {
    return `${raw}@s.whatsapp.net`;
  }
  return raw;
}

export function inferChatType(jid: string | null | undefined): ChatType {
  if (!jid) {
    return "unknown";
  }
  if (jid === "status@broadcast") {
    return "status";
  }
  if (jid.endsWith("@g.us")) {
    return "group";
  }
  if (jid.endsWith("@broadcast")) {
    return "broadcast";
  }
  if (jid.endsWith("@newsletter")) {
    return "community";
  }
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us")) {
    return "dm";
  }
  return "unknown";
}

export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  const user = jid.split("@")[0];
  return /^\d+$/.test(user) ? user : null;
}

export function displayFromJid(jid: string | null | undefined): string {
  if (!jid) {
    return "Unknown";
  }
  const phone = phoneFromJid(jid);
  return phone ?? jid;
}
