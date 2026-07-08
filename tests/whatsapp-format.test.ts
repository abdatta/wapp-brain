import { describe, expect, it } from "vitest";
import { parseInlineSegments, parseWhatsAppBlocks, type Block, type InlineSegment } from "../src/client/whatsappFormat";

// Compact serialization of a segment tree for readable assertions.
function serialize(segments: InlineSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.type) {
        case "text":
          return segment.value;
        case "url":
          return `[url:${segment.value}]`;
        case "code":
          return `[code:${segment.value}]`;
        default:
          return `[${segment.type}:${serialize(segment.children)}]`;
      }
    })
    .join("");
}

function serializeBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "bullet" || block.type === "numbered") {
        return `<${block.type}>${block.items.map((item) => `{${serialize(item)}}`).join("")}`;
      }
      return `<${block.type}>${block.lines.map((line) => `{${serialize(line)}}`).join("")}`;
    })
    .join("");
}

describe("WhatsApp inline formatting", () => {
  it("parses bold, italic, strikethrough, inline code and monospace", () => {
    expect(serialize(parseInlineSegments("*bold*"))).toBe("[bold:bold]");
    expect(serialize(parseInlineSegments("_italic_"))).toBe("[italic:italic]");
    expect(serialize(parseInlineSegments("~strike~"))).toBe("[strike:strike]");
    expect(serialize(parseInlineSegments("`code`"))).toBe("[code:code]");
    expect(serialize(parseInlineSegments("```mono```"))).toBe("[code:mono]");
  });

  it("handles the full mixed example, and monospace stays literal", () => {
    const text = "Hmm, ~this is interesting~, _does this_ *NOT* ```do other formatting``` ?!";
    expect(serialize(parseInlineSegments(text))).toBe(
      "Hmm, [strike:this is interesting], [italic:does this] [bold:NOT] [code:do other formatting] ?!"
    );
    // Nothing inside the monospace is treated as bold/italic.
    expect(serialize(parseInlineSegments("```a *b* _c_```"))).toBe("[code:a *b* _c_]");
  });

  it("nests formatting", () => {
    expect(serialize(parseInlineSegments("*_bold italic_*"))).toBe("[bold:[italic:bold italic]]");
    expect(serialize(parseInlineSegments("~*_all three_*~"))).toBe("[strike:[bold:[italic:all three]]]");
  });

  it("leaves non-formatting punctuation alone", () => {
    // snake_case and math must not become italic/bold.
    expect(serialize(parseInlineSegments("call foo_bar_baz now"))).toBe("call foo_bar_baz now");
    expect(serialize(parseInlineSegments("2*3*4 = 24"))).toBe("2*3*4 = 24");
    // Spaced markers are literal, not empty spans.
    expect(serialize(parseInlineSegments("a * b * c"))).toBe("a * b * c");
    expect(serialize(parseInlineSegments("**"))).toBe("**");
  });

  it("keeps URLs atomic so underscores inside them are not italic", () => {
    expect(serialize(parseInlineSegments("see https://example.com/a_b_c here"))).toBe(
      "see [url:https://example.com/a_b_c] here"
    );
    // A link inside bold stays a link.
    expect(serialize(parseInlineSegments("*go https://x.com now*"))).toBe("[bold:go [url:https://x.com] now]");
  });
});

describe("WhatsApp block formatting", () => {
  it("parses quotes, bulleted and numbered lists with inline formatting inside", () => {
    expect(serializeBlocks(parseWhatsAppBlocks("> quoted *bold*"))).toBe("<quote>{quoted [bold:bold]}");
    expect(serializeBlocks(parseWhatsAppBlocks("- one\n- _two_"))).toBe("<bullet>{one}{[italic:two]}");
    expect(serializeBlocks(parseWhatsAppBlocks("* first\n* second"))).toBe("<bullet>{first}{second}");
    expect(serializeBlocks(parseWhatsAppBlocks("1. alpha\n2. beta"))).toBe("<numbered>{alpha}{beta}");
  });

  it("keeps a bold line as a paragraph, and a bullet line as a list", () => {
    // "*bold*" (no space after *) is bold text, not a bullet.
    expect(serializeBlocks(parseWhatsAppBlocks("*bold*"))).toBe("<paragraph>{[bold:bold]}");
    // "* item" (space after *) is a bullet.
    expect(serializeBlocks(parseWhatsAppBlocks("* item"))).toBe("<bullet>{item}");
  });

  it("groups consecutive plain lines into one paragraph", () => {
    expect(serializeBlocks(parseWhatsAppBlocks("line one\nline two"))).toBe("<paragraph>{line one}{line two}");
  });
});
