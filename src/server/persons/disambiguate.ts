// Render-time disambiguation (identity-and-naming-integrity): when one
// surface presents the same display label for entries that resolve to
// DIFFERENT persons, each colliding label gains a deterministic suffix so
// same-named people are visually distinct everywhere they appear together.
// Entries belonging to the same person never disambiguate against each other.
// This is a read-path concern over the labels being presented — stored names
// are never rewritten, and evidence-pack pack-local suffixes are a separate
// mechanism (extraction must be reproducible from the pack alone).

import { displayPhoneFromJid, formatE164 } from "../import/jid";

export interface DisambiguationEntry {
  label: string | null;
  // Person key: person id when the identity is a member, else the jid itself.
  personKey: string;
  jid: string | null;
  phoneNumber?: string | null;
  // Optional short context (e.g. a shared-chat title) used when no complete
  // number exists for the entry.
  contextLabel?: string | null;
}

// Returns the disambiguated label for each entry, index-aligned with the
// input. Suffix preference: the complete +E.164 number (never masked or
// partial, per the display-identity rules), else the provided short context,
// else a stable ordinal derived from the colliding group's jid order.
export function disambiguateLabels(entries: DisambiguationEntry[]): Array<string | null> {
  const byLabel = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const label = entry.label?.trim();
    if (!label) {
      return;
    }
    byLabel.set(label, [...(byLabel.get(label) ?? []), index]);
  });
  const output = entries.map((entry) => entry.label);
  for (const indices of byLabel.values()) {
    const personKeys = new Set(indices.map((index) => entries[index].personKey));
    if (personKeys.size < 2) {
      continue;
    }
    // Stable ordinal fallback: order colliding person keys deterministically.
    const ordinal = new Map([...personKeys].sort().map((key, position) => [key, position + 1]));
    for (const index of indices) {
      const entry = entries[index];
      const phone = formatE164(entry.phoneNumber) ?? displayPhoneFromJid(entry.jid);
      const suffix = phone ?? entry.contextLabel?.trim() ?? `#${ordinal.get(entry.personKey)}`;
      output[index] = `${entry.label} (${suffix})`;
    }
  }
  return output;
}
