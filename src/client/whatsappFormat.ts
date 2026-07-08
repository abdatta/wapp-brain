// WhatsApp text formatting parser. Pure (no React) so it is unit-testable; the
// client turns the returned tree into elements. Mirrors WhatsApp's rules:
//   *bold*  _italic_  ~strikethrough~  `inline code`  ```monospace```
//   > quote   - / * bulleted list   1. numbered list
// Inline markers must hug non-space content and sit at a boundary (so
// snake_case and 2*3*4 are left alone), formatting nests, and code/monospace
// content is literal (no formatting inside). URLs are atomic tokens so a `_`
// inside a link never becomes italic.

export type InlineSegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; children: InlineSegment[] }
  | { type: "italic"; children: InlineSegment[] }
  | { type: "strike"; children: InlineSegment[] };

export type Block =
  | { type: "paragraph"; lines: InlineSegment[][] }
  | { type: "quote"; lines: InlineSegment[][] }
  | { type: "bullet"; items: InlineSegment[][] }
  | { type: "numbered"; items: InlineSegment[][] };

// Sticky URL matcher, anchored at the scan position.
const URL_AT = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|www\.[^\s<>()]+[^\s<>().,;:!?'"])/y;
const MARKERS: Record<string, "bold" | "italic" | "strike"> = { "*": "bold", "_": "italic", "~": "strike" };
const QUOTE_LINE = /^>\s?/;
const BULLET_LINE = /^[*-]\s+/;
const NUMBERED_LINE = /^\d+\.\s+/;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

export function parseInlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      segments.push({ type: "text", value: buffer });
      buffer = "";
    }
  };
  let index = 0;
  while (index < text.length) {
    // Monospace ```...``` — literal content, highest priority.
    if (text.startsWith("```", index)) {
      const end = text.indexOf("```", index + 3);
      if (end !== -1) {
        flush();
        segments.push({ type: "code", value: text.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
    }
    // Inline code `...` — literal content.
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        segments.push({ type: "code", value: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    // URLs are atomic: markers inside them are part of the link, not formatting.
    URL_AT.lastIndex = index;
    const url = URL_AT.exec(text);
    if (url) {
      flush();
      segments.push({ type: "url", value: url[0] });
      index += url[0].length;
      continue;
    }
    // Bold / italic / strikethrough, with nesting.
    const type = MARKERS[text[index]];
    if (type) {
      const close = findClosingMarker(text, index);
      if (close !== -1) {
        flush();
        segments.push({ type, children: parseInlineSegments(text.slice(index + 1, close)) });
        index = close + 1;
        continue;
      }
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return segments;
}

// The matching close for a marker opened at `open`, or -1. The opener must sit
// at a boundary (not preceded by a letter/digit) and be followed by non-space;
// the closer must be preceded by non-space and followed by a boundary. This is
// what keeps snake_case, 2*3*4, and "* bullet" from being treated as spans.
function findClosingMarker(text: string, open: number): number {
  const marker = text[open];
  const before = text[open - 1];
  const after = text[open + 1];
  if (isAlnum(before) || after === undefined || /\s/.test(after)) {
    return -1;
  }
  for (let k = open + 2; k < text.length; k += 1) {
    if (text[k] !== marker) {
      continue;
    }
    if (!/\s/.test(text[k - 1]) && !isAlnum(text[k + 1])) {
      return k;
    }
  }
  return -1;
}

export function parseWhatsAppBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (QUOTE_LINE.test(line)) {
      const collected: InlineSegment[][] = [];
      while (index < lines.length && QUOTE_LINE.test(lines[index])) {
        collected.push(parseInlineSegments(lines[index].replace(QUOTE_LINE, "")));
        index += 1;
      }
      blocks.push({ type: "quote", lines: collected });
      continue;
    }
    if (BULLET_LINE.test(line)) {
      const collected: InlineSegment[][] = [];
      while (index < lines.length && BULLET_LINE.test(lines[index])) {
        collected.push(parseInlineSegments(lines[index].replace(BULLET_LINE, "")));
        index += 1;
      }
      blocks.push({ type: "bullet", items: collected });
      continue;
    }
    if (NUMBERED_LINE.test(line)) {
      const collected: InlineSegment[][] = [];
      while (index < lines.length && NUMBERED_LINE.test(lines[index])) {
        collected.push(parseInlineSegments(lines[index].replace(NUMBERED_LINE, "")));
        index += 1;
      }
      blocks.push({ type: "numbered", items: collected });
      continue;
    }
    const collected: InlineSegment[][] = [];
    while (
      index < lines.length &&
      !QUOTE_LINE.test(lines[index]) &&
      !BULLET_LINE.test(lines[index]) &&
      !NUMBERED_LINE.test(lines[index])
    ) {
      collected.push(parseInlineSegments(lines[index]));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: collected });
  }
  return blocks;
}
