// Canonical message identity: one WhatsApp message = one archive row, keyed by
// its canonical chat JID and WhatsApp message id (key_id) regardless of source
// (backup import, history sync, live delivery) or sender form (LID vs phone).
// Sender identity lives in columns only, so it can never fork message identity.

export function messageKey(chatSourceId: string, sourceMessageId: string): string {
  return ["wa", escapeKeyComponent(chatSourceId), escapeKeyComponent(sourceMessageId)].join("|");
}

export function messageIdFromKey(sourceMessageKey: string): string | null {
  if (!sourceMessageKey.startsWith("wa|")) {
    return null;
  }
  const parts = sourceMessageKey.split("|");
  return parts.length === 3 ? unescapeKeyComponent(parts[2]) || null : null;
}

export function chatFromKey(sourceMessageKey: string): string | null {
  if (!sourceMessageKey.startsWith("wa|")) {
    return null;
  }
  const parts = sourceMessageKey.split("|");
  return parts.length === 3 ? unescapeKeyComponent(parts[1]) || null : null;
}

// Surrogate for backup rows without a WhatsApp key_id (legacy schema edge).
// Scoped by a content fingerprint of the source file: idempotent across
// re-imports of the SAME backup, but two different backups can never collide
// on restarting rowids (different real messages must not share identity).
export function surrogateMessageId(adapter: string, sourceRowId: string, sourceFingerprint?: string | null): string {
  return sourceFingerprint ? `row:${adapter}:${sourceFingerprint}:${sourceRowId}` : `row:${adapter}:${sourceRowId}`;
}

// Message ids and JIDs are third-party-controlled; escape the delimiter
// injectively so distinct messages can never serialize to the same key.
export function escapeKeyComponent(value: string): string {
  return value.replace(/%/g, "%25").replace(/\|/g, "%7C");
}

export function unescapeKeyComponent(value: string): string {
  return value.replace(/%7C/g, "|").replace(/%25/g, "%");
}
