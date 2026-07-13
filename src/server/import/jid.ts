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

// The last two digits of a phone number, obfuscated in the middle by a run of
// bullet/dot mask glyphs — the family WhatsApp uses for a masked number across
// locales/builds. Matched as a set so a new glyph is an additive one-line
// change here.
const MASK_GLYPHS = ["∙", "•", "·", "‧", "."] as const; // ∙ • · ‧ and ASCII '.'
const MASKED_NUMBER_RE = new RegExp(`^\\+?[0-9${MASK_GLYPHS.map((g) => `\\${g}`).join("")}]+$`);

// WhatsApp stores a MASKED number as the display name for any contact not in
// your address book: a country code, a run of mask glyphs, then the last two
// digits — e.g. "+91∙∙∙∙∙∙∙∙86". That is neither a saved name nor a usable
// number, so it must never win the display chain. Recognize it positively:
// ignoring a leading '+' and spaces the whole string is digits + mask glyphs
// AND contains at least one mask glyph. Any letter disqualifies it, so a real
// name (even one with a stray dot) is never mistaken for a mask, and a full or
// partial real number (no mask glyph) is never a false positive.
export function isMaskedNumberLabel(value: string | null | undefined): boolean {
  if (value == null) {
    return false;
  }
  const compact = String(value).replace(/\s+/g, "");
  if (!compact || !MASKED_NUMBER_RE.test(compact)) {
    return false;
  }
  return MASK_GLYPHS.some((glyph) => compact.includes(glyph));
}

// Stored phone digits → a display +E.164 number: strip any '+', spaces, or
// separators and re-add a single leading '+'. Null for an empty/non-numeric
// value (so it can be the last term in a display-chain fallback).
export function formatE164(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const digits = String(value).replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

// Phone digits from a phone-addressed JID only, rendered as +E.164. LID, group,
// and broadcast ids are numeric but are NOT phone numbers, so they return null
// (an honest unresolved state upstream), never a fabricated number.
export function displayPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  const [user, server] = jid.split("@");
  if (server !== "s.whatsapp.net" && server !== "c.us") {
    return null;
  }
  return formatE164(user?.split(":")[0] ?? null);
}

// The Human-Readable Display Identity chain in one place: saved name → push
// name → the complete +E.164 number (from a stored phone record, else derived
// from a phone-form JID) → null (unresolved). A masked-number placeholder in
// either name slot is treated as absent, so it can never shadow the real
// number or a name learned later.
export function resolveDisplayLabel(identity: {
  displayName?: string | null;
  pushName?: string | null;
  phoneNumber?: string | null;
  jid?: string | null;
}): string | null {
  const name = identity.displayName?.trim();
  if (name && !isMaskedNumberLabel(name)) {
    return name;
  }
  const push = identity.pushName?.trim();
  if (push && !isMaskedNumberLabel(push)) {
    return push;
  }
  return formatE164(identity.phoneNumber) ?? displayPhoneFromJid(identity.jid ?? null);
}
