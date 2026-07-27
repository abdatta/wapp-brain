import { describe, expect, it } from "vitest";
import { routeStateKey } from "../src/client/lib/routeState";

describe("route state keys", () => {
  it("keeps the import wizard mounted between setup sub-routes", () => {
    expect(routeStateKey("/import")).toBe("/import");
    expect(routeStateKey("/import/key")).toBe("/import");
    expect(routeStateKey("/import/mode")).toBe("/import");
    expect(routeStateKey("/import/run")).toBe("/import");
  });

  it("still resets the error boundary when moving between surfaces", () => {
    expect(routeStateKey("/chats")).toBe("/chats");
    expect(routeStateKey("/search")).toBe("/search");
    expect(routeStateKey("/brain")).toBe("/brain");
    expect(routeStateKey("/brain/muted")).toBe("/brain/muted");
    // Distinct surfaces keep distinct keys, so an error on one never survives
    // navigation to another.
    expect(routeStateKey("/chats")).not.toBe(routeStateKey("/search"));
    expect(routeStateKey("/brain")).not.toBe(routeStateKey("/brain/muted"));
  });

  // Opening a record is navigation WITHIN a surface, not to a new one. Keying
  // on the full path remounted the page and discarded its state — the chat
  // list's search, filters, muted fold, and loaded rows — which then made the
  // opened chat unresolvable in its own header.
  it("keeps a surface mounted while navigating between its records", () => {
    expect(routeStateKey("/chats/42")).toBe("/chats");
    expect(routeStateKey("/chats/42")).toBe(routeStateKey("/chats/99"));
    expect(routeStateKey("/chats/42")).toBe(routeStateKey("/chats"));
    expect(routeStateKey("/brain/pages/entity:acme")).toBe("/brain/pages");
    expect(routeStateKey("/brain/pages/entity:acme")).toBe(routeStateKey("/brain/pages/topic:housing"));
  });
});
