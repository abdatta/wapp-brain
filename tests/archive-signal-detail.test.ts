import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";

const chatJid = "120363000000000777@g.us";
const phoneJid = "15551234567@s.whatsapp.net";
const sourceMessageId = "detail-message";

async function withRepository<T>(kind: "memory" | "sqlite", run: (repository: ArchiveRepository) => Promise<T>): Promise<T> {
  if (kind === "memory") return run(new MemoryArchiveRepository());
  const directory = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-detail-"));
  const repository = new SqliteArchiveRepository(path.join(directory, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function seed(repository: ArchiveRepository): Promise<{ messageId: number; sourceMessageKey: string; runId: string }> {
  const runId = await repository.startImportRun({ source: "archive-signal-detail" });
  await repository.upsertChats(runId, [{ sourceChatId: chatJid, jid: chatJid, displayName: "Detail Test", chatType: "group" }]);
  const sourceMessageKey = messageKey(chatJid, sourceMessageId);
  await repository.upsertMessages([{
    sourceMessageId,
    sourceMessageKey,
    sourceTable: "synthetic",
    sourceRowId: "1",
    chatSourceId: chatJid,
    senderSourceJid: phoneJid,
    timestampMs: 1_711_000_000_000,
    sentAtIso: "2024-03-21T05:46:40.000Z",
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    body: "Retained message body",
    caption: null,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  }]);
  const chat = (await repository.listChats({ limit: 10, offset: 0 })).find((item) => item.sourceChatId === chatJid)!;
  const message = (await repository.listMessages(chat.id, { limit: 10, offset: 0 }))[0]!;
  return { messageId: message.id, sourceMessageKey, runId };
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`focused archive detail (${kind})`, () => {
    it("merges source observations without leaking rich values into the paginated thread and serves safe card downloads", async () => {
      await withRepository(kind, async (repository) => {
        const { messageId, sourceMessageKey } = await seed(repository);
        const backup = { source: "backup" as const, sourceEventKey: "backup:detail", observedAtMs: 1_711_000_001_000, captureVersion: 1 };
        const live = { source: "live" as const, sourceEventKey: "live:detail", observedAtMs: 1_711_000_002_000, captureVersion: 2 };
        const sourceCard = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Detail Person\r\nitem1.X-ABLABEL:Work\r\nTEL;TYPE=CELL:+15551234567\r\nEND:VCARD\r\n";
        await repository.upsertArchiveSignals({
          locations: [{
            sourceMessageKey, latitude: 37.77, longitude: -122.42, name: "Detailed place", address: null, isLive: true, accuracyMeters: 8,
            url: "https://maps.example.test/retained", comment: "source comment", caption: "source caption", speedMps: 1.25, headingDegrees: 90,
            sequenceNumber: 1, timeOffsetMs: 2_000, liveShareDurationMs: 60_000, finalAtMs: 1_711_000_060_000, hasThumbnail: true, ...backup
          }],
          locationObservations: [{
            observationKey: "backup-location-1", sourceMessageKey, latitude: 37.77, longitude: -122.42, accuracyMeters: 8, speedMps: 1.25,
            headingDegrees: 90, sequenceNumber: 1, timeOffsetMs: 2_000, finalAtMs: 1_711_000_060_000, hasThumbnail: true, ...backup
          }],
          vcards: [
            {
              sourceMessageKey, cardIndex: 0, displayName: "Detail Person", vcard: sourceCard, resolvedJid: phoneJid,
              properties: [{ name: "FN", group: null, parameters: [], value: "Detail Person" }, { name: "X-ABLABEL", group: "item1", parameters: [], value: "Work" }],
              downloadKind: "source", downloadFileName: "Detail Person.vcf", ...backup
            },
            { sourceMessageKey, cardIndex: 1, displayName: "Construct / Name", vcard: null, resolvedJid: phoneJid, downloadKind: "unavailable", ...backup },
            { sourceMessageKey, cardIndex: 2, displayName: "LID only", vcard: null, resolvedJid: "100000000001@lid", downloadKind: "unavailable", ...backup }
          ],
          editEvents: [{ eventKey: "backup-edit", sourceMessageKey, originalSourceMessageId: sourceMessageId, observedEditMessageId: "backup-edit-id", ...backup }],
          deletions: [{ sourceMessageKey, revokedByJid: phoneJid, revokedByAdmin: true, deletionKind: "admin_revoke", ...backup }],
          mediaInterpretations: [{ sourceMessageKey, kind: "transcription_segment", segmentIndex: 0, text: "retained transcript segment", startMs: 0, endMs: 1200, ...backup }]
        });
        await repository.upsertArchiveSignals({
          locations: [{
            sourceMessageKey, latitude: 37.77, longitude: -122.42, name: null, address: "Filled by live", isLive: true, accuracyMeters: null,
            url: null, comment: null, caption: null, speedMps: null, headingDegrees: null, sequenceNumber: null, timeOffsetMs: null,
            liveShareDurationMs: null, finalAtMs: null, hasThumbnail: false, ...live
          }],
          locationObservations: [{
            observationKey: "live-location-2", sourceMessageKey, latitude: 37.78, longitude: -122.41, accuracyMeters: 4, speedMps: 2,
            headingDegrees: 91, sequenceNumber: 2, timeOffsetMs: 3_000, finalAtMs: null, hasThumbnail: false, ...live
          }],
          vcards: [{ sourceMessageKey, cardIndex: 0, displayName: null, vcard: null, resolvedJid: null, downloadKind: "unavailable", ...live }],
          editEvents: [{ eventKey: "live-edit", sourceMessageKey, originalSourceMessageId: sourceMessageId, observedEditMessageId: "live-edit-id", ...live }]
        });

        const detail = await repository.getMessageDetail(messageId);
        expect(detail?.locations[0]).toMatchObject({ latitude: 37.77, longitude: -122.42, name: "Detailed place", address: "Filled by live", isLive: true, sequenceNumber: 1 });
        expect(detail?.locations[0]?.observations.map((item) => item.observationKey)).toEqual(["backup-location-1", "live-location-2"]);
        expect(detail?.locations[0]?.provenance.map((item) => item.source)).toEqual(["backup", "live"]);
        expect(detail?.vcards.map((card) => card.cardIndex)).toEqual([0, 1, 2]);
        expect(detail?.vcards[0]?.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: "X-ABLABEL", value: "Work" })]));
        expect(detail?.editTimeline.map((entry) => ({ kind: entry.kind, timestampMs: entry.timestampMs, text: entry.text }))).toEqual([
          { kind: "sent", timestampMs: 1_711_000_000_000, text: null },
          { kind: "metadata_only_edit", timestampMs: 1_711_000_001_000, text: null },
          { kind: "current", timestampMs: 1_711_000_002_000, text: "Retained message body" }
        ]);
        expect(detail?.deletion).toMatchObject({ revokedByAdmin: true, deletionKind: "admin_revoke", contentState: "retained" });
        expect(detail?.mediaInterpretations[0]?.text).toBe("retained transcript segment");

        await expect(repository.getMessageVcardDownload(messageId, 0)).resolves.toMatchObject({ content: sourceCard, fileName: "Detail Person.vcf", constructed: false });
        await expect(repository.getMessageVcardDownload(messageId, 1)).resolves.toMatchObject({ content: expect.stringContaining("FN:Construct / Name"), fileName: "Construct Name.vcf", constructed: true });
        await expect(repository.getMessageVcardDownload(messageId, 2)).resolves.toBeNull();

        const chat = (await repository.listChats({ limit: 10, offset: 0 }))[0]!;
        const publicMessage = (await repository.listMessages(chat.id, { limit: 10, offset: 0 }))[0]!;
        const publicPayload = JSON.stringify(publicMessage);
        expect(publicPayload).not.toContain("37.77");
        expect(publicPayload).not.toContain("retained transcript segment");
        expect(publicPayload).not.toContain("BEGIN:VCARD");
        expect(publicMessage.structuredSignals?.vcards).toEqual(expect.not.arrayContaining([expect.objectContaining({ resolvedJid: expect.anything() })]));
      });
    });

    it("removes only legacy ambiguous backup self-membership facts during repair", async () => {
      await withRepository(kind, async (repository) => {
        const { sourceMessageKey } = await seed(repository);
        const provenance = { source: "backup" as const, sourceEventKey: "backup:message_system_group:42", observedAtMs: 1_711_000_001_000, captureVersion: 1 };
        await repository.upsertArchiveSignals({
          membershipEvents: [
            { eventKey: "ambiguous-self", groupSourceId: chatJid, participantJid: "me", action: "join", actorJid: null, sourceMessageKey, ...provenance },
            { eventKey: "verified-person", groupSourceId: chatJid, participantJid: phoneJid, action: "join", actorJid: null, sourceMessageKey, ...provenance }
          ]
        });
        expect(await repository.repairAmbiguousSelfMembershipFacts()).toBe(1);
        expect(await repository.listGroupMembershipEvents({ groupSourceId: chatJid })).toEqual([
          expect.objectContaining({ participantJid: phoneJid, action: "join" })
        ]);
      });
    });

    it("returns an honest local generic-system detail when no verified companion can be decoded", async () => {
      await withRepository(kind, async (repository) => {
        await seed(repository);
        const sourceSystemKey = messageKey(chatJid, "generic-system");
        await repository.upsertMessages([{
          sourceMessageId: "generic-system", sourceMessageKey: sourceSystemKey, sourceTable: "synthetic-system", sourceRowId: "2",
          chatSourceId: chatJid, senderSourceJid: null, timestampMs: 1_711_000_010_000, sentAtIso: "2024-03-21T05:46:50.000Z",
          fromMe: null, direction: "system", messageType: "system", rawTypeCode: "UNVERIFIED_SYSTEM_ACTION", body: null, caption: null,
          hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false, rawMetadata: { source: "synthetic", action: "unverified" }
        }]);
        const chat = (await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true }))[0]!;
        const system = (await repository.listMessages(chat.id, { limit: 10, offset: 0 })).find((item) => item.sourceMessageId === "generic-system")!;
        const detail = await repository.getMessageDetail(system.id);
        expect(detail?.systemEvents).toEqual([expect.objectContaining({ kind: "generic", summary: "System event", rawType: "UNVERIFIED_SYSTEM_ACTION" })]);
        expect(detail?.availability.hasEditHistory).toBe(false);
        expect(detail?.editTimeline).toEqual([]);
      });
    });

    it("labels system roles by name, then full phone number, then Unknown", async () => {
      await withRepository(kind, async (repository) => {
        const { messageId, sourceMessageKey, runId } = await seed(repository);
        const namedActor = "15550000001@s.whatsapp.net";
        const phoneActor = "15550000002@s.whatsapp.net";
        const internalLid = "244341310251050@lid";
        await repository.upsertContacts(runId, [{ sourceJid: namedActor, displayName: "Named Actor", phoneNumber: "15550000001" }]);
        const provenance = { source: "backup" as const, sourceEventKey: "backup:identity-labels", captureVersion: 1 };
        await repository.upsertArchiveSignals({ membershipEvents: [
          { eventKey: "label-1-name", groupSourceId: chatJid, participantJid: phoneJid, action: "add", actorJid: namedActor, sourceMessageKey, observedAtMs: 1_711_000_020_000, ...provenance },
          { eventKey: "label-2-phone", groupSourceId: chatJid, participantJid: phoneJid, action: "add", actorJid: phoneActor, sourceMessageKey, observedAtMs: 1_711_000_021_000, ...provenance },
          { eventKey: "label-3-unknown", groupSourceId: chatJid, participantJid: internalLid, action: "add", actorJid: null, sourceMessageKey, observedAtMs: 1_711_000_022_000, ...provenance }
        ] });

        const detail = await repository.getMessageDetail(messageId);
        expect(detail?.systemEvents.map((event) => event.summary)).toEqual([
          "Named Actor added +15551234567 to the group.",
          "+15550000002 added +15551234567 to the group.",
          "Unknown added Unknown to the group."
        ]);
        expect(detail?.systemEvents.map((event) => [event.actorLabel, event.participantLabel])).toEqual([
          ["Named Actor", "+15551234567"],
          ["+15550000002", "+15551234567"],
          ["Unknown", "Unknown"]
        ]);
      });
    });

    it("rekeys corrected edit observations and removes the legacy envelope-time duplicate", async () => {
      await withRepository(kind, async (repository) => {
        const { messageId, sourceMessageKey } = await seed(repository);
        await repository.upsertArchiveSignals({ editEvents: [{
          eventKey: "legacy-live", sourceMessageKey, originalSourceMessageId: null, observedEditMessageId: null,
          source: "live", sourceEventKey: `wa-web:edit:${sourceMessageKey}:1711000000000`, observedAtMs: 1_711_000_000_000, captureVersion: 1
        }] });
        await repository.upsertArchiveSignals({ editEvents: [{
          eventKey: "backup-server-time", sourceMessageKey, originalSourceMessageId: sourceMessageId, observedEditMessageId: "EDIT1",
          source: "backup", sourceEventKey: "backup:message_edit_info:1", observedAtMs: 1_711_000_002_000, captureVersion: 1
        }] });
        await repository.upsertArchiveSignals({ editEvents: [{
          eventKey: "backup-sender-time", sourceMessageKey, originalSourceMessageId: sourceMessageId, observedEditMessageId: "EDIT1",
          source: "backup", sourceEventKey: "backup:message_edit_info:1", observedAtMs: 1_711_000_001_500, captureVersion: 2
        }] });

        const detail = await repository.getMessageDetail(messageId);
        expect(detail?.editTimeline.map((entry) => ({ kind: entry.kind, timestampMs: entry.timestampMs }))).toEqual([
          { kind: "sent", timestampMs: 1_711_000_000_000 },
          { kind: "current", timestampMs: 1_711_000_001_500 }
        ]);
      });
    });

    it("rebinds an equivalent synthetic live system anchor to the real backup message without duplication", async () => {
      await withRepository(kind, async (repository) => {
        await seed(repository);
        const realKey = messageKey(chatJid, "backup-system-anchor");
        const syntheticKey = messageKey(chatJid, "live-system-member-add");
        await repository.upsertMessages([
          {
            sourceMessageId: "backup-system-anchor", sourceMessageKey: realKey, sourceTable: "backup-system", sourceRowId: "3", chatSourceId: chatJid,
            senderSourceJid: null, timestampMs: 1_711_000_020_000, fromMe: null, direction: "system", messageType: "system", body: null, caption: null,
            hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false
          },
          {
            sourceMessageId: "live-system-member-add", sourceMessageKey: syntheticKey, sourceTable: "wa-web-system", sourceRowId: "4", chatSourceId: chatJid,
            senderSourceJid: null, timestampMs: 1_711_000_020_000, fromMe: null, direction: "system", messageType: "system", body: null, caption: null,
            hasMedia: false, isDeleted: false, isForwarded: false, isStarred: false
          }
        ]);
        const base = { groupSourceId: chatJid, participantJid: phoneJid, action: "add" as const, actorJid: null, observedAtMs: 1_711_000_020_000, captureVersion: 1 };
        await repository.upsertArchiveSignals({ membershipEvents: [{ eventKey: "live-anchor", sourceMessageKey: syntheticKey, source: "live", sourceEventKey: "live:member-add", ...base }] });
        await repository.upsertArchiveSignals({ membershipEvents: [{ eventKey: "backup-anchor", sourceMessageKey: realKey, source: "backup", sourceEventKey: "backup:member-add", ...base }] });

        const facts = await repository.listGroupMembershipEvents({ groupSourceId: chatJid });
        const anchored = facts.filter((event) => event.participantJid === phoneJid && event.observedAtMs === 1_711_000_020_000);
        expect(anchored).toEqual([expect.objectContaining({ sourceMessageKey: realKey })]);
        const chat = (await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true }))[0]!;
        const realMessage = (await repository.listMessages(chat.id, { limit: 20, offset: 0 })).find((message) => message.sourceMessageId === "backup-system-anchor")!;
        const detail = await repository.getMessageDetail(realMessage.id);
        expect(detail?.systemEvents[0]?.observations.map((observation) => observation.source)).toEqual(expect.arrayContaining(["backup", "live"]));
        expect(detail?.systemEvents[0]?.observations).toHaveLength(2);
      });
    });

    it("uses the same canonical precedence in backup-first and live-first replays", async () => {
      const capture = async (order: Array<"backup" | "live">) => withRepository(kind, async (repository) => {
        const { sourceMessageKey } = await seed(repository);
        const base = { groupSourceId: chatJid, participantJid: phoneJid, action: "promote" as const, actorJid: "15550000001@s.whatsapp.net", sourceMessageKey, observedAtMs: 1_711_000_030_000, captureVersion: 1 };
        const inputs = {
          backup: { eventKey: "backup-promote", source: "backup" as const, sourceEventKey: "backup:promote", ...base },
          live: { eventKey: "live-promote", source: "live" as const, sourceEventKey: "live:promote", ...base }
        };
        for (const source of order) await repository.upsertArchiveSignals({ membershipEvents: [inputs[source]] });
        const fact = (await repository.listGroupMembershipEvents({ groupSourceId: chatJid }))[0]!;
        return { source: fact.source, sourceEventKey: fact.sourceEventKey, action: fact.action, actorJid: fact.actorJid };
      });
      const backupFirst = await capture(["backup", "live"]);
      const liveFirst = await capture(["live", "backup"]);
      expect(backupFirst).toEqual({ source: "live", sourceEventKey: "live:promote", action: "promote", actorJid: "15550000001@s.whatsapp.net" });
      expect(liveFirst).toEqual(backupFirst);
    });
  });
}
