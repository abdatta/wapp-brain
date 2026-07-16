import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCandidates, GoogleContactsService, normalizeGooglePhone } from "../src/server/googleContacts";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Google Contacts phone matching", () => {
  it("accepts canonical or explicit international numbers but never guesses national formats", () => {
    expect(normalizeGooglePhone({ canonicalForm: "+1 415 555 0100", value: "(415) 555-0100" })).toBe("14155550100");
    expect(normalizeGooglePhone({ value: "+44 (0) 20 7946 0958" })).toBe("4402079460958");
    expect(normalizeGooglePhone({ value: "415-555-0100" })).toBeNull();
  });

  it("skips conflicting names for one normalized number", () => {
    const result = buildCandidates([
      { names: [{ displayName: "Ada" }], phoneNumbers: [{ canonicalForm: "+14155550100" }] },
      { names: [{ displayName: "Grace" }], phoneNumbers: [{ canonicalForm: "+14155550100" }] },
      { names: [{ displayName: "Lin" }], phoneNumbers: [{ value: "020 1234" }] }
    ]);
    expect(result).toEqual({ candidates: [], groups: [], ambiguousNumbers: 1, skippedNumbers: 1 });
  });

  it("captures the same-contact grouping independently of name ambiguity, keeping candidates unchanged", () => {
    const result = buildCandidates([
      {
        resourceName: "people/c1",
        names: [{ displayName: "Rohit" }],
        phoneNumbers: [{ canonicalForm: "+14155550100" }, { canonicalForm: "+14155550101" }, { value: "020 1234" }]
      },
      // Same number under a different contact with a different name: the name
      // is ambiguous (skipped for enrichment) but BOTH groupings keep it.
      { resourceName: "people/c2", names: [{ displayName: "Rohit Old" }], phoneNumbers: [{ canonicalForm: "+14155550100" }] },
      // No display name at all: never a candidate, still a grouping member.
      { resourceName: "people/c3", phoneNumbers: [{ canonicalForm: "+14155550102" }] },
      // Deleted contacts contribute nothing.
      { resourceName: "people/c4", metadata: { deleted: true }, phoneNumbers: [{ canonicalForm: "+14155550103" }] }
    ]);
    expect(result.groups).toEqual([
      { resourceName: "people/c1", phoneE164: "14155550100", displayName: "Rohit" },
      { resourceName: "people/c1", phoneE164: "14155550101", displayName: "Rohit" },
      { resourceName: "people/c2", phoneE164: "14155550100", displayName: "Rohit Old" },
      { resourceName: "people/c3", phoneE164: "14155550102", displayName: null }
    ]);
    // Enrichment candidates are unaffected by grouping capture: 0100 is
    // name-ambiguous, the unnormalizable and nameless numbers skip.
    expect(result.candidates).toEqual([{ phoneNumber: "14155550101", displayName: "Rohit" }]);
    expect(result.ambiguousNumbers).toBe(1);
  });
});

