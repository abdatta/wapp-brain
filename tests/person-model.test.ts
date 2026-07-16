import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";

const A = "919000000001@s.whatsapp.net";
const B = "919000000002@s.whatsapp.net";
const C = "919000000003@s.whatsapp.net";
const D = "919000000004@s.whatsapp.net";
const LID = "244543240839500@lid";

async function withRepository<T>(
  kind: "memory" | "sqlite",
  run: (repository: ArchiveRepository) => Promise<T>
): Promise<T> {
  if (kind === "memory") {
    return run(new MemoryArchiveRepository());
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-model-"));
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedIdentities(repository: ArchiveRepository, jids: string[], names: Record<string, string> = {}): Promise<void> {
  const runId = await repository.startImportRun({ source: "person-model-test" });
  await repository.upsertContacts(
    runId,
    jids.map((jid) => ({
      sourceJid: jid,
      phoneNumber: jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null,
      displayName: names[jid] ?? null
    }))
  );
  await repository.upsertChats(
    runId,
    jids.map((jid) => ({ sourceChatId: jid, jid, chatType: "dm" as const }))
  );
  await repository.upsertMessages(
    jids.map((jid, index) => ({
      sourceMessageId: `m-${index}`,
      sourceMessageKey: messageKey(jid, `m-${index}`),
      sourceTable: "message",
      sourceRowId: String(index + 1),
      chatSourceId: jid,
      senderSourceJid: jid,
      timestampMs: 1_710_000_000_000 + index * 1000,
      sentAtIso: new Date(1_710_000_000_000 + index * 1000).toISOString(),
      fromMe: false,
      direction: "incoming" as const,
      messageType: "text",
      body: `hello from ${index}`,
      caption: null,
      hasMedia: false,
      isDeleted: false,
      isForwarded: false,
      isStarred: false
    }))
  );
}

async function brainSnapshot(repository: ArchiveRepository): Promise<string> {
  const episodes = await repository.listBrainEpisodes({ limit: 50 });
  return JSON.stringify(
    episodes.map((episode) => ({
      id: episode.id,
      chatSourceId: episode.chatSourceId,
      summary: episode.summary,
      status: episode.status,
      claims: episode.claims.map((claim) => ({
        text: claim.text,
        entities: claim.entities,
        citations: claim.citations.map((citation) => citation.sourceMessageKey)
      }))
    }))
  );
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`two-level person model (${kind})`, () => {
    it("connects with provenance and disconnect fully restores the pre-connect state with zero brain writes", async () => {
      await withRepository(kind, async (repository) => {
        await seedIdentities(repository, [A, B], { [A]: "Rohit Sharma" });
        await repository.commitBrainEpisode({
          chatSourceId: A,
          startAtMs: 1_710_000_000_000,
          endAtMs: 1_710_000_000_000,
          messageCount: 1,
          participants: ["Rohit Sharma"],
          summary: "Rohit confirmed the plan.",
          markdown: "",
          generator: "extractive",
          model: null,
          runId: null,
          extractionVersion: 4,
          claims: [
            {
              kind: "fact",
              text: "Rohit confirmed the plan.",
              citations: [messageKey(A, "m-0")],
              entities: [{ kind: "person", name: "Rohit Sharma", jid: A }]
            }
          ]
        });
        const before = await brainSnapshot(repository);

        const connect = await repository.connectIdentities(A, B, "google", { resourceName: "people/c100" });
        expect(connect.outcome).toBe("connected");
        expect(connect.personId).toBeTruthy();

        const person = await repository.resolvePersonForJid(A);
        expect(person?.id).toBe(connect.personId);
        expect(person?.members).toHaveLength(2);
        const memberA = person?.members.find((member) => member.identityJid === A);
        expect(memberA?.source).toBe("google");
        expect(memberA?.evidence).toEqual({ resourceName: "people/c100" });
        expect(person?.displayLabel).toBe("Rohit Sharma");

        const keys = await repository.personKeyForJids([A, B]);
        expect(keys.get(A)).toBe(connect.personId);
        expect(keys.get(B)).toBe(connect.personId);

        // Idempotent: connecting co-members is a no-op.
        expect((await repository.connectIdentities(A, B, "google", { resourceName: "people/c100" })).outcome).toBe("already_connected");

        expect(await brainSnapshot(repository)).toBe(before);

        const disconnect = await repository.disconnectIdentities(A);
        expect(disconnect).toEqual({ disconnected: true, personId: connect.personId, dissolved: true });
        expect(await repository.resolvePersonForJid(A)).toBeNull();
        expect(await repository.resolvePersonForJid(B)).toBeNull();
        const keysAfter = await repository.personKeyForJids([A, B]);
        expect(keysAfter.get(A)).toBe(A);
        expect(keysAfter.get(B)).toBe(B);

        // The externally-held person id resolves through a redirect, not an error.
        const lookup = await repository.getPerson(connect.personId!);
        expect(lookup.person).toBeNull();
        expect(lookup.redirect?.survivingJid).toBe(B);

        expect(await brainSnapshot(repository)).toBe(before);

        // Disconnect wrote suppression: auto sources are blocked, a user
        // connect clears it and proceeds.
        expect((await repository.connectIdentities(A, B, "google", { resourceName: "people/c100" })).outcome).toBe("suppressed");
        expect((await repository.connectIdentities(A, B, "number_change", { eventKey: "evt" })).outcome).toBe("suppressed");
        expect(await repository.listPersonLinkSuppressions()).toHaveLength(1);
        const reconnect = await repository.connectIdentities(A, B, "user");
        expect(reconnect.outcome).toBe("connected");
        expect(await repository.listPersonLinkSuppressions()).toHaveLength(0);

        const actions = (await repository.listPersonLinkEvents({ limit: 100 })).map((event) => event.action);
        for (const expected of ["connect", "disconnect", "dissolve"]) {
          expect(actions).toContain(expected);
        }
      });
    });

    it("enforces at-most-one-person and unions persons revealed to share an identity, with redirects", async () => {
      await withRepository(kind, async (repository) => {
        await seedIdentities(repository, [A, B, C, D]);
        const first = await repository.connectIdentities(A, B, "user");
        const second = await repository.connectIdentities(C, D, "user");
        expect(first.personId).not.toBe(second.personId);

        const union = await repository.connectIdentities(B, C, "number_change", { eventKey: "evt-1" });
        expect(union.outcome).toBe("union");
        const keys = await repository.personKeyForJids([A, B, C, D]);
        expect(new Set(keys.values()).size).toBe(1);
        expect(keys.get(A)).toBe(union.personId);

        const survivor = await repository.getPerson(union.personId!);
        expect(survivor.person?.members).toHaveLength(4);
        // Original provenance survives the union.
        expect(survivor.person?.members.find((member) => member.identityJid === A)?.source).toBe("user");

        const dissolvedId = first.personId === union.personId ? second.personId! : first.personId!;
        const redirected = await repository.getPerson(dissolvedId);
        expect(redirected.person?.id).toBe(union.personId);
        expect(redirected.redirect?.replacedByPersonId).toBe(union.personId);
      });
    });

    it("suggestions never apply, rejection memory survives stronger evidence, and acceptance connects as user", async () => {
      await withRepository(kind, async (repository) => {
        await seedIdentities(repository, [A, B, C], { [A]: "Rohit", [B]: "Rohit" });

        const upsert = await repository.upsertPersonSuggestions([
          { jidA: A, jidB: B, kind: "same_name", score: 0.7, evidence: { name: "Rohit" } }
        ]);
        expect(upsert).toEqual({ created: 1, updated: 0 });
        // No membership was created by the suggestion.
        expect(await repository.resolvePersonForJid(A)).toBeNull();

        const [pending] = await repository.listPersonSuggestions({ status: "pending" });
        expect(pending.kind).toBe("same_name");
        expect(await repository.rejectPersonSuggestion(pending.id)).toBe(true);

        // Re-running the detector with strengthened evidence never resurrects it.
        const rerun = await repository.upsertPersonSuggestions([
          { jidA: A, jidB: B, kind: "same_name", score: 0.95, evidence: { name: "Rohit", groups: 3 } }
        ]);
        expect(rerun).toEqual({ created: 0, updated: 0 });
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);
        expect((await repository.listPersonSuggestions({ status: "rejected" }))[0]?.score).toBe(0.7);

        // A different pair still suggests; acceptance connects with user provenance.
        await repository.upsertPersonSuggestions([{ jidA: A, jidB: C, kind: "shared_group", score: 0.6, evidence: { groups: ["g1"] } }]);
        const [candidate] = await repository.listPersonSuggestions({ status: "pending" });
        const accepted = await repository.acceptPersonSuggestion(candidate.id);
        expect(accepted.outcome).toBe("connected");
        const person = await repository.resolvePersonForJid(C);
        const memberC = person?.members.find((member) => member.identityJid === C);
        expect(memberC?.source).toBe("user");
        expect(memberC?.evidence?.suggestionId).toBe(candidate.id);
        expect((await repository.listPersonSuggestions({ status: "accepted" }))[0]?.id).toBe(candidate.id);

        // Detectors skip co-members and suppressed pairs at the repository too.
        expect(await repository.upsertPersonSuggestions([{ jidA: A, jidB: C, kind: "co_citation", score: 0.5, evidence: {} }])).toEqual({
          created: 0,
          updated: 0
        });
        await repository.disconnectIdentities(C);
        expect(await repository.upsertPersonSuggestions([{ jidA: A, jidB: C, kind: "succession", score: 0.5, evidence: {} }])).toEqual({
          created: 0,
          updated: 0
        });
      });
    });

    it("identity merge rewrites the person layer onto the canonical JID and unions cross-person collapses", async () => {
      await withRepository(kind, async (repository) => {
        await seedIdentities(repository, [A, B, C]);
        // Archive the LID form so the merge has something to collapse.
        const runId = await repository.startImportRun({ source: "person-merge-test" });
        await repository.upsertChats(runId, [{ sourceChatId: LID, jid: LID, chatType: "dm" }]);
        await repository.upsertMessages([
          {
            sourceMessageId: "lid-m",
            sourceMessageKey: messageKey(LID, "lid-m"),
            sourceTable: "message",
            sourceRowId: "99",
            chatSourceId: LID,
            senderSourceJid: LID,
            timestampMs: 1_710_000_100_000,
            sentAtIso: "2024-03-09T16:01:40.000Z",
            fromMe: false,
            direction: "incoming",
            messageType: "text",
            body: "from lid",
            caption: null,
            hasMedia: false,
            isDeleted: false,
            isForwarded: false,
            isStarred: false
          }
        ]);

        // LID sits in one person, its phone identity in another; a suggestion
        // and a suppression reference the LID form too.
        await repository.connectIdentities(LID, A, "user");
        await repository.connectIdentities(B, C, "user");
        await repository.upsertPersonSuggestions([
          { jidA: LID, jidB: C, kind: "shared_group", score: 0.4, evidence: {} },
          { jidA: LID, jidB: B, kind: "same_name", score: 0.5, evidence: {} }
        ]);

        await repository.recordIdentityLinks([{ lid: LID, pn: B }]);
        await repository.mergeIdentity(LID, B);

        // Membership carries the canonical JID; the two persons unioned.
        const keys = await repository.personKeyForJids([A, B, C]);
        expect(new Set(keys.values()).size).toBe(1);
        const person = await repository.resolvePersonForJid(B);
        expect(person?.members.map((member) => member.identityJid).sort()).toEqual([A, B, C].sort());
        expect(person?.members.some((member) => member.identityJid === LID)).toBe(false);

        // Suggestions re-normalized onto the canonical pair; the (LID,B) row
        // became self-referential and vanished.
        const suggestions = await repository.listPersonSuggestions({ limit: 50 });
        expect(suggestions.some((suggestion) => suggestion.jidLow === LID || suggestion.jidHigh === LID)).toBe(false);
        expect(suggestions.filter((suggestion) => suggestion.kind === "same_name")).toHaveLength(0);
        const rewritten = suggestions.find((suggestion) => suggestion.kind === "shared_group");
        expect(rewritten && [rewritten.jidLow, rewritten.jidHigh].sort()).toEqual([B, C].sort());
      });
    });
  });
}
