import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ArchiveRepository } from "../src/server/db/repository";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import { createSignalCaptureFixture, createSyntheticFixture } from "../src/server/import/fixtures";
import { runImport } from "../src/server/import/importer";
import { computeArchiveSignalAnchors, renderEvidenceLines, type BrainEvidencePack } from "../src/server/brain/episodes";

const chatJid = "120363000000000099@g.us";
const lidJid = "123456789000001@lid";
const phoneJid = "15550000009@s.whatsapp.net";

async function seedMessage(repository: ArchiveRepository): Promise<string> {
  const runId = await repository.startImportRun({ source: "synthetic-signal-test" });
  await repository.upsertChats(runId, [{ sourceChatId: chatJid, jid: chatJid, displayName: "Synthetic Signal Group", chatType: "group" }]);
  const sourceMessageId = "signal-message";
  const sourceMessageKey = messageKey(chatJid, sourceMessageId);
  await repository.upsertMessages([
    {
      sourceMessageId,
      sourceMessageKey,
      sourceTable: "message",
      sourceRowId: "1",
      chatSourceId: chatJid,
      senderSourceJid: lidJid,
      timestampMs: 1_710_000_000_000,
      sentAtIso: "2024-03-09T16:00:00.000Z",
      fromMe: false,
      direction: "incoming",
      messageType: "text",
      body: "Synthetic source message",
      caption: null,
      hasMedia: false,
      isDeleted: false,
      isForwarded: false,
      isStarred: false,
      mentionedJids: [lidJid]
    }
  ]);
  return sourceMessageKey;
}

