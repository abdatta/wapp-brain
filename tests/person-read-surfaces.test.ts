import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import { buildEvidencePacks, renderEvidenceLines } from "../src/server/brain/episodes";
import { disambiguateLabels } from "../src/server/persons/disambiguate";

const ROHIT_1 = "919000000001@s.whatsapp.net";
const ROHIT_2 = "919000000002@s.whatsapp.net";
const PRIYA = "919000000003@s.whatsapp.net";
const GROUP = "120363000000000042@g.us";
const T0 = 1_700_000_000_000;

async function withRepository<T>(
  kind: "memory" | "sqlite",
  run: (repository: ArchiveRepository) => Promise<T>
): Promise<T> {
  if (kind === "memory") {
    return run(new MemoryArchiveRepository());
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-read-"));
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeMessage(chatSourceId: string, senderJid: string, id: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(chatSourceId, id),
    sourceTable: "message",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: senderJid,
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: `message ${id}`,
    caption: null,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

async function seedSameNameWorld(repository: ArchiveRepository): Promise<void> {
  const runId = await repository.startImportRun({ source: "read-surfaces-test" });
  await repository.upsertContacts(runId, [
    { sourceJid: ROHIT_1, phoneNumber: ROHIT_1.split("@")[0], displayName: "Rohit" },
    { sourceJid: ROHIT_2, phoneNumber: ROHIT_2.split("@")[0], displayName: "Rohit" },
    { sourceJid: PRIYA, phoneNumber: PRIYA.split("@")[0], displayName: "Priya" }
  ]);
  await repository.upsertChats(runId, [
    { sourceChatId: ROHIT_1, jid: ROHIT_1, displayName: "Rohit", chatType: "dm" },
    { sourceChatId: ROHIT_2, jid: ROHIT_2, displayName: "Rohit", chatType: "dm" },
    { sourceChatId: PRIYA, jid: PRIYA, displayName: "Priya", chatType: "dm" },
    { sourceChatId: GROUP, jid: GROUP, displayName: "Trip", chatType: "group" }
  ]);
  await repository.upsertMessages([
    makeMessage(ROHIT_1, ROHIT_1, "r1", T0),
    makeMessage(ROHIT_2, ROHIT_2, "r2", T0 + 1000),
    makeMessage(PRIYA, PRIYA, "p1", T0 + 2000),
    makeMessage(GROUP, ROHIT_1, "g1", T0 + 3000),
    makeMessage(GROUP, ROHIT_2, "g2", T0 + 4000),
    makeMessage(GROUP, PRIYA, "g3", T0 + 5000)
  ]);
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`person read surfaces (${kind})`, () => {
    it("renders two same-name persons distinctly with complete +E.164 suffixes, everywhere they co-occur", async () => {
      await withRepository(kind, async (repository) => {
        await seedSameNameWorld(repository);

        const chats = await repository.listChats({ limit: 20, offset: 0, includeEventOnly: true });
        const rohitChats = chats.filter((chat) => chat.displayName?.startsWith("Rohit"));
        expect(rohitChats).toHaveLength(2);
        expect(new Set(rohitChats.map((chat) => chat.displayName)).size).toBe(2);
        for (const chat of rohitChats) {
          // Complete +E.164, never masked or partial.
          expect(chat.displayName).toMatch(/^Rohit \(\+91\d{10}\)$/);
        }
        expect(chats.find((chat) => chat.sourceChatId === PRIYA)?.displayName).toBe("Priya");

        const group = chats.find((chat) => chat.sourceChatId === GROUP)!;
        const thread = await repository.listMessages(group.id, { limit: 20, offset: 0 });
        const senderLabels = thread.map((message) => message.senderDisplayName);
        expect(senderLabels.filter((label) => label?.startsWith("Rohit ("))).toHaveLength(2);
        expect(new Set(senderLabels).size).toBe(3);

        const search = await repository.searchMessages({ query: "message", limit: 20, offset: 0 });
        const rohitSenders = search.results.map((item) => item.senderDisplayName).filter((label) => label?.startsWith("Rohit"));
        expect(rohitSenders.length).toBeGreaterThanOrEqual(2);
        expect(new Set(rohitSenders).size).toBe(2);
      });
    });

    it("never disambiguates one person's identities against each other", async () => {
      await withRepository(kind, async (repository) => {
        await seedSameNameWorld(repository);
        await repository.connectIdentities(ROHIT_1, ROHIT_2, "user");

        const chats = await repository.listChats({ limit: 20, offset: 0, includeEventOnly: true });
        const rohitChats = chats.filter((chat) => chat.displayName?.startsWith("Rohit"));
        expect(rohitChats).toHaveLength(2);
        for (const chat of rohitChats) {
          expect(chat.displayName).toBe("Rohit");
        }

        const group = chats.find((chat) => chat.sourceChatId === GROUP)!;
        const thread = await repository.listMessages(group.id, { limit: 20, offset: 0 });
        for (const message of thread.filter((item) => item.senderSourceJid?.startsWith("91900000000"))) {
          if (message.senderSourceJid !== PRIYA) {
            expect(message.senderDisplayName).toBe("Rohit");
          }
        }
      });
    });

    it("surfaces a high-confidence pending suggestion as a display hint on chat and person DTOs, below-threshold stays quiet", async () => {
      await withRepository(kind, async (repository) => {
        await seedSameNameWorld(repository);
        await repository.upsertPersonSuggestions([
          { jidA: ROHIT_1, jidB: ROHIT_2, kind: "succession", score: 0.9, evidence: { sharedChatCount: 3 } },
          { jidA: PRIYA, jidB: ROHIT_2, kind: "shared_group", score: 0.4, evidence: {} }
        ]);

        const chats = await repository.listChats({ limit: 20, offset: 0, includeEventOnly: true });
        const hinted = chats.find((chat) => chat.sourceChatId === ROHIT_1);
        expect(hinted?.unconfirmedHint).toMatch(/^possibly the same as Rohit.*— unconfirmed$/);
        expect(chats.find((chat) => chat.sourceChatId === PRIYA)?.unconfirmedHint).toBeUndefined();

        // Person DTO hint: connect PRIYA-side pair is irrelevant; a person
        // containing ROHIT_2 sees the pending high-score suggestion to ROHIT_1.
        await repository.connectIdentities(ROHIT_2, PRIYA, "user");
        const person = await repository.resolvePersonForJid(ROHIT_2);
        expect(person?.unconfirmedHint).toMatch(/^possibly the same as Rohit.*— unconfirmed$/);
      });
    });

    it("exposes the merge value proposition (messages, mentions, groups) and cross-chat recent activity", async () => {
      await withRepository(kind, async (repository) => {
        await seedSameNameWorld(repository);
        await repository.upsertParticipants([
          { chatSourceId: GROUP, sourceJid: ROHIT_1, membershipSource: "source" },
          { chatSourceId: GROUP, sourceJid: PRIYA, membershipSource: "source" }
        ]);
        await repository.upsertMessages([
          { ...makeMessage(GROUP, PRIYA, "m-mention", T0 + 6000), mentionedJids: [ROHIT_1] }
        ]);
        await repository.upsertPersonSuggestions([
          { jidA: ROHIT_1, jidB: ROHIT_2, kind: "same_name", score: 0.85, evidence: { name: "Rohit" } }
        ]);
        const [suggestion] = await repository.listPersonSuggestions({ status: "pending" });
        const rohit1IsLow = suggestion.jidLow === ROHIT_1;
        expect(rohit1IsLow ? suggestion.lowMentionCount : suggestion.highMentionCount).toBe(1);
        expect(rohit1IsLow ? suggestion.highMentionCount : suggestion.lowMentionCount).toBe(0);
        expect(rohit1IsLow ? suggestion.lowGroupCount : suggestion.highGroupCount).toBe(1);
        expect(suggestion.lowMessageCount + suggestion.highMessageCount).toBeGreaterThan(0);

        // Recent activity spans DMs and groups, newest first, with chat labels
        // so a group-only identity is never invisible in the compare view.
        const activity = await repository.listRecentMessagesBySender(ROHIT_1, 10);
        expect(activity.length).toBeGreaterThanOrEqual(2);
        expect(activity.some((row) => row.chatSourceId === GROUP && row.chatLabel === "Trip" && row.chatType === "group")).toBe(true);
        expect(activity.some((row) => row.chatSourceId === ROHIT_1 && row.chatType === "dm")).toBe(true);
        for (let index = 1; index < activity.length; index += 1) {
          expect((activity[index - 1].timestampMs ?? 0) >= (activity[index].timestampMs ?? 0)).toBe(true);
        }
      });
    });

    it("lists only stored media for the compare strips — ids and labels, never bytes", async () => {
      await withRepository(kind, async (repository) => {
        await seedSameNameWorld(repository);
        // ROHIT_1 sent two media messages; only one has a stored asset.
        await repository.upsertMessages([
          { ...makeMessage(GROUP, ROHIT_1, "med-1", T0 + 7000), messageType: "image", hasMedia: true, body: null },
          { ...makeMessage(GROUP, ROHIT_1, "med-2", T0 + 8000), messageType: "image", hasMedia: true, body: null }
        ]);
        await repository.linkMediaAsset({
          messageKey: messageKey(GROUP, "med-1"),
          chatSourceId: GROUP,
          sha256: "a".repeat(64),
          storagePath: "media/aa/test.jpg",
          mimeType: "image/jpeg",
          byteSize: 1234,
          width: 100,
          height: 100,
          durationMs: null,
          thumbnail: new Uint8Array([1, 2, 3]),
          source: "import-folder",
          isViewOnce: false
        });
        const media = await repository.listRecentMediaBySender(ROHIT_1, 8);
        expect(media).toHaveLength(1);
        expect(media[0].hasThumbnail).toBe(true);
        expect(media[0].mimeType).toBe("image/jpeg");
        expect(media[0].chatLabel).toBe("Trip");
        expect(Object.keys(media[0])).not.toContain("thumbnail");
        // Another sender's media never leaks into the strip.
        expect(await repository.listRecentMediaBySender(PRIYA, 8)).toHaveLength(0);
      });
    });

    it("hints and membership never reach evidence packs: rendering is identical with and without them", async () => {
      await withRepository(kind, async (repository) => {
        await seedSameNameWorld(repository);
        const [before] = await buildEvidencePacks(repository, { chatSourceId: GROUP, startAtMs: 0, endAtMs: T0 + 10_000 });
        const linesBefore = renderEvidenceLines(before);

        await repository.upsertPersonSuggestions([
          { jidA: ROHIT_1, jidB: ROHIT_2, kind: "succession", score: 0.95, evidence: { sharedChatCount: 3 } }
        ]);
        await repository.connectIdentities(ROHIT_1, PRIYA, "user");

        const [after] = await buildEvidencePacks(repository, { chatSourceId: GROUP, startAtMs: 0, endAtMs: T0 + 10_000 });
        const linesAfter = renderEvidenceLines(after);
        expect(linesAfter).toEqual(linesBefore);
        expect(linesAfter.join("\n")).not.toContain("possibly the same as");
        expect(linesAfter.join("\n")).not.toContain("unconfirmed");
      });
    });
  });
}

describe("disambiguateLabels helper", () => {
  it("suffixes only cross-person collisions and prefers complete numbers, falling back deterministically", () => {
    const labels = disambiguateLabels([
      { label: "Rohit", personKey: "person_a", jid: "919000000001@s.whatsapp.net" },
      { label: "Rohit", personKey: "person_b", jid: "919000000002@s.whatsapp.net" },
      { label: "Rohit", personKey: "person_a", jid: "919000000009@s.whatsapp.net" },
      { label: "Priya", personKey: "person_c", jid: "919000000003@s.whatsapp.net" },
      // Number-less identity in a collision: context label, else stable ordinal.
      { label: "Asha", personKey: "person_d", jid: "244543240839500@lid", contextLabel: "Trip group" },
      { label: "Asha", personKey: "person_e", jid: "919000000004@s.whatsapp.net" }
    ]);
    expect(labels[0]).toBe("Rohit (+919000000001)");
    expect(labels[1]).toBe("Rohit (+919000000002)");
    // Same person as entry 0: suffixed with its own number too (it collides
    // with person_b), but never *because* of its co-member.
    expect(labels[2]).toBe("Rohit (+919000000009)");
    expect(labels[3]).toBe("Priya");
    expect(labels[4]).toBe("Asha (Trip group)");
    expect(labels[5]).toBe("Asha (+919000000004)");
  });

  it("leaves a single person's repeated label untouched", () => {
    const labels = disambiguateLabels([
      { label: "Rohit", personKey: "person_a", jid: "919000000001@s.whatsapp.net" },
      { label: "Rohit", personKey: "person_a", jid: "919000000002@s.whatsapp.net" }
    ]);
    expect(labels).toEqual(["Rohit", "Rohit"]);
  });
});
