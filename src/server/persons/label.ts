import type { PersonMemberRecord } from "../../shared/types";

// A person's display label derives at read time from its primary member —
// the saved-name member with the highest message count, else the member with
// the highest message count (jid as the deterministic tiebreak). Never
// stored: storing a person name would create a second name authority, and
// nothing in the system groups by name.
export function personDisplayLabelFromMembers(members: PersonMemberRecord[]): string | null {
  const primary = primaryPersonMember(members);
  return primary?.displayLabel ?? null;
}

export function primaryPersonMember(members: PersonMemberRecord[]): PersonMemberRecord | null {
  if (members.length === 0) {
    return null;
  }
  const ranked = [...members].sort((a, b) => {
    if (a.hasSavedName !== b.hasSavedName) {
      return a.hasSavedName ? -1 : 1;
    }
    if (a.messageCount !== b.messageCount) {
      return b.messageCount - a.messageCount;
    }
    return a.identityJid.localeCompare(b.identityJid);
  });
  return ranked[0];
}