async function withRepository<T>(
  kind: "memory" | "sqlite",
  run: (repository: ArchiveRepository) => Promise<T>
): Promise<T> {
  if (kind === "memory") {
    return run(new MemoryArchiveRepository());
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-signal-store-"));
  const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
  try {
    return await run(repository);
  } finally {
    await repository.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`archive signal repository (${kind})`, () => {
    it("keeps replay idempotent, fills nulls, protects existing state, and rekeys JID-bearing signals", async () => {
      await withRepository(kind, async (repository) => {
        const sourceMessageKey = await seedMessage(repository);
        const baseline = {
          source: "live" as const,
          sourceEventKey: "live:signal:1",
          observedAtMs: 1_710_000_000_100,
          captureVersion: 1
        };
        const first = await repository.upsertArchiveSignals({
          locations: [
            {
              sourceMessageKey,
              latitude: 1,
              longitude: 2,
              name: "Live label",
              address: null,
              isLive: false,
              accuracyMeters: null,
              ...baseline
            }
          ],
          vcards: [
            {
              sourceMessageKey,
              cardIndex: 0,
              displayName: "Synthetic Card",
              vcard: "BEGIN:VCARD\nFN:Synthetic Card\nEND:VCARD",
              resolvedJid: lidJid,
              ...baseline
            }
          ],
          deletions: [{ sourceMessageKey, revokedByJid: lidJid, ...baseline }],
          mediaInterpretations: [
            {
              sourceMessageKey,
              kind: "transcription",
              segmentIndex: 0,
              text: "synthetic transcript",
              startMs: null,
              endMs: null,
              ...baseline
            }
          ],
          numberChanges: [
            {
              eventKey: "number-change:1",
              chatSourceId: chatJid,
              sourceMessageKey,
              oldJid: lidJid,
              newJid: phoneJid,
              actorJid: lidJid,
              ...baseline
            }
          ],
          membershipPeriods: [
            {
              periodKey: "membership-period:1",
              groupSourceId: chatJid,
              participantJid: lidJid,
              joinedAtMs: 1_710_000_000_000,
              leftAtMs: null,
              role: null,
              ...baseline
            }
          ],
          membershipEvents: [
            {
              eventKey: "membership-event:1",
              groupSourceId: chatJid,
              participantJid: lidJid,
              action: "add",
              actorJid: lidJid,
              sourceMessageKey,
              ...baseline
            }
          ],
          chatMetadataHistory: [
            {
              eventKey: "metadata:1",
              chatSourceId: chatJid,
              field: "subject",
              sourceMessageKey,
              actorJid: lidJid,
              oldValue: null,
              newValue: "Synthetic Signal Group",
              ...baseline
            }
          ],
          engagementAggregates: [
            {
              aggregateKey: "engagement:1",
              chatSourceId: chatJid,
              counterpartyJid: null,
              eligibleOutgoingCount: 2,
              deliveredCount: 2,
              readCount: 1,
              responseLatencySampleCount: 1,
              medianResponseLatencyMs: 250,
              windowStartAtMs: 1_710_000_000_000,
              windowEndAtMs: 1_710_000_000_500,
              algorithmVersion: 1,
              ...baseline
            }
          ]
        });
        expect(first.changedMessageKeys).toContain(sourceMessageKey);
        const orphaned = await repository.upsertArchiveSignals({
          locations: [
            {
              sourceMessageKey: messageKey(chatJid, "missing-source-message"),
              latitude: 1,
              longitude: 2,
              name: "Orphaned location",
              address: null,
              isLive: false,
              accuracyMeters: null,
              ...baseline
            }
          ]
        });
        expect(orphaned).toEqual({ changedMessageKeys: [], skippedUnanchoredRecords: 1 });
        // Consumer contract: a captured pair is queryable with explicit
        // provenance/version, but recording it never asserts an identity link
        // or auto-connects either person.
        expect(await repository.listIdentityNumberChanges({ oldJid: lidJid })).toEqual([
          expect.objectContaining({ oldJid: lidJid, newJid: phoneJid, source: "live", captureVersion: 1 })
        ]);
        expect(await repository.resolveIdentityJid(lidJid)).toBe(lidJid);
        expect(await repository.resolveIdentityJid(phoneJid)).toBe(phoneJid);
        const replay = await repository.upsertArchiveSignals({
          locations: [
            {
              sourceMessageKey,
              latitude: 1,
              longitude: 2,
              name: "Live label",
              address: null,
              isLive: false,
              accuracyMeters: null,
              ...baseline
            }
          ]
        });
        expect(replay.changedMessageKeys).toEqual([]);

        await repository.upsertArchiveSignals({
          locations: [
            {
              sourceMessageKey,
              latitude: 99,
              longitude: 98,
              name: "Backup label must not replace live",
              address: "Filled only because it was null",
              isLive: true,
              accuracyMeters: 3,
              source: "backup",
              sourceEventKey: "backup:signal:1",
              observedAtMs: 1_710_000_000_200,
              captureVersion: 1
            }
          ]
        });
        const chat = (await repository.listChats({ limit: 10, offset: 0 })).find((candidate) => candidate.sourceChatId === chatJid);
        const message = chat ? (await repository.listMessages(chat.id, { limit: 10, offset: 0 })).find((candidate) => candidate.sourceMessageId === "signal-message") : null;
        expect(message?.structuredSignals?.location).toMatchObject({ name: "Live label", address: "Filled only because it was null", isLive: true });
        expect(message?.structuredSignals?.vcards).toEqual([{ displayName: "Synthetic Card" }]);
        expect(JSON.stringify(message)).not.toContain("BEGIN:VCARD");
        expect(await repository.listEngagementAggregates({ chatSourceId: chatJid })).toHaveLength(1);

        await repository.recordIdentityLinks([{ lid: lidJid, pn: phoneJid, source: "synthetic" }]);
        await repository.mergeIdentity(lidJid, phoneJid);
        expect((await repository.listIdentityNumberChanges({ oldJid: phoneJid }))[0]).toMatchObject({ oldJid: phoneJid, newJid: phoneJid, actorJid: phoneJid });
        expect((await repository.listGroupMembershipPeriods({ participantJid: phoneJid }))[0]?.participantJid).toBe(phoneJid);
        expect((await repository.listGroupMembershipEvents({ participantJid: phoneJid }))[0]?.actorJid).toBe(phoneJid);
        expect((await repository.listChatMetadataHistory({ chatSourceId: chatJid }))[0]?.actorJid).toBe(phoneJid);

        const episode = await repository.commitBrainEpisode({
          chatSourceId: chatJid,
          startAtMs: 1_710_000_000_000,
          endAtMs: 1_710_000_000_000,
          messageCount: 1,
          participants: ["Synthetic Sender"],
          summary: "Synthetic episode",
          markdown: "",
          generator: "extractive",
          model: null,
          runId: null,
          extractionVersion: 4,
          archiveSignalAnchors: [{ sourceMessageKey, kinds: ["vcard"], captureVersion: 1 }],
          claims: []
        });
        await repository.upsertArchiveSignals({
          vcards: [
            {
              sourceMessageKey,
              cardIndex: 1,
              displayName: "Additional Card",
              vcard: "BEGIN:VCARD\nFN:Additional Card\nEND:VCARD",
              resolvedJid: phoneJid,
              source: "backup",
              sourceEventKey: "backup:vcard:1",
              observedAtMs: 1_710_000_000_300,
              captureVersion: 1
            }
          ]
        });
        expect((await repository.listBrainEpisodes({ episodeId: episode.id, limit: 1 }))[0]?.status).toBe("stale");
        const regenerationTasks = await repository.claimDueBrainTasks(10);
        expect(regenerationTasks).toHaveLength(1);
        expect(regenerationTasks[0]).toMatchObject({ kind: "episode", payload: expect.objectContaining({ regen: true, episodeId: episode.id }) });

        await repository.clearArchiveData();
        expect(await repository.listIdentityNumberChanges()).toEqual([]);
        expect(await repository.listGroupMembershipPeriods()).toEqual([]);
        expect(await repository.listEngagementAggregates()).toEqual([]);
      });
    });

    it("repairs the legacy seconds-as-milliseconds live-location duration on replay", async () => {
      await withRepository(kind, async (repository) => {
        const sourceMessageKey = await seedMessage(repository);
        const location = {
          sourceMessageKey,
          latitude: 37.7,
          longitude: -122.4,
          name: null,
          address: null,
          isLive: true,
          accuracyMeters: null,
          source: "backup" as const,
          sourceEventKey: "backup:message_location:1",
          observedAtMs: 1_710_000_000_000,
          captureVersion: 1
        };
        await repository.upsertArchiveSignals({
          locations: [{ ...location, liveShareDurationMs: 3_599 }]
        });
        await repository.upsertArchiveSignals({
          locations: [{ ...location, liveShareDurationMs: 3_599_000 }]
        });

        const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
        const message = (await repository.listMessages(chat.id, { limit: 1, offset: 0 }))[0]!;
        expect((await repository.getMessageDetail(message.id))?.locations[0]?.liveShareDurationMs).toBe(3_599_000);
      });
    });

    it("repairs a static location falsely marked live by legacy SQL-null coercion", async () => {
      await withRepository(kind, async (repository) => {
        const sourceMessageKey = await seedMessage(repository);
        const location = {
          sourceMessageKey,
          latitude: 40.71,
          longitude: -74,
          name: "Static place",
          address: null,
          accuracyMeters: null,
          source: "backup" as const,
          sourceEventKey: "backup:message_location:static",
          observedAtMs: 1_710_000_000_000,
          captureVersion: 1
        };
        await repository.upsertArchiveSignals({
          locations: [{ ...location, isLive: true, liveShareDurationMs: 0, sequenceNumber: 0, finalAtMs: null }]
        });
        await repository.upsertArchiveSignals({
          locations: [{ ...location, isLive: false, liveShareDurationMs: null, sequenceNumber: null, finalAtMs: null }]
        });

        const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
        const message = (await repository.listMessages(chat.id, { limit: 1, offset: 0 }))[0]!;
        expect((await repository.getMessageDetail(message.id))?.locations[0]).toMatchObject({
          isLive: false,
          liveShareDurationMs: null,
          sequenceNumber: null
        });
      });
    });

    it("repairs legacy zero-length transcript ranges when the source duration is unavailable", async () => {
      await withRepository(kind, async (repository) => {
        const sourceMessageKey = await seedMessage(repository);
        const segment = {
          sourceMessageKey,
          kind: "transcription_segment" as const,
          segmentIndex: 0,
          text: "word",
          startMs: 159,
          source: "backup" as const,
          sourceEventKey: "backup:transcription_segment:1",
          observedAtMs: 1_710_000_000_000,
          captureVersion: 1
        };
        await repository.upsertArchiveSignals({ mediaInterpretations: [{ ...segment, endMs: 159 }] });
        await repository.upsertArchiveSignals({ mediaInterpretations: [{ ...segment, endMs: null }] });

        const chat = (await repository.listChats({ limit: 1, offset: 0 }))[0]!;
        const message = (await repository.listMessages(chat.id, { limit: 1, offset: 0 }))[0]!;
        expect((await repository.getMessageDetail(message.id))?.mediaInterpretations[0]).toMatchObject({ startMs: 159, endMs: null });
      });
    });

    it("summarizes verified system history for the thread without exposing identity endpoints", async () => {
      await withRepository(kind, async (repository) => {
        const runId = await repository.startImportRun({ source: "system-event-thread" });
        const oldJid = "15559990001@s.whatsapp.net";
        const newJid = "15559990002@s.whatsapp.net";
        await repository.upsertChats(runId, [{ sourceChatId: chatJid, jid: chatJid, displayName: "System History Group", chatType: "group" }]);
        await repository.upsertContacts(runId, [
          { sourceJid: oldJid, displayName: "Avery" },
          { sourceJid: newJid, displayName: "Blake" }
        ]);
        const systemMessage = (sourceMessageId: string, timestampMs: number) => ({
          sourceMessageId,
          sourceMessageKey: messageKey(chatJid, sourceMessageId),
          sourceTable: "synthetic-system",
          sourceRowId: sourceMessageId,
          chatSourceId: chatJid,
          senderSourceJid: null,
          timestampMs,
          sentAtIso: new Date(timestampMs).toISOString(),
          fromMe: null,
          direction: "system" as const,
          messageType: "system",
          body: null,
          caption: null,
          hasMedia: false,
          isDeleted: false,
          isForwarded: false,
          isStarred: false
        });
        const number = systemMessage("number-change", 1_710_100_000_000);
        const member = systemMessage("group-join", 1_710_100_001_000);
        const subject = systemMessage("subject-change", 1_710_100_002_000);
        const unknown = systemMessage("unknown-system", 1_710_100_003_000);
        await repository.upsertMessages([number, member, subject, unknown]);
        await repository.upsertArchiveSignals({
          numberChanges: [
            {
              eventKey: "private-number-change-key",
              chatSourceId: chatJid,
              sourceMessageKey: number.sourceMessageKey,
              oldJid,
              newJid,
              actorJid: null,
              source: "backup",
              sourceEventKey: "private-number-change-source-key",
              observedAtMs: number.timestampMs,
              captureVersion: 1
            }
          ],
          membershipEvents: [
            {
              eventKey: "private-membership-key",
              groupSourceId: chatJid,
              participantJid: oldJid,
              action: "join",
              actorJid: null,
              sourceMessageKey: member.sourceMessageKey,
              source: "backup",
              sourceEventKey: "private-membership-source-key",
              observedAtMs: member.timestampMs,
              captureVersion: 1
            }
          ],
          chatMetadataHistory: [
            {
              eventKey: "private-subject-key",
              chatSourceId: chatJid,
              field: "subject",
              sourceMessageKey: subject.sourceMessageKey,
              actorJid: oldJid,
              oldValue: null,
              newValue: "New\n  group subject",
              source: "backup",
              sourceEventKey: "private-subject-source-key",
              observedAtMs: subject.timestampMs,
              captureVersion: 1
            }
          ]
        });

        const chat = (await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true })).find((candidate) => candidate.sourceChatId === chatJid)!;
        const messages = await repository.listMessages(chat.id, { limit: 10, offset: 0 });
        expect(messages.find((message) => message.sourceMessageId === "number-change")?.systemEvents).toEqual([
          { kind: "number_change", summary: "Blake changed their phone number.", captureVersion: 1 }
        ]);
        expect(messages.find((message) => message.sourceMessageId === "group-join")?.systemEvents).toEqual([
          { kind: "membership", summary: "Avery joined the group.", captureVersion: 1 }
        ]);
        expect(messages.find((message) => message.sourceMessageId === "subject-change")?.systemEvents).toEqual([
          { kind: "chat_metadata", summary: "Avery changed the group subject to “New group subject”.", captureVersion: 1 }
        ]);
        expect(messages.find((message) => message.sourceMessageId === "unknown-system")?.systemEvents).toEqual([]);
        const publicPayload = JSON.stringify(messages);
        expect(publicPayload).not.toContain(oldJid);
        expect(publicPayload).not.toContain(newJid);
        expect(publicPayload).not.toContain("private-number-change-key");
      });
    });
  });
}

