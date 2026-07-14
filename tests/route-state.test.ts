import { describe, expect, it } from "vitest";
import { routeStateKey } from "../src/client/lib/routeState";

describe("route state keys", () => {
  it("keeps the import wizard mounted between setup sub-routes", () => {
    expect(routeStateKey("/import")).toBe("/import");
    expect(routeStateKey("/import/key")).toBe("/import");
    expect(routeStateKey("/import/mode")).toBe("/import");
    expect(routeStateKey("/import/run")).toBe("/import");
  });

  it("still resets the error boundary when leaving the import flow", () => {
    expect(routeStateKey("/chats")).toBe("/chats");
    expect(routeStateKey("/chats/42")).toBe("/chats/42");
  });
});
