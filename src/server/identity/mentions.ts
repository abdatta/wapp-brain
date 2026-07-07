// WhatsApp stores mentions in message text as "@<user-part>" where the user
// part is the numeric local part of the mentioned JID (phone or LID digits).
// Display-time resolution swaps them for names; stored content is never touched.

const MENTION_TOKEN = /@(\d{5,20})/g;

export function extractMentionDigits(texts: Array<string | null | undefined>): Set<string> {
  const digits = new Set<string>();
  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(MENTION_TOKEN)) {
      digits.add(match[1]);
    }
  }
  return digits;
}

// Candidate JIDs a mention's digits may refer to; callers canonicalize each
// through identity links before contact lookup.
export function mentionJidCandidates(digits: string): string[] {
  return [`${digits}@s.whatsapp.net`, `${digits}@lid`];
}

export function applyMentionLabels(text: string | null, labels: Map<string, string>): string | null {
  if (!text || labels.size === 0) {
    return text;
  }
  return text.replace(MENTION_TOKEN, (token, digits: string) => {
    const label = labels.get(digits);
    return label ? `@${label}` : token;
  });
}

// The resolved labels substituted into this message's texts, so the UI can
// find and highlight the exact "@<label>" spans in the displayed string.
export function appliedMentionLabels(
  texts: Array<string | null | undefined>,
  labels: Map<string, string>
): string[] {
  if (labels.size === 0) {
    return [];
  }
  const applied = new Set<string>();
  for (const digits of extractMentionDigits(texts)) {
    const label = labels.get(digits);
    if (label) {
      applied.add(label);
    }
  }
  return [...applied];
}
