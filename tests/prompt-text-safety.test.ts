import { afterEach, describe, expect, it, vi } from "vitest";
import { hasLoneSurrogate, toWellFormedText, truncateOnGraphemeBoundary } from "../src/server/text";
import { wellFormedRequest } from "../src/server/brain/provider";

// Fixtures named by what they exercise, so a failure reads as a defect class.
const PRAY = "\u{1F64F}"; // U+1F64F, one surrogate pair (2 code units)
const PRAY_LIGHT = "\u{1F64F}\u{1F3FB}"; // base + skin-tone modifier (4 code units)
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // ZWJ sequence (8 code units)
const DEVANAGARI = "को"; // क + ो (base consonant + matra)
const BENGALI = "কা"; // ক + া (base consonant + matra)

function loneSurrogateCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      count += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      count += 1;
    }
  }
  return count;
}

describe("truncateOnGraphemeBoundary", () => {
  it("returns text at or under the bound verbatim, with no marker", () => {
    expect(truncateOnGraphemeBoundary("hello", 10, "…")).toBe("hello");
    expect(truncateOnGraphemeBoundary("hello", 5, "…")).toBe("hello");
    expect(truncateOnGraphemeBoundary(`ok ${PRAY}`, 5)).toBe(`ok ${PRAY}`);
  });

  it("leaves ASCII truncation behaviour intact", () => {
    expect(truncateOnGraphemeBoundary("abcdefghij", 5)).toBe("abcde");
    expect(truncateOnGraphemeBoundary("abcdefghij", 5, "…")).toBe("abcd…");
  });

  it("never splits an astral emoji at the bound", () => {
    // The regression: a cut at 3 lands inside the pair starting at index 2.
    const value = `ab${PRAY}cd`;
    expect(value.slice(0, 3)).toSatisfy((cut: string) => loneSurrogateCount(cut) === 1);

    const result = truncateOnGraphemeBoundary(value, 3);
    expect(loneSurrogateCount(result)).toBe(0);
    expect(result).toBe("ab");
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("keeps an emoji ZWJ sequence whole or drops it entirely", () => {
    const value = `hi ${FAMILY} there`;
    for (let limit = 1; limit <= value.length; limit += 1) {
      const result = truncateOnGraphemeBoundary(value, limit);
      expect(loneSurrogateCount(result)).toBe(0);
      // A partial family (a lone parent, or a dangling joiner) must never appear.
      expect(result.includes(FAMILY) || !result.includes("‍")).toBe(true);
    }
  });

  it("keeps a skin-tone modifier attached to its base", () => {
    const value = `x${PRAY_LIGHT}y`;
    const result = truncateOnGraphemeBoundary(value, 3);
    expect(loneSurrogateCount(result)).toBe(0);
    expect(result).toBe("x");
  });

  it("never orphans an Indic combining matra", () => {
    for (const cluster of [DEVANAGARI, BENGALI]) {
      const value = `${cluster}${cluster}`;
      // Cutting at 1 would separate the base consonant from its matra.
      const result = truncateOnGraphemeBoundary(value, 1);
      expect(result).toBe("");
      expect(truncateOnGraphemeBoundary(value, 2)).toBe(cluster);
    }
  });

  it("never exceeds the bound, marker included, across a fuzz of cut points", () => {
    const value = `a${PRAY}b${FAMILY}c${DEVANAGARI}d${PRAY_LIGHT}e${BENGALI}f`;
    for (let limit = 1; limit <= value.length + 4; limit += 1) {
      for (const marker of ["", "…"]) {
        const result = truncateOnGraphemeBoundary(value, limit, marker);
        expect(result.length).toBeLessThanOrEqual(limit);
        expect(loneSurrogateCount(result)).toBe(0);
      }
    }
  });

  it("handles a degenerate bound without emitting an oversized marker", () => {
    expect(truncateOnGraphemeBoundary("abcdef", 1, "…")).toBe("…");
    expect(truncateOnGraphemeBoundary("abcdef", 0, "…")).toBe("");
  });

  it("stays correct when the straddling cluster sits far past the bound", () => {
    // Guards the bounded-head optimisation: only the head is segmented, so a
    // long run before the cut must not change the boundary decision.
    const value = `${"a".repeat(200)}${PRAY}tail`;
    const result = truncateOnGraphemeBoundary(value, 201);
    expect(loneSurrogateCount(result)).toBe(0);
    expect(result).toBe("a".repeat(200));
  });
});

describe("toWellFormedText", () => {
  it("replaces an unpaired high surrogate", () => {
    expect(toWellFormedText("ab\ud83dcd")).toBe("ab�cd");
  });

  it("replaces an unpaired low surrogate", () => {
    expect(toWellFormedText("ab\ude4fcd")).toBe("ab�cd");
  });

  it("leaves well-formed astral text byte-identical", () => {
    const value = `ok ${PRAY} ${FAMILY} ${PRAY_LIGHT}`;
    expect(toWellFormedText(value)).toBe(value);
  });

  it("leaves plain text byte-identical", () => {
    expect(toWellFormedText("nothing to do here")).toBe("nothing to do here");
  });

  it("matches the runtime's native toWellFormed where available", () => {
    const native = (String.prototype as unknown as { toWellFormed?: () => string }).toWellFormed;
    if (typeof native !== "function") {
      return; // older runtime: our implementation is the only path
    }
    for (const value of ["ab\ud83dcd", "ab\ude4fcd", `ok ${FAMILY}`, "\ud83d", "🙏", "plain"]) {
      expect(toWellFormedText(value)).toBe(native.call(value));
    }
  });
});

describe("provider well-formedness guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("repairs an unpaired surrogate before dispatch", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = wellFormedRequest({
      system: "you are a digester",
      user: "the quoted text ended mid-emoji \ud83d",
      maxOutputTokens: 100,
      purpose: "episode"
    });

    expect(hasLoneSurrogate(result.user)).toBe(false);
    expect(result.user).toBe("the quoted text ended mid-emoji �");
    expect(result.system).toBe("you are a digester");
    expect(errors).toHaveBeenCalledOnce();
  });

  it("passes well-formed astral text through byte-identically", () => {
    const request = {
      system: "you are a digester",
      user: `intact emoji ${PRAY} ${FAMILY}`,
      maxOutputTokens: 100,
      purpose: "episode"
    };
    // Same object reference: nothing was rewritten on the healthy path.
    expect(wellFormedRequest(request)).toBe(request);
  });

  it("logs the defect signal without leaking prompt content", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "meet me at the docks at midnight";
    wellFormedRequest({
      system: "system prompt",
      user: `${secret} \ud83d`,
      maxOutputTokens: 100,
      purpose: "episode"
    });

    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("system prompt");
    expect(logged).toContain("episode");
    expect(logged).toContain("1");
  });

  it("counts repairs across both system and user text", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    wellFormedRequest({
      system: "sys \ud83d tail",
      user: "user \ude4f and \ud83d again",
      maxOutputTokens: 100
    });
    expect(errors.mock.calls.flat().join(" ")).toContain("3");
  });

  it("labels an unlabelled call rather than omitting the purpose", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    wellFormedRequest({ system: "s", user: "u \ud83d", maxOutputTokens: 100 });
    expect(errors.mock.calls.flat().join(" ")).toContain("unlabelled");
  });
});

describe("hasLoneSurrogate", () => {
  it("detects unpaired surrogates and ignores well-formed pairs", () => {
    expect(hasLoneSurrogate("ab\ud83dcd")).toBe(true);
    expect(hasLoneSurrogate("ab\ude4fcd")).toBe(true);
    expect(hasLoneSurrogate(`ok ${PRAY}${FAMILY}`)).toBe(false);
    expect(hasLoneSurrogate("")).toBe(false);
  });

  it("agrees with toWellFormedText on whether a change is needed", () => {
    for (const value of ["ab\ud83dcd", `ok ${PRAY}`, "plain", "\ude4f"]) {
      expect(hasLoneSurrogate(value)).toBe(toWellFormedText(value) !== value);
    }
  });
});
