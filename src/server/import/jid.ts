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
    const [rawUser, rawServer] = raw.split("@", 2);
    const server = rawServer === "c.us" ? "s.whatsapp.net" : rawServer;
    if (!rawUser || !server) {
      return raw;
    }
    if (server === "s.whatsapp.net" || server === "lid" || server === "hosted.lid") {
      const user = normalizeUserPart(rawUser);
      return user ? `${user}@${server}` : raw;
    }
    return `${rawUser}@${server}`;
  }
  const user = normalizeUserPart(raw);
  if (user && /^\d+$/.test(user)) {
    return `${user}@s.whatsapp.net`;
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
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us") || jid.endsWith("@lid") || jid.endsWith("@hosted.lid")) {
    return "dm";
  }
  return "unknown";
}

export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  // Only phone-addressed servers carry real phone numbers; LID, group, and
  // broadcast identifiers are numeric but are NOT phone numbers.
  const [rawUser, server] = jid.split("@");
  if (server !== "s.whatsapp.net" && server !== "c.us") {
    return null;
  }
  const user = normalizeUserPart(rawUser);
  return /^\d+$/.test(user) ? user : null;
}

function normalizeUserPart(user: string): string {
  return user.replace(/^(\d+)\.0(?=(:|$))/, "$1").replace(/:\d+$/, "");
}
