// Owner self-number normalization (brain-run-console): shared by both
// repositories so validation cannot drift. Accepts a bare number (8–15 digits,
// optional +/spaces/dashes/parens) or an identity-server JID; everything else
// is rejected with a message naming the offending value.

import { normalizeJid } from "../import/jid";

export function normalizeOwnerSelfInput(raw: string): { jid: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "An empty value is not a number." };
  }
  if (trimmed.includes("@")) {
    const normalized = normalizeJid(trimmed);
    if (
      normalized &&
      (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid") || normalized.endsWith("@hosted.lid"))
    ) {
      return { jid: normalized };
    }
    return { error: `"${trimmed}" is not an identity JID (groups and broadcasts cannot be you).` };
  }
  const digits = trimmed.replace(/[\s\-().+]/g, "");
  if (!/^\d{8,15}$/.test(digits)) {
    return { error: `"${trimmed}" is not a valid number — use 8–15 digits (optional +, spaces, dashes).` };
  }
  return { jid: `${digits}@s.whatsapp.net` };
}
