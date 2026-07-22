// Vault file naming (semantic-rollups). The vault is read in Obsidian, where
// the FILE NAME is the note title in the explorer, the graph, and link
// autocomplete — so names must be readable first, unique second.
//
// Two constraints make "just use the name" impossible:
//   - display names collide hard (7 different chats are named "Supratik" in
//     the real archive), and 127 chats with episodes have no name at all;
//   - names are user text: they carry `/`, `?`, `:` and other characters
//     Windows forbids in a path, plus CJK and emoji (which are legal, and
//     worth keeping — they are the readable part).
// So every name carries a stable machine id, and the label is sanitized.
//
// This module is the ONE definition. The episode formula previously lived in
// four places (episode commit, bulk projection, and both repositories' claim
// wikilink metadata); a drift between any of them silently produces dangling
// Obsidian links.

// Windows forbids these outright. Dashes, parentheses, and non-ASCII (CJK,
// emoji, accents) are legal and stay — they carry the readability.
const ILLEGAL_PUNCTUATION = /[<>:"/\\|?*]/g;
// Reserved device names, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Long enough for real chat names (the archive's longest is 45) while leaving
// room for the date and id within a sane total path length.
const MAX_LABEL = 60;

// Control characters break every tool that touches a path. Filtered by code
// point rather than a regex escape range, so the source stays free of literal
// control bytes.
function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : character;
  }
  return out;
}

export function sanitizeVaultLabel(raw: string | null | undefined, fallback: string): string {
  const cleaned = stripControlCharacters(raw ?? "")
    .replace(ILLEGAL_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL)
    // Windows silently drops trailing dots and spaces — do it ourselves so the
    // name we write is the name we can find again.
    .replace(/[. ]+$/g, "");
  if (!cleaned) {
    return fallback;
  }
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

// A chat with no display name still needs a stable, recognizable label: its
// own address, minus the routing suffix.
export function chatFallbackLabel(chatSourceId: string): string {
  const local = chatSourceId.split("@")[0] ?? chatSourceId;
  return sanitizeVaultLabel(local, "unknown chat");
}

export function episodeShortId(episodeId: string): string {
  return episodeId.slice(0, 8);
}

// `A03 BATCH FIITJEE 2014-07-21 2796c25e` — chat label first so a flat,
// alphabetically-sorted folder groups every episode of a chat together; the
// ISO date second so they read as that chat's timeline; the id last, where
// name truncation eats it harmlessly.
export function episodeFileBase(episode: {
  id: string;
  startAtMs: number;
  chatSourceId: string;
  chatDisplayName: string | null;
}): string {
  const day = new Date(episode.startAtMs).toISOString().slice(0, 10);
  const label = sanitizeVaultLabel(episode.chatDisplayName, chatFallbackLabel(episode.chatSourceId));
  return `${label} ${day} ${episodeShortId(episode.id)}`;
}

// `Supratik (person-919088460418)` — the slug is immutable and already path
// safe, so it is both the discriminator and the key a stale-file sweep uses
// after a rename changes the readable part.
export function docFileBase(title: string, slug: string): string {
  return `${sanitizeVaultLabel(title, slug)} (${slug})`;
}

// Does this file belong to this episode, whatever its label says? Matches the
// id anywhere so a file written under the pre-rename (or pre-convention) name
// is still recognized as the same episode's stale copy.
export function episodeFileMatchesId(fileName: string, episodeId: string): boolean {
  return fileName.endsWith(".md") && fileName.includes(episodeShortId(episodeId));
}

export function docFileMatchesSlug(fileName: string, slug: string): boolean {
  return fileName.endsWith(` (${slug}).md`);
}