describe("archive signal backup import", () => {
  it("imports every supported backup signal family idempotently without exposing payloads through status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-signal-fixture-"));
    try {
      const fixture = await createSignalCaptureFixture(path.join(tempDir, "fixture"));
      const repository = new MemoryArchiveRepository();
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });

      const numberChanges = await repository.listIdentityNumberChanges();
      const periods = await repository.listGroupMembershipPeriods();
      const events = await repository.listGroupMembershipEvents();
      const metadata = await repository.listChatMetadataHistory();
      const engagement = await repository.listEngagementAggregates();
      const chats = await repository.listChats({ limit: 20, offset: 0 });
      const group = chats.find((chat) => chat.sourceChatId === "120363000000000002@g.us");
      const messages = group ? await repository.listMessages(group.id, { limit: 20, offset: 0 }) : [];
      const allMessages = (await Promise.all(chats.map((chat) => repository.listMessages(chat.id, { limit: 20, offset: 0 })))).flat();
      const sourceMessage = messages.find((message) => message.sourceMessageId === "modern-group-1");
      const mediaMessage = messages.find((message) => message.sourceMessageId === "modern-group-2");
      const staticLocationMessage = allMessages.find((message) => message.sourceMessageId === "modern-direct-1");
      const preview = sourceMessage?.linkPreview;
      const sourceDetail = sourceMessage ? await repository.getMessageDetail(sourceMessage.id) : null;
      const staticLocationDetail = staticLocationMessage ? await repository.getMessageDetail(staticLocationMessage.id) : null;

      expect(numberChanges).toHaveLength(1);
      expect(periods.length).toBeGreaterThanOrEqual(2);
      // `is_me_joined` alone is deliberately no longer promoted to a false
      // owner membership event; only structurally linked participants count.
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((event) => event.participantJid === "me")).toBe(false);
      expect(metadata).toHaveLength(2);
      expect(engagement).toHaveLength(2);
      expect(sourceMessage?.structuredSignals?.mentionCount).toBe(2);
      expect(sourceMessage?.structuredSignals?.location).toMatchObject({ isLive: true, name: "Synthetic Park" });
      expect(sourceDetail?.locations[0]).toMatchObject({ liveShareDurationMs: 300_000 });
      expect(staticLocationDetail?.locations[0]).toMatchObject({
        name: "Synthetic Static Place",
        isLive: false,
        liveShareDurationMs: null,
        sequenceNumber: null
      });
      expect(sourceMessage?.structuredSignals?.vcards).toHaveLength(2);
      expect(preview).toMatchObject({ title: "Synthetic preview", canonicalUrl: "https://example.test/signal", hasThumbnail: true });
      expect(mediaMessage?.structuredSignals?.mediaInterpretations.map((entry) => entry.kind)).toEqual([
        "accessibility_label",
        "transcription",
        "transcription_segment",
        "transcription_segment"
      ]);
      const evidence = await repository.listMemoryEvidenceMessages({ limit: 20 });
      const evidenceSource = evidence.find((message) => message.sourceMessageId === "modern-group-1");
      const evidenceMedia = evidence.find((message) => message.sourceMessageId === "modern-group-2");
      expect(evidenceSource?.structuredSignals?.mentionedJids).toEqual(["15550000002@s.whatsapp.net", "15550000003@s.whatsapp.net"]);
      expect(evidenceSource?.structuredSignals?.location).toMatchObject({ latitude: 37.77, longitude: -122.42, name: "Synthetic Park" });
      expect(evidenceSource?.structuredSignals?.vcards).toEqual(expect.arrayContaining([{ displayName: "Synthetic Friend", resolvedJid: "15550000002@s.whatsapp.net" }]));
      expect(evidenceMedia?.structuredSignals?.mediaInterpretations).toEqual(expect.arrayContaining([expect.objectContaining({ text: "one two three" })]));
      const publicPayload = JSON.stringify({ messages, status: await repository.getStatus() });
      expect(publicPayload).not.toContain("Synthetic document label");
      expect(publicPayload).not.toContain("one two three");
      expect(publicPayload).not.toContain("37.77");
      expect(publicPayload).not.toContain("BEGIN:VCARD");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-imports the complete signal matrix into SQLite with stable counts and safe public summaries", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-signal-sqlite-import-"));
    const repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
    try {
      const fixture = await createSignalCaptureFixture(path.join(tempDir, "fixture"));
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });
      const group = (await repository.listChats({ limit: 20, offset: 0 })).find((chat) => chat.sourceChatId === "120363000000000002@g.us")!;
      const messages = await repository.listMessages(group.id, { limit: 20, offset: 0 });
      const source = messages.find((message) => message.sourceMessageId === "modern-group-1");

      expect(await repository.listIdentityNumberChanges()).toHaveLength(1);
      expect(await repository.listEngagementAggregates()).toHaveLength(2);
      expect(source?.structuredSignals).toMatchObject({ mentionCount: 2, location: { name: "Synthetic Park" } });
      expect(source?.linkPreview).toMatchObject({ title: "Synthetic preview", hasThumbnail: true });
      expect(JSON.stringify({ messages, status: await repository.getStatus() })).not.toContain("BEGIN:VCARD");
    } finally {
      await repository.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues through legacy and iOS-shaped optional schema gaps while keeping malformed companion warnings payload-free", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-signal-schema-"));
    try {
      const legacy = await createSyntheticFixture(path.join(tempDir, "legacy"));
      const legacyRepository = new MemoryArchiveRepository();
      await runImport(legacyRepository, { msgstorePath: legacy.msgstorePath, waPath: legacy.waPath });
      expect((await legacyRepository.getStatus()).counts.messages).toBeGreaterThan(0);

      const iosShaped = await createSignalCaptureFixture(path.join(tempDir, "ios-shaped"));
      const db = new Database(iosShaped.msgstorePath);
      try {
        // Optional companions vary by platform/version. Their absence must not
        // downgrade the ordinary message archive or other signal families.
        db.exec("ALTER TABLE message_location RENAME TO ZWAMESSAGELOCATION; ALTER TABLE receipt_device RENAME TO ZWARECEIPTDEVICE;");
        db.prepare("INSERT INTO message_vcard (_id, message_row_id, vcard) VALUES (?, ?, ?)").run(999, 999999, "CANARY_VCARD_DO_NOT_EXPOSE");
      } finally {
        db.close();
      }
      const repository = new MemoryArchiveRepository();
      await runImport(repository, { msgstorePath: iosShaped.msgstorePath, waPath: iosShaped.waPath });
      const status = await repository.getStatus();
      const group = (await repository.listChats({ limit: 20, offset: 0 })).find((chat) => chat.sourceChatId === "120363000000000002@g.us");
      const messages = group ? await repository.listMessages(group.id, { limit: 20, offset: 0 }) : [];
      expect(messages.find((message) => message.sourceMessageId === "modern-group-1")?.structuredSignals?.vcards).toHaveLength(2);
      expect(status.latestWarnings.some((warning) => warning.code === "SIGNAL_VCARDS_ROW_SKIPPED")).toBe(true);
      expect(JSON.stringify(status)).not.toContain("CANARY_VCARD_DO_NOT_EXPOSE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("computes engagement samples and group history over a large synthetic companion set without retaining raw receipts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-signal-large-"));
    try {
      const fixture = await createSignalCaptureFixture(path.join(tempDir, "fixture"));
      const db = new Database(fixture.msgstorePath);
      try {
        const insertMessage = db.prepare(
          "INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, quoted_message_row_id, status, starred, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        const insertReceipt = db.prepare("INSERT INTO receipt_user (_id, message_row_id, receipt_user_jid_row_id, receipt_timestamp, read_timestamp) VALUES (?, ?, ?, ?, ?)");
        const insertHistory = db.prepare("INSERT INTO group_participants_history (_id, timestamp, gjid, jid, action) VALUES (?, ?, ?, ?, ?)");
        const populate = db.transaction(() => {
          for (let index = 0; index < 1_000; index += 1) {
            const messageId = 10_000 + index * 2;
            const timestamp = 1_720_000_000_000 + index * 1_000;
            insertMessage.run(messageId, 10, 1, 1, `bulk-outgoing-${index}`, timestamp, 0, null, 0, 0, 0);
            insertMessage.run(messageId + 1, 10, 1, 0, `bulk-incoming-${index}`, timestamp + 500, 0, null, 0, 0, 0);
            insertReceipt.run(10_000 + index, messageId, 1, timestamp + 100, timestamp + 200);
            insertHistory.run(10_000 + index, timestamp, "120363000000000002@g.us", "15550000004@s.whatsapp.net", "add");
          }
        });
        populate();
      } finally {
        db.close();
      }
      const repository = new MemoryArchiveRepository();
      await runImport(repository, { msgstorePath: fixture.msgstorePath, waPath: fixture.waPath });
      const directAggregate = (await repository.listEngagementAggregates()).find((aggregate) => aggregate.chatSourceId === "15550000001@s.whatsapp.net");
      // The compact fixture contributes one pre-existing direct response in
      // addition to the 1,000 generated pairs.
      expect(directAggregate).toMatchObject({ responseLatencySampleCount: 1_001, medianResponseLatencyMs: 500, algorithmVersion: 1 });
      expect((await repository.listGroupMembershipEvents({ limit: 1_500 })).length).toBeGreaterThanOrEqual(1_002);
      expect(JSON.stringify(await repository.getStatus())).not.toContain("receipt_user_jid_row_id");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("archive signal evidence", () => {
  it("renders bounded source annotations on the owning alias and stamps no sensitive payloads", () => {
    const message = {
      citationLabel: "m1",
      messageId: 1,
      sourceMessageKey: messageKey(chatJid, "signal-evidence"),
      sourceMessageId: "signal-evidence",
      sourceChatId: chatJid,
      chatId: 1,
      chatDisplayName: "Synthetic Signal Group",
      senderSourceJid: "15550000002@s.whatsapp.net",
      senderDisplayName: "Synthetic Sender",
      timestampMs: 1_710_000_000_000,
      sentAt: "2024-03-09T16:00:00.000Z",
      direction: "incoming" as const,
      messageType: "text",
      interpretation: null,
      text: "A normal synthetic message.",
      linkPreview: { title: "Preview title", description: "Preview summary", canonicalUrl: "https://example.test", hasThumbnail: true },
      isForwarded: false,
      quotedSourceMessageId: null,
      quotedSnapshot: null,
      reactions: [],
      senderNameIsPushName: false,
      structuredSignals: {
        mentionedJids: ["15550000003@s.whatsapp.net"],
        location: { latitude: 37.77, longitude: -122.42, name: "Synthetic Park", address: null, isLive: false },
        vcards: [{ displayName: "Synthetic Card", resolvedJid: "15550000003@s.whatsapp.net" }],
        deletion: { revokedByJid: "15550000002@s.whatsapp.net", revokedAtMs: 1_710_000_000_100 },
        edit: { observedAtMs: 1_710_000_000_050, hasHeldRevision: false },
        mediaInterpretations: [{ kind: "transcription" as const, text: "source-provided synthetic transcription", segmentIndex: 0 }],
        captureVersion: 1
      }
    };
    const pack: BrainEvidencePack = {
      chatSourceId: chatJid,
      chatDisplayName: "Synthetic Signal Group",
      startAtMs: message.timestampMs,
      endAtMs: message.timestampMs,
      messages: [message],
      participants: ["Synthetic Sender"]
    };
    const line = renderEvidenceLines(pack).join("\n");
    const anchors = computeArchiveSignalAnchors(pack);

    expect(line).toContain("m1 |");
    expect(line).toContain("[location: Synthetic Park]");
    expect(line).toContain("[link preview: Preview title — Preview summary]");
    expect(line).toContain("[source transcription: \"source-provided synthetic transcription\"]");
    expect(line).not.toContain("BEGIN:VCARD");
    expect(anchors).toEqual([
      expect.objectContaining({
        sourceMessageKey: message.sourceMessageKey,
        kinds: expect.arrayContaining(["mention", "location", "vcard", "link_preview", "edit", "deletion", "media_interpretation"]),
        captureVersion: 1
      })
    ]);
    expect(JSON.stringify(anchors)).not.toContain("source-provided synthetic transcription");

    const oversized = {
      ...message,
      structuredSignals: {
        ...message.structuredSignals,
        mediaInterpretations: [{ kind: "transcription" as const, text: "x".repeat(2_000), segmentIndex: 0 }]
      }
    };
    const boundedLine = renderEvidenceLines({ ...pack, messages: [oversized] }).join("\n");
    expect(boundedLine).toContain("[source transcription:");
    expect(boundedLine.length).toBeLessThan(900);
  });
});
