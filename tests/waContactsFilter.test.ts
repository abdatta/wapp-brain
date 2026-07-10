import { describe, expect, it } from "vitest";
import { filterWaContacts, paginateWaContacts } from "../src/client/waContacts/filterContacts";
import type { WaContactRow } from "../src/shared/types";

function contact(overrides: Partial<WaContactRow>): WaContactRow {
  return {
    jid: "0@s.whatsapp.net",
    lid: null,
    number: null,
    displayName: null,
    resolved: false,
    ...overrides
  };
}

const SAMPLE: WaContactRow[] = [
  contact({ jid: "15550000001@s.whatsapp.net", number: "15550000001", displayName: "Avery Example", resolved: true }),
  contact({ jid: "15550000002@s.whatsapp.net", number: "15550000002", displayName: "Blake Example", resolved: true }),
  contact({ jid: "15550000003@s.whatsapp.net", number: "15550000003", displayName: null, resolved: false }),
  contact({ jid: "120363000000000001@g.us", number: null, displayName: "Weekend Plans", resolved: true }),
  contact({ jid: "99@lid", lid: "15550000009@lid", number: null, displayName: null, resolved: false })
];

describe("filterWaContacts", () => {
  it("returns everything with no filters", () => {
    expect(filterWaContacts(SAMPLE)).toHaveLength(SAMPLE.length);
  });

  it("filters to resolved only", () => {
    const result = filterWaContacts(SAMPLE, { status: "resolved" });
    expect(result.every((c) => c.resolved)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("filters to unresolved only", () => {
    const result = filterWaContacts(SAMPLE, { status: "unresolved" });
    expect(result.every((c) => !c.resolved)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("matches query case-insensitively against name, number, jid, and lid", () => {
    expect(filterWaContacts(SAMPLE, { query: "avery" })).toHaveLength(1);
    expect(filterWaContacts(SAMPLE, { query: "0000003" })).toHaveLength(1);
    expect(filterWaContacts(SAMPLE, { query: "g.us" })).toHaveLength(1);
    expect(filterWaContacts(SAMPLE, { query: "15550000009" })).toHaveLength(1);
    expect(filterWaContacts(SAMPLE, { query: "WEEKEND" })).toHaveLength(1);
  });

  it("combines query and status filters", () => {
    const result = filterWaContacts(SAMPLE, { query: "example", status: "resolved" });
    expect(result.map((c) => c.jid)).toEqual(["15550000001@s.whatsapp.net", "15550000002@s.whatsapp.net"]);
  });

  it("returns nothing for a query that matches no contact", () => {
    expect(filterWaContacts(SAMPLE, { query: "nonexistent" })).toHaveLength(0);
  });
});

describe("paginateWaContacts", () => {
  const many: WaContactRow[] = Array.from({ length: 237 }, (_, index) =>
    contact({ jid: `${index}@s.whatsapp.net`, displayName: `Contact ${index}`, resolved: index % 2 === 0 })
  );

  it("slices the requested page", () => {
    const page = paginateWaContacts(many, 1, 50);
    expect(page.rows).toHaveLength(50);
    expect(page.rows[0].jid).toBe("0@s.whatsapp.net");
    expect(page.total).toBe(237);
    expect(page.pageCount).toBe(5);
  });

  it("returns the correct final partial page", () => {
    const page = paginateWaContacts(many, 5, 50);
    expect(page.rows).toHaveLength(37);
    expect(page.page).toBe(5);
  });

  it("clamps a page number beyond the last page", () => {
    const page = paginateWaContacts(many, 999, 50);
    expect(page.page).toBe(5);
    expect(page.rows).toHaveLength(37);
  });

  it("clamps a page number below 1", () => {
    const page = paginateWaContacts(many, 0, 50);
    expect(page.page).toBe(1);
  });

  it("handles an empty list without producing a zero page count", () => {
    const page = paginateWaContacts([], 1, 50);
    expect(page.pageCount).toBe(1);
    expect(page.rows).toHaveLength(0);
    expect(page.total).toBe(0);
  });
});
