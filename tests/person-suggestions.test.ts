import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import type { MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import { runPersonSuggestionDetectors } from "../src/server/persons/suggestions";

const OLD = "919000000001@s.whatsapp.net";
const NEW = "919000000002@s.whatsapp.net";
const OTHER = "919000000003@s.whatsapp.net";
const GROUP_1 = "120363000000000001@g.us";
const GROUP_2 = "120363000000000002@g.us";

const DAY = 24 * 60 * 60_000;
const T0 = 1_700_000_000_000;

async function withRepository<T>(
  kind: "memory" | "sqlite",
  run: (repository: ArchiveRepository) => Promise<T>
): Promise<T> {
  if (kind === "memory") {
    return run(new MemoryArchiveRepository());
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-person-suggest-"));
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
    body: `msg ${id}`,
    caption: null,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`person suggestion detectors (${kind})`, () => {
    it("same-name identities produce a ranked suggestion and never a membership", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Rohit Sharma" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0], displayName: "Rohit Sharma" },
          { sourceJid: OTHER, phoneNumber: OTHER.split("@")[0], displayName: "Priya" }
        ]);
        await repository.upsertChats(runId, [{ sourceChatId: OLD, jid: OLD, chatType: "dm" }]);
        await repository.upsertMessages([makeMessage(OLD, OLD, "sn-1", T0)]);
        const summary = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(summary.created).toBe(1);
        const [suggestion] = await repository.listPersonSuggestions({ status: "pending" });
        expect(suggestion.kind).toBe("same_name");
        expect(suggestion.score).toBe(0.85);
        expect(suggestion.evidence.name).toBe("Rohit Sharma");
        // Decision context resolved at read time: complete numbers per side.
        expect(suggestion.lowPhone).toBe(suggestion.jidLow.split("@")[0]);
        expect(suggestion.highPhone).toBe(suggestion.jidHigh.split("@")[0]);
        // Produce, never apply.
        expect(await repository.resolvePersonForJid(OLD)).toBeNull();
        expect(await repository.listPersons()).toHaveLength(0);
      });
    });

    it("zero-value pairs (no messages on either side) are never suggested, pruned if pending, and resurrect once a side speaks", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Amit" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0], displayName: "Amit" }
        ]);
        // Neither side has ever sent a message: the detector produces nothing.
        const first = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(first.created).toBe(0);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);

        // A pre-existing pending row for such a pair (e.g. created before the
        // rule) is pruned by the pass, not shown forever.
        await repository.upsertPersonSuggestions([{ jidA: OLD, jidB: NEW, kind: "same_name", score: 0.85, evidence: { name: "Amit" } }]);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(1);
        const prune = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(prune.prunedZeroValue).toBe(1);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);

        // Self-healing: the moment either number speaks, the detector
        // resurfaces the pair (superseded → pending; rejected stays dead).
        await repository.upsertChats(runId, [{ sourceChatId: OLD, jid: OLD, chatType: "dm" }]);
        await repository.upsertMessages([makeMessage(OLD, OLD, "zv-1", T0)]);
        const revived = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(revived.created).toBe(1);
        const [pending] = await repository.listPersonSuggestions({ status: "pending" });
        expect([pending.jidLow, pending.jidHigh].sort()).toEqual([OLD, NEW].sort());
        expect(pending.lowMessageCount + pending.highMessageCount).toBe(1);
      });
    });

    it("prunes stale pending suggestions whose pair is already co-membered (transitively) or suppressed", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Poulomi" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0], displayName: "Poulomi" },
          { sourceJid: OTHER, phoneNumber: OTHER.split("@")[0], displayName: "Poulomi" }
        ]);
        await repository.upsertChats(runId, [{ sourceChatId: OLD, jid: OLD, chatType: "dm" }]);
        await repository.upsertMessages([makeMessage(OLD, OLD, "tr-1", T0)]);
        // A pending suggestion between NEW and OTHER exists first.
        await repository.upsertPersonSuggestions([{ jidA: NEW, jidB: OTHER, kind: "same_name", score: 0.85, evidence: { name: "Poulomi" } }]);
        // A three-number Google card connects pairwise through the anchor —
        // NEW and OTHER become co-members without a direct NEW↔OTHER connect,
        // so the pending row survives the connect-time cleanup.
        await repository.connectIdentities(OLD, NEW, "google", { resourceName: "people/c1" });
        await repository.connectIdentities(OLD, OTHER, "google", { resourceName: "people/c1" });
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(1);

        const sweep = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(sweep.prunedResolved).toBe(1);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);
        // It stays quiet on later passes while the pair remains co-membered.
        const again = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(again.created).toBe(0);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);

        // Suppressed pairs get the same hygiene: seed a pending row, then
        // suppress the pair via disconnect.
        await repository.disconnectIdentities(OTHER);
        // (disconnect suppressed OTHER against OLD and NEW; craft a pending
        // row for one suppressed pair directly)
        const [low, high] = [NEW, OTHER].sort();
        await repository.upsertPersonSuggestions([{ jidA: low, jidB: high, kind: "succession", score: 0.8, evidence: {} }]);
        // The upsert itself refuses suppressed pairs, so nothing pending was
        // created — the sweep has nothing to do and the queue stays clean.
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);
      });
    });

    it("retires standalone shared_group suggestions: default pass supersedes lingering pending rows and produces none", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Asha" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0], displayName: "Binod" }
        ]);
        // A pending row from the retired detector (as real archives already have).
        await repository.upsertPersonSuggestions([
          { jidA: OLD, jidB: NEW, kind: "shared_group", score: 0.5, evidence: { sharedGroupCount: 4 } }
        ]);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(1);

        const summary = await runPersonSuggestionDetectors(repository);
        expect(summary.byDetector.shared_group).toBeUndefined();
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);
        const superseded = await repository.listPersonSuggestions({ status: "superseded" });
        expect(superseded.some((suggestion) => suggestion.kind === "shared_group")).toBe(true);
        // Rejected/accepted history is untouched by the retirement — and the
        // superseded row never becomes pending again on the next pass.
        await runPersonSuggestionDetectors(repository);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);
      });
    });

    it("rejection memory survives detector re-runs with strengthened evidence", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Rohit" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0], pushName: "Rohit" }
        ]);
        await repository.upsertChats(runId, [{ sourceChatId: OLD, jid: OLD, chatType: "dm" }]);
        await repository.upsertMessages([makeMessage(OLD, OLD, "rm-1", T0)]);
        await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        const [pending] = await repository.listPersonSuggestions({ status: "pending" });
        expect(pending.score).toBe(0.7);
        await repository.rejectPersonSuggestion(pending.id);

        // The identity later gains a saved name (stronger evidence) — the
        // detector recomputes a higher score but the rejected slot holds.
        await repository.upsertContacts(runId, [{ sourceJid: NEW, phoneNumber: NEW.split("@")[0], displayName: "Rohit" }]);
        const rerun = await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        expect(rerun.created + rerun.updated).toBe(0);
        expect(await repository.listPersonSuggestions({ status: "pending" })).toHaveLength(0);
      });
    });

    it("detects the succession pattern with shared-chat evidence, sharpened by the membership timeline", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Asha Old" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0] },
          { sourceJid: OTHER, phoneNumber: OTHER.split("@")[0], displayName: "Priya" }
        ]);
        await repository.upsertChats(runId, [
          { sourceChatId: GROUP_1, jid: GROUP_1, displayName: "Family", chatType: "group" },
          { sourceChatId: GROUP_2, jid: GROUP_2, displayName: "Trip", chatType: "group" }
        ]);
        const messages: MessageRecord[] = [];
        // OLD is active in both groups for ten days, then goes silent.
        for (let day = 0; day < 10; day += 1) {
          messages.push(makeMessage(GROUP_1, OLD, `old-g1-${day}`, T0 + day * DAY));
          messages.push(makeMessage(GROUP_2, OLD, `old-g2-${day}`, T0 + day * DAY + 1000));
        }
        // NEW first appears five days after OLD's last message, in the same
        // groups, and stays active.
        for (let day = 15; day < 25; day += 1) {
          messages.push(makeMessage(GROUP_1, NEW, `new-g1-${day}`, T0 + day * DAY));
          messages.push(makeMessage(GROUP_2, NEW, `new-g2-${day}`, T0 + day * DAY + 1000));
        }
        // A bystander active throughout, overlapping both — no succession.
        for (let day = 0; day < 25; day += 1) {
          messages.push(makeMessage(GROUP_1, OTHER, `other-${day}`, T0 + day * DAY + 2000));
        }
        await repository.upsertMessages(messages);
        // Membership timeline: OLD leaves GROUP_1 and NEW joins within the window.
        await repository.upsertArchiveSignals({
          membershipPeriods: [
            {
              periodKey: "p-old",
              groupSourceId: GROUP_1,
              participantJid: OLD,
              joinedAtMs: T0 - 30 * DAY,
              leftAtMs: T0 + 10 * DAY,
              role: null,
              source: "backup",
              sourceEventKey: "p-old",
              observedAtMs: T0 + 10 * DAY,
              captureVersion: 1
            },
            {
              periodKey: "p-new",
              groupSourceId: GROUP_1,
              participantJid: NEW,
              joinedAtMs: T0 + 15 * DAY,
              leftAtMs: null,
              role: null,
              source: "backup",
              sourceEventKey: "p-new",
              observedAtMs: T0 + 15 * DAY,
              captureVersion: 1
            }
          ]
        });

        const summary = await runPersonSuggestionDetectors(repository, { detectors: ["succession"] });
        expect(summary.created).toBeGreaterThan(0);
        const suggestions = await repository.listPersonSuggestions({ status: "pending", limit: 20 });
        const succession = suggestions.find(
          (suggestion) => suggestion.kind === "succession" && [suggestion.jidLow, suggestion.jidHigh].includes(NEW)
        );
        expect(succession).toBeTruthy();
        expect([succession!.jidLow, succession!.jidHigh].sort()).toEqual([OLD, NEW].sort());
        expect(succession!.evidence.sharedChatCount).toBe(2);
        expect(succession!.evidence.sharedChats).toContain(GROUP_1);
        expect(succession!.evidence.membershipHandoffGroups).toContain(GROUP_1);
        expect(succession!.score).toBeGreaterThanOrEqual(0.8);
        // Evidence records which side went silent, and evidence-referenced
        // group ids resolve to display labels for the human.
        expect(succession!.evidence.enderJid).toBe(OLD);
        expect(succession!.evidence.starterJid).toBe(NEW);
        expect(succession!.chatLabels[GROUP_1]).toBe("Family");
        // Value-aware sorting inputs: per-side message volume on the DTO.
        expect(succession!.lowMessageCount).toBe(20);
        expect(succession!.highMessageCount).toBe(20);
        // The always-active bystander never pairs as a successor of OLD.
        expect(
          suggestions.some(
            (suggestion) => suggestion.kind === "succession" && [suggestion.jidLow, suggestion.jidHigh].includes(OTHER)
          )
        ).toBe(false);
      });
    });

    it("skips co-members and suppressed pairs", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Rohit" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0], displayName: "Rohit" },
          { sourceJid: OTHER, phoneNumber: OTHER.split("@")[0], displayName: "Rohit" }
        ]);
        await repository.upsertChats(runId, [{ sourceChatId: NEW, jid: NEW, chatType: "dm" }]);
        await repository.upsertMessages([makeMessage(NEW, NEW, "sc-1", T0)]);
        // OLD+OTHER was severed by a user (suppressing exactly that pair),
        // then OLD+NEW became one person.
        await repository.connectIdentities(OLD, OTHER, "user");
        await repository.disconnectIdentities(OTHER);
        await repository.connectIdentities(OLD, NEW, "user");

        await runPersonSuggestionDetectors(repository, { detectors: ["same_name"] });
        const pending = await repository.listPersonSuggestions({ status: "pending", limit: 20 });
        // The only same-name pair not co-membered or suppressed is NEW+OTHER.
        expect(pending).toHaveLength(1);
        expect([pending[0].jidLow, pending[0].jidHigh].sort()).toEqual([NEW, OTHER].sort());
      });
    });

    it("shared vcards corroborate a name match at low score", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "suggest-test" });
        await repository.upsertContacts(runId, [
          { sourceJid: OLD, phoneNumber: OLD.split("@")[0], displayName: "Rohit New Number" },
          { sourceJid: NEW, phoneNumber: NEW.split("@")[0] }
        ]);
        await repository.upsertChats(runId, [{ sourceChatId: OLD, jid: OLD, chatType: "dm" }]);
        await repository.upsertMessages([makeMessage(OLD, OLD, "vcard-carrier", T0)]);
        await repository.upsertArchiveSignals({
          vcards: [
            {
              sourceMessageKey: messageKey(OLD, "vcard-carrier"),
              cardIndex: 0,
              displayName: "Rohit New Number",
              vcard: "BEGIN:VCARD\nFN:Rohit New Number\nEND:VCARD",
              resolvedJid: NEW,
              source: "backup",
              sourceEventKey: "vcard-1",
              observedAtMs: T0,
              captureVersion: 1
            }
          ]
        });
        const summary = await runPersonSuggestionDetectors(repository, { detectors: ["shared_vcard"] });
        expect(summary.created).toBe(1);
        const [suggestion] = await repository.listPersonSuggestions({ status: "pending" });
        expect(suggestion.kind).toBe("shared_vcard");
        expect(suggestion.score).toBe(0.5);
        expect([suggestion.jidLow, suggestion.jidHigh].sort()).toEqual([OLD, NEW].sort());
      });
    });
  });
}
