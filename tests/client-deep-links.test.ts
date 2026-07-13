import { describe, expect, it } from "vitest";
import { buildChatDeepLink, parseAnchorParam } from "../src/client/lib/deepLinks";

describe("chat deep links", () => {
  it("builds a plain thread link without an anchor", () => {
    expect(buildChatDeepLink(42)).toBe("/chats/42");
    expect(buildChatDeepLink(42, null)).toBe("/chats/42");
    expect(buildChatDeepLink(42, undefined)).toBe("/chats/42");
  });

  it("builds an anchored deep link when given a positive message id", () => {
    expect(buildChatDeepLink(42, 1007)).toBe("/chats/42?at=1007");
  });

  it("omits the anchor for non-positive or non-integer ids", () => {
    expect(buildChatDeepLink(42, 0)).toBe("/chats/42");
    expect(buildChatDeepLink(42, -5)).toBe("/chats/42");
    expect(buildChatDeepLink(42, 3.5)).toBe("/chats/42");
  });

  it("round-trips through parseAnchorParam", () => {
    const link = buildChatDeepLink(7, 88);
    const query = new URLSearchParams(link.slice(link.indexOf("?")));
    expect(parseAnchorParam(query)).toBe(88);
  });

  it("returns null when the anchor is absent", () => {
    expect(parseAnchorParam(new URLSearchParams(""))).toBeNull();
    expect(parseAnchorParam(new URLSearchParams("?foo=bar"))).toBeNull();
  });

  it("returns null for invalid anchors", () => {
    expect(parseAnchorParam(new URLSearchParams("?at="))).toBeNull();
    expect(parseAnchorParam(new URLSearchParams("?at=abc"))).toBeNull();
    expect(parseAnchorParam(new URLSearchParams("?at=0"))).toBeNull();
    expect(parseAnchorParam(new URLSearchParams("?at=-3"))).toBeNull();
    expect(parseAnchorParam(new URLSearchParams("?at=2.5"))).toBeNull();
  });
});
