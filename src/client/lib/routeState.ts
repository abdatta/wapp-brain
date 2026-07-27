// The key for the route error boundary. A boundary normally resets whenever the
// route changes, which is right when you move between SURFACES — but wrong when
// you move WITHIN one.
//
// Keying on the full pathname remounted the entire surface on every in-surface
// navigation, discarding everything the page held: opening a chat from `/chats`
// reset the search box, the type filter, the event-only toggle, the muted fold,
// and the loaded chat list — so the chat just clicked was no longer in the list
// to resolve against, and its header rendered "Unresolved contact".
//
// The key is therefore the surface, not the record being viewed.
export function routeStateKey(pathname: string): string {
  const [first, second] = pathname.split("/").filter(Boolean);
  // The import wizard's sub-routes are one continuous setup flow, so they
  // deliberately share a boundary (preserving the wizard's in-memory state).
  if (first === "import") {
    return "/import";
  }
  // `/chats` and `/chats/:id` are one surface: the list IS the navigation.
  if (first === "chats") {
    return "/chats";
  }
  // Likewise the docs surface — `/brain/pages` and `/brain/pages/:docId`.
  if (first === "brain" && second === "pages") {
    return "/brain/pages";
  }
  return pathname;
}
