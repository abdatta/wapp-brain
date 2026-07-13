// Pure helpers for the chat/thread deep-link contract. The thread view is
// addressable as `/chats/:id`, and a specific message within it as
// `/chats/:id?at=<messageId>` (a search hit or a shared/reloaded link). Kept
// pure and DOM-free so they can be unit-tested under Node with the rest of the
// suite.

export function buildChatDeepLink(chatId: number, anchorId?: number | null): string {
  const base = `/chats/${chatId}`;
  return anchorId != null && Number.isInteger(anchorId) && anchorId > 0 ? `${base}?at=${anchorId}` : base;
}

// Reads the `?at=` anchor from a URLSearchParams-like value. Returns a positive
// integer message id, or null when absent/invalid (so a garbage `?at=` never
// triggers a context-window fetch).
export function parseAnchorParam(searchParams: { get(name: string): string | null }): number | null {
  const raw = searchParams.get("at");
  if (raw == null || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}