describe("Google Contacts OAuth", () => {
  it("uses single-use state and stores tokens only in the configured private file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wapp-google-auth-")); tempDirs.push(dir);
    const fetcher = async () => new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    const service = new GoogleContactsService({ clientId: "client", clientSecret: "secret", callbackUrl: "http://127.0.0.1:3600/callback", credentialsPath: path.join(dir, "auth.json"), fetch: fetcher as typeof fetch });
    const authUrl = new URL(service.createAuthorizationUrl());
    const state = authUrl.searchParams.get("state")!;
    expect(authUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/contacts.readonly");
    await service.handleCallback("code", state);
    expect((await service.status()).connected).toBe(true);
    await expect(service.handleCallback("code", state)).rejects.toThrow(/verified/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")).refreshToken).toBe("refresh");
  });

  it("refreshes expired access and follows People API pages", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wapp-google-pages-")); tempDirs.push(dir);
    let now = 1_000; let tokenCalls = 0; let peopleCalls = 0;
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify(tokenCalls === 1 ? { access_token: "old", refresh_token: "refresh", expires_in: 1 } : { access_token: "new", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      peopleCalls += 1;
      const second = url.includes("pageToken=next");
      return new Response(JSON.stringify(second ? { connections: [{ names: [{ displayName: "Grace" }], phoneNumbers: [{ canonicalForm: "+14155550101" }] }] } : { connections: [{ names: [{ displayName: "Ada" }], phoneNumbers: [{ canonicalForm: "+14155550100" }] }], nextPageToken: "next" }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const service = new GoogleContactsService({ clientId: "client", clientSecret: "secret", callbackUrl: "http://127.0.0.1/callback", credentialsPath: path.join(dir, "auth.json"), fetch: fetcher as typeof fetch, now: () => now });
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;
    await service.handleCallback("code", state);
    now += 2_000;
    const repository = new MemoryArchiveRepository();
    const result = await service.sync(repository);
    expect(tokenCalls).toBe(2);
    expect(peopleCalls).toBe(2);
    expect(result.fetchedPeople).toBe(2);
  });
});

describe("Google Contacts grouping sync", () => {
  function serviceWithPeoplePages(dir: string, pagesByCall: () => unknown[]): GoogleContactsService {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ connections: pagesByCall() }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    return new GoogleContactsService({
      clientId: "client",
      clientSecret: "secret",
      callbackUrl: "http://127.0.0.1/callback",
      credentialsPath: path.join(dir, "auth.json"),
      fetch: fetcher as typeof fetch
    });
  }

  it("persists groupings, auto-connects same-contact identities, and a re-sync replaces groupings without disconnecting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wapp-google-group-")); tempDirs.push(dir);
    let people: unknown[] = [
      { resourceName: "people/c9", names: [{ displayName: "Asha" }], phoneNumbers: [{ canonicalForm: "+14155550100" }, { canonicalForm: "+14155550101" }] }
    ];
    const service = serviceWithPeoplePages(dir, () => people);
    const state = new URL(service.createAuthorizationUrl()).searchParams.get("state")!;
    await service.handleCallback("code", state);

    const repository = new MemoryArchiveRepository();
    const runId = await repository.startImportRun({ source: "google-group-test" });
    await repository.upsertContacts(runId, [
      { sourceJid: "14155550100@s.whatsapp.net", phoneNumber: "14155550100" },
      { sourceJid: "14155550101@s.whatsapp.net", phoneNumber: "14155550101" }
    ]);

    const result = await service.sync(repository);
    expect(result.contactGroups).toBe(1);
    expect(result.groupedNumbers).toBe(2);
    expect(result.personsAutoConnected).toBe(1);
    expect(await repository.listGoogleContactGroups()).toEqual([
      { resourceName: "people/c9", phoneE164: "14155550100", displayName: "Asha" },
      { resourceName: "people/c9", phoneE164: "14155550101", displayName: "Asha" }
    ]);
    const person = await repository.resolvePersonForJid("14155550100@s.whatsapp.net");
    expect(person?.members).toHaveLength(2);
    expect(person?.members.every((member) => member.source === "google")).toBe(true);
    expect(person?.members[0]?.evidence).toEqual({ resourceName: "people/c9" });

    // The number moves to its own contact: the persisted groupings mirror the
    // provider's current state, but the connection made earlier persists.
    people = [
      { resourceName: "people/c9", names: [{ displayName: "Asha" }], phoneNumbers: [{ canonicalForm: "+14155550100" }] },
      { resourceName: "people/c77", names: [{ displayName: "Asha New" }], phoneNumbers: [{ canonicalForm: "+14155550101" }] }
    ];
    const resync = await service.sync(repository);
    expect(resync.contactGroups).toBe(2);
    expect(resync.personsAutoConnected).toBe(0);
    expect((await repository.listGoogleContactGroups()).map((group) => group.resourceName).sort()).toEqual(["people/c77", "people/c9"]);
    expect((await repository.resolvePersonForJid("14155550100@s.whatsapp.net"))?.members).toHaveLength(2);

    // Credentials file stores tokens and aggregate counts only — no contact
    // names, numbers, or raw provider payloads.
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(JSON.stringify(stored)).not.toContain("Asha");
    expect(JSON.stringify(stored)).not.toContain("4155550100");
    expect(stored.lastSync.contactGroups).toBe(2);
  });
});

describe("Google Contacts archive precedence", () => {
  it("fills unresolved names and preserves an existing saved name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wapp-google-db-")); tempDirs.push(dir);
    const repository = new SqliteArchiveRepository(path.join(dir, "archive.sqlite"));
    try {
      const run = await repository.startImportRun({ test: true });
      await repository.upsertContacts(run, [
        { sourceJid: "14155550100@s.whatsapp.net", phoneNumber: "14155550100" },
        { sourceJid: "14155550101@s.whatsapp.net", phoneNumber: "14155550101", displayName: "WhatsApp Name" }
      ]);
      await repository.upsertChats(run, [
        { sourceChatId: "14155550100@s.whatsapp.net", jid: "14155550100@s.whatsapp.net", chatType: "dm" },
        { sourceChatId: "14155550101@s.whatsapp.net", jid: "14155550101@s.whatsapp.net", chatType: "dm" }
      ]);
      await repository.upsertContacts(run, [
        { sourceJid: "14155550101@s.whatsapp.net", phoneNumber: "14155550101", displayName: "WhatsApp Name" }
      ]);
      const result = await repository.enrichContactsFromGoogle([
        { phoneNumber: "14155550100", displayName: "Google Ada" },
        { phoneNumber: "14155550101", displayName: "Google Wrong" }
      ]);
      expect(result).toEqual({ matchedIdentities: 2, improvedNames: 1 });
      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      expect(chats.find((chat) => chat.sourceChatId.includes("0100"))?.displayName).toBe("Google Ada");
      expect(chats.find((chat) => chat.sourceChatId.includes("0101"))?.displayName).toBe("WhatsApp Name");
    } finally { await repository.close(); }
  });
});
