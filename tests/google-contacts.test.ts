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
    expect(result).toEqual({ candidates: [], ambiguousNumbers: 1, skippedNumbers: 1 });
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
