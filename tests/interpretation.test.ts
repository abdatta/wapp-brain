import Database from "better-sqlite3";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRecord, MessageRecord } from "../src/shared/types";
import { MemoryArchiveRepository } from "../src/server/db/memoryRepository";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { messageKey } from "../src/server/identity/keys";
import { mergeInteractionMetadata } from "../src/server/db/interactions";
import { runRetainedPayloadDecryptionPass } from "../src/server/live/secretsPass";
import { runImport } from "../src/server/import/importer";
import { isMediaMessageType, messageTypeFromCode } from "../src/server/import/messageTypes";
import { parseWorksheetAnnotations, renderUnknownTypeReport } from "../src/server/import/unknownTypeReport";
import { parseWhatsAppSource } from "../src/server/import/parser";
import { normalizeBaileysMessagesWithJidResolver } from "../src/server/live/normalize";

const GROUP = "12036000000000@g.us";

describe("message interpretation", () => {
  it("maps user-confirmed backup codes to the shared vocabulary and never guesses the rest", () => {
    expect(messageTypeFromCode(66)).toBe("poll");
    expect(messageTypeFromCode(92)).toBe("event");
    expect(messageTypeFromCode(99)).toBe("album");
    expect(messageTypeFromCode(42)).toBe("view_once_image");
    expect(messageTypeFromCode(43)).toBe("view_once_video");
    expect(messageTypeFromCode(27)).toBe("template");
    expect(messageTypeFromCode(62)).toBe("template");
    expect(messageTypeFromCode(45)).toBe("list");
    expect(messageTypeFromCode(46)).toBe("list");
    expect(messageTypeFromCode(24)).toBe("group_invite");
    expect(messageTypeFromCode(51)).toBe("payment_invite");
    expect(messageTypeFromCode(64)).toBe("admin_revoked");
    expect(messageTypeFromCode(11)).toBe("waiting_for_message");
    expect(messageTypeFromCode(103)).toBe("status_mention");
    expect(messageTypeFromCode(118)).toBe("history_share");
    expect(messageTypeFromCode(36)).toBe("system");
    expect(messageTypeFromCode(14)).toBe("contact");
    // Corrections from the real-archive audit: historical folklore mappings
    // contradicted by structural evidence (media mimes and sidecar joins).
    expect(messageTypeFromCode(20)).toBe("sticker"); // was "product"; every row carries webp sticker media
    expect(messageTypeFromCode(15)).toBe("revoked"); // was "sticker"; every row joins message_revoked
    expect(messageTypeFromCode(90)).toBe("call"); // was "status"; every row joins message_call_log
    expect(messageTypeFromCode(10)).toBe("missed_call"); // was "call"; every row joins missed_call_logs
    expect(messageTypeFromCode(82)).toBe("view_once_audio"); // opus voice media joined to message_view_once_media
    expect(messageTypeFromCode(88)).toBe("bot_feedback"); // 1:1 join with message_bot_feedback
    expect(messageTypeFromCode(8)).toBe("call"); // legacy audio/video call per forensic documentation
    // The last unidentified code stays honest.
    expect(messageTypeFromCode(116)).toBe("unknown_116");
    // Media flag follows the type, not "anything that is not text".
    expect(isMediaMessageType("poll")).toBe(false);
    expect(isMediaMessageType("view_once_video")).toBe(true);
    expect(isMediaMessageType("album")).toBe(true);
  });

  it("types live payloads with the same vocabulary and archives their primary text", async () => {
    const event = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: GROUP, id: "POLL1", fromMe: false },
          participant: "15550000001@s.whatsapp.net",
          messageTimestamp: 1712000001,
          message: {
            pollCreationMessageV3: { name: "Lunch spot?", options: [{ optionName: "Ramen" }, { optionName: "Tacos" }] }
          }
        },
        {
          key: { remoteJid: GROUP, id: "EVENT1", fromMe: false },
          participant: "15550000001@s.whatsapp.net",
          messageTimestamp: 1712000002,
          message: { eventMessage: { name: "Game night", startTime: 1712100000 } }
        },
        {
          key: { remoteJid: GROUP, id: "INVITE1", fromMe: false },
          participant: "15550000001@s.whatsapp.net",
          messageTimestamp: 1712000003,
          message: { groupInviteMessage: { groupJid: "12036000000099@g.us", groupName: "Weekend Hikers" } }
        },
        {
          key: { remoteJid: GROUP, id: "LIST1", fromMe: false },
          participant: "15550000001@s.whatsapp.net",
          messageTimestamp: 1712000004,
          message: { listMessage: { title: "Pick a slot", description: "Choose one" } }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );

    const byId = new Map(event.messages?.map((message) => [message.sourceMessageId, message]));
    expect(byId.get("POLL1")?.messageType).toBe("poll");
    expect(byId.get("POLL1")?.body).toBe("Lunch spot?");
    expect(byId.get("EVENT1")?.messageType).toBe("event");
    expect(byId.get("EVENT1")?.body).toBe("Game night");
    expect(byId.get("INVITE1")?.messageType).toBe("group_invite");
    expect(byId.get("INVITE1")?.body).toBe("Weekend Hikers");
    expect(byId.get("LIST1")?.messageType).toBe("list");
    expect(byId.get("LIST1")?.body).toBe("Pick a slot");
  });

  it("upgrades previously-unknown rows in place on re-import, healing heuristic deletion", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("import", [makeChat(GROUP)]);
    // Old-archive state: unknown type, textless, mis-flagged deleted by the
    // retired inference heuristic.
    await repository.upsertMessages([
      { ...makeMessage(GROUP, "m1", 1000), messageType: "unknown_66", rawTypeCode: "66", body: null, isDeleted: true }
    ]);
    const before = await listAll(repository);
    expect(before[0]?.isDeleted).toBe(true);

    // Re-import after the mapping landed: real type, extracted question.
    await repository.upsertMessages([
      { ...makeMessage(GROUP, "m1", 1000), messageType: "poll", rawTypeCode: "66", body: "Lunch spot?", isDeleted: false }
    ]);
    const after = await listAll(repository);

    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.messageType).toBe("poll");
    expect(after[0]?.body).toBe("Lunch spot?");
    expect(after[0]?.isDeleted).toBe(false);

    // A weak re-classification never downgrades the known type, and a real
    // tombstone stays deleted.
    await repository.upsertMessages([
      { ...makeMessage(GROUP, "m1", 1000), messageType: "unknown_66", rawTypeCode: "66", body: null, isDeleted: false }
    ]);
    const downgraded = await listAll(repository);
    expect(downgraded[0]?.messageType).toBe("poll");
    expect(downgraded[0]?.body).toBe("Lunch spot?");
  });

  it("extracts sidecar content for mapped types with the typed placeholder as the floor", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-sidecar-"));
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      const db = new Database(msgstorePath);
      db.exec(`
        CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT, user TEXT, server TEXT);
        CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER NOT NULL, subject TEXT, sort_timestamp INTEGER);
        CREATE TABLE message (
          _id INTEGER PRIMARY KEY, chat_row_id INTEGER NOT NULL, sender_jid_row_id INTEGER,
          from_me INTEGER NOT NULL, key_id TEXT NOT NULL, timestamp INTEGER, message_type INTEGER,
          text_data TEXT, status INTEGER, starred INTEGER, forwarded INTEGER
        );
        CREATE TABLE message_poll (message_row_id INTEGER PRIMARY KEY, selectable_options_count INTEGER);
        CREATE TABLE message_poll_option (_id INTEGER PRIMARY KEY, message_row_id INTEGER, option_name TEXT, vote_total INTEGER);
        CREATE TABLE message_template (message_row_id INTEGER PRIMARY KEY, content_text_data TEXT, footer_text_data TEXT);
        CREATE TABLE message_template_button (_id INTEGER PRIMARY KEY, message_row_id INTEGER, text_data TEXT);
        CREATE TABLE message_ui_elements (_id INTEGER PRIMARY KEY, message_row_id INTEGER, description TEXT, footer_text TEXT, button_text TEXT, element_content TEXT);
        CREATE TABLE message_group_invite (message_row_id INTEGER PRIMARY KEY, group_name TEXT, expiration INTEGER, expired INTEGER);
        CREATE TABLE message_event (message_row_id INTEGER PRIMARY KEY, name TEXT, description TEXT, location_name TEXT, start_time INTEGER, end_time INTEGER, join_link TEXT, is_canceled INTEGER);
        CREATE TABLE message_revoked (message_row_id INTEGER PRIMARY KEY, revoked_key_id TEXT, admin_jid_row_id INTEGER, revoke_timestamp INTEGER);

        INSERT INTO jid VALUES (1, '12036000000000@g.us', '12036000000000', 'g.us');
        INSERT INTO jid VALUES (2, '15550000001@s.whatsapp.net', '15550000001', 's.whatsapp.net');
        INSERT INTO jid VALUES (3, '15550000003@s.whatsapp.net', '15550000003', 's.whatsapp.net');
        INSERT INTO chat VALUES (20, 1, 'Fixture Group', 1712000000000);

        INSERT INTO message VALUES (100, 20, 2, 0, 'POLL1', 1712000001000, 66, 'Lunch spot?', 0, 0, 0);
        INSERT INTO message_poll VALUES (100, 1);
        INSERT INTO message_poll_option VALUES (1, 100, 'Ramen', 2);
        INSERT INTO message_poll_option VALUES (2, 100, 'Tacos', 1);

        INSERT INTO message VALUES (101, 20, 2, 0, 'TPL1', 1712000002000, 27, NULL, 0, 0, 0);
        INSERT INTO message_template VALUES (101, 'Your order has shipped', 'Reply STOP to opt out');
        INSERT INTO message_template_button VALUES (1, 101, 'Track order');
        INSERT INTO message_template_button VALUES (2, 101, 'Contact us');

        INSERT INTO message VALUES (102, 20, 2, 0, 'LIST1', 1712000003000, 45, NULL, 0, 0, 0);
        INSERT INTO message_ui_elements VALUES (1, 102, 'Pick a delivery slot', NULL, 'Choose', NULL);

        INSERT INTO message VALUES (103, 20, 2, 0, 'INV1', 1712000004000, 24, NULL, 0, 0, 0);
        INSERT INTO message_group_invite VALUES (103, 'Weekend Hikers', 1799000000000, 0);

        INSERT INTO message VALUES (104, 20, 2, 0, 'EVT1', 1712000005000, 92, NULL, 0, 0, 0);
        INSERT INTO message_event VALUES (104, 'Game night', 'Bring snacks', 'Kelton', 1712100000000, NULL, NULL, 0);

        INSERT INTO message VALUES (105, 20, 2, 0, 'DEL1', 1712000006000, 64, NULL, 0, 0, 0);
        INSERT INTO message_revoked VALUES (105, 'DEL1', 3, 1712090000000);

        INSERT INTO message VALUES (106, 20, 2, 0, 'ALB1', 1712000007000, 99, NULL, 0, 0, 0);
      `);

      const parsed = parseWhatsAppSource(db, null, "fixture");
      const records = new Map([...parsed.iterateMessages()].map((record) => [record.sourceMessageId, record]));
      db.close();

      const poll = records.get("POLL1");
      expect(poll?.messageType).toBe("poll");
      expect(poll?.body).toBe("Lunch spot?");
      expect(poll?.rawMetadata?.poll).toEqual({
        options: [
          { name: "Ramen", votes: 2 },
          { name: "Tacos", votes: 1 }
        ],
        selectableOptionsCount: 1
      });

      const template = records.get("TPL1");
      expect(template?.messageType).toBe("template");
      expect(template?.body).toBe("Your order has shipped");
      expect(template?.rawMetadata?.template).toEqual({ footerText: "Reply STOP to opt out", buttons: ["Track order", "Contact us"] });

      const list = records.get("LIST1");
      expect(list?.messageType).toBe("list");
      expect(list?.body).toBe("Pick a delivery slot");
      expect((list?.rawMetadata?.template as { buttons?: string[] })?.buttons).toEqual(["Choose"]);

      const invite = records.get("INV1");
      expect(invite?.messageType).toBe("group_invite");
      expect(invite?.body).toBe("Weekend Hikers");

      const event = records.get("EVT1");
      expect(event?.messageType).toBe("event");
      expect(event?.body).toBe("Game night");
      expect(event?.caption).toBe("Bring snacks");
      expect((event?.rawMetadata?.event as { startTimeMs?: number })?.startTimeMs).toBe(1712100000000);

      const revoked = records.get("DEL1");
      expect(revoked?.messageType).toBe("admin_revoked");
      expect(revoked?.isDeleted).toBe(true);
      // Row keeps its post time; the revocation actor/time ride in metadata.
      expect(revoked?.timestampMs).toBe(1712000006000);
      expect(revoked?.rawMetadata?.revoked).toEqual({ revokedByJid: "15550000003@s.whatsapp.net", revokedAtMs: 1712090000000 });

      const album = records.get("ALB1");
      expect(album?.messageType).toBe("album");
      expect(album?.body).toBeNull();
      expect(album?.hasMedia).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("converges backup add-ons and edited-message identity through the live update path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-addons-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      const msgstorePath = path.join(tempDir, "msgstore.db");
      const fixture = new Database(msgstorePath);
      fixture.exec(`
        CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT, user TEXT, server TEXT);
        CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER NOT NULL, subject TEXT, sort_timestamp INTEGER);
        CREATE TABLE message (
          _id INTEGER PRIMARY KEY, chat_row_id INTEGER NOT NULL, sender_jid_row_id INTEGER,
          from_me INTEGER NOT NULL, key_id TEXT NOT NULL, timestamp INTEGER, message_type INTEGER,
          text_data TEXT, status INTEGER, starred INTEGER, forwarded INTEGER
        );
        CREATE TABLE message_poll (message_row_id INTEGER PRIMARY KEY, selectable_options_count INTEGER);
        CREATE TABLE message_poll_option (_id INTEGER PRIMARY KEY, message_row_id INTEGER, option_name TEXT, vote_total INTEGER);
        CREATE TABLE message_edit_info (message_row_id INTEGER PRIMARY KEY, original_key_id TEXT, edited_timestamp INTEGER, sender_timestamp INTEGER);
        CREATE TABLE message_add_on (
          _id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER, key_id TEXT, sender_jid_row_id INTEGER,
          parent_message_row_id INTEGER, timestamp INTEGER, message_add_on_type INTEGER
        );
        CREATE TABLE message_add_on_reaction (message_add_on_row_id INTEGER PRIMARY KEY, reaction TEXT, sender_timestamp INTEGER);
        CREATE TABLE message_add_on_poll_vote (message_add_on_row_id INTEGER PRIMARY KEY, sender_timestamp INTEGER);
        CREATE TABLE message_add_on_poll_vote_selected_option (_id INTEGER PRIMARY KEY, message_add_on_row_id INTEGER, message_poll_option_id INTEGER);
        CREATE TABLE message_secret (message_row_id INTEGER PRIMARY KEY, message_secret BLOB);

        INSERT INTO jid VALUES (1, '12036000000000@g.us', '12036000000000', 'g.us');
        INSERT INTO jid VALUES (2, '15550000001@s.whatsapp.net', '15550000001', 's.whatsapp.net');
        INSERT INTO jid VALUES (3, '15550000003@s.whatsapp.net', '15550000003', 's.whatsapp.net');
        INSERT INTO chat VALUES (20, 1, 'Fixture Group', 1712000000000);

        INSERT INTO message VALUES (100, 20, 2, 0, 'POLL1', 1712000001000, 66, 'Lunch spot?', 0, 0, 0);
        INSERT INTO message_poll VALUES (100, 1);
        INSERT INTO message_poll_option VALUES (1, 100, 'Ramen', 1);
        INSERT INTO message_poll_option VALUES (2, 100, 'Tacos', 0);

        -- Edited message: current key is the edit's key; the original key is
        -- the identity live sync archived it under.
        INSERT INTO message VALUES (110, 20, 3, 0, 'EDIT2', 1712000002000, 0, 'final corrected text', 0, 0, 0);
        INSERT INTO message_edit_info VALUES (110, 'ORIG1', 1712000005000, NULL);

        INSERT INTO message_add_on VALUES (1, 20, 0, 'R1', 3, 100, 1712000003000, 56);
        INSERT INTO message_add_on_reaction VALUES (1, '👍', 1712000003000);
        INSERT INTO message_add_on VALUES (2, 20, 0, 'V1', 3, 100, 1712000004000, 67);
        INSERT INTO message_add_on_poll_vote VALUES (2, 1712000004000);
        INSERT INTO message_add_on_poll_vote_selected_option VALUES (1, 2, 1);
        -- Reaction on the edited message resolves to its original identity.
        INSERT INTO message_add_on VALUES (3, 20, 1, 'R2', NULL, 110, 1712000006000, 56);
        INSERT INTO message_add_on_reaction VALUES (3, '❤️', 1712000006000);

        INSERT INTO message_secret VALUES (100, X'0102030405060708010203040506070801020304050607080102030405060708');
        INSERT INTO message_secret VALUES (110, X'1112131415161718111213141516171811121314151617181112131415161718');
      `);
      fixture.close();

      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      // Simulate an archive written by the previous importer: the edited
      // message sits under its edit key.
      const seedRun = await repository.startImportRun({ fixture: "pre-rekey" });
      await repository.upsertChats(seedRun, [makeChat(GROUP)]);
      await repository.upsertMessages([{ ...makeMessage(GROUP, "EDIT2", 1712000002000), body: "final corrected text" }]);

      await runImport(repository, { msgstorePath });
      // Second import of the same backup must be idempotent for add-ons too.
      await runImport(repository, { msgstorePath });
      await repository.close();
      repository = null;

      const archive = new Database(path.join(tempDir, "archive.sqlite"), { readonly: true });
      try {
        const edited = archive
          .prepare(`SELECT source_message_id, body, raw_metadata_json FROM messages WHERE source_message_id IN ('ORIG1','EDIT2')`)
          .all() as Array<{ source_message_id: string; body: string; raw_metadata_json: string }>;
        // Archived under the original key only — the identity live sync uses.
        expect(edited.map((row) => row.source_message_id)).toEqual(["ORIG1"]);
        expect(edited[0]?.body).toBe("final corrected text");
        expect(JSON.parse(edited[0]?.raw_metadata_json ?? "{}").edited).toBe(1);

        const reactionRows = archive
          .prepare(`SELECT event_key, update_type, applied, metadata_json FROM live_message_updates WHERE update_type = 'reaction' ORDER BY event_key`)
          .all() as Array<{ event_key: string; update_type: string; applied: number; metadata_json: string }>;
        expect(reactionRows).toHaveLength(2);
        expect(reactionRows.every((row) => row.applied === 1)).toBe(true);
        // Same metadata shape the live normalizer emits.
        expect(JSON.parse(reactionRows[0]!.metadata_json)).toMatchObject({ emoji: expect.any(String), reactorJid: expect.any(String) });
        // The edited message's reaction targets the original identity.
        expect(reactionRows.some((row) => row.event_key.includes("|ORIG1|") || row.event_key.includes("ORIG1"))).toBe(true);

        const poll = archive
          .prepare(`SELECT raw_metadata_json FROM messages WHERE source_message_id = 'POLL1'`)
          .get() as { raw_metadata_json: string };
        const pollMetadata = JSON.parse(poll.raw_metadata_json);
        expect(pollMetadata.poll.options).toEqual([
          { name: "Ramen", votes: 1 },
          { name: "Tacos", votes: 0 }
        ]);
        // One vote per voter even after double import.
        expect(pollMetadata.poll.votes).toEqual([
          { voterJid: "15550000003@s.whatsapp.net", options: ["Ramen"], atMs: 1712000004000 }
        ]);

        // Backup secrets backfilled, keyed by identity (edited row → original
        // key), idempotent across the double import.
        const secretRows = archive
          .prepare(`SELECT source_message_id FROM message_secrets ORDER BY source_message_id`)
          .all() as Array<{ source_message_id: string }>;
        expect(secretRows.map((row) => row.source_message_id)).toEqual(["ORIG1", "POLL1"]);
      } finally {
        archive.close();
      }
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("captures live secrets, retains encrypted votes, and decrypts them retroactively", async () => {
    const creator = "15550000001@s.whatsapp.net";
    const voter = "15550000003@s.whatsapp.net";
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("live", [makeChat(GROUP)]);

    const secret = randomBytes(32);
    const pollEvent = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: GROUP, id: "POLL9", fromMe: false },
          participant: creator,
          messageTimestamp: 1712000001,
          message: {
            messageContextInfo: { messageSecret: new Uint8Array(secret) },
            pollCreationMessageV3: { name: "Lunch?", options: [{ optionName: "Ramen" }, { optionName: "Tacos" }] }
          }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );
    // The envelope's message secret is captured alongside the poll row.
    expect(pollEvent.secrets).toHaveLength(1);
    await repository.upsertMessages(pollEvent.messages ?? []);

    const vote = encryptPollVoteFixture(secret, "POLL9", creator, voter, ["Ramen"]);
    const voteEvent = await normalizeBaileysMessagesWithJidResolver(
      [
        {
          key: { remoteJid: GROUP, id: "VOTE1", fromMe: false },
          participant: voter,
          messageTimestamp: 1712000002,
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: { id: "POLL9" },
              vote: { encPayload: vote.encPayload, encIv: vote.encIv },
              senderTimestampMs: 1712000002000
            }
          }
        }
      ],
      "wa-web:messages.upsert",
      (jid) => jid
    );
    // Votes are state updates, never message rows.
    expect(voteEvent.messages ?? []).toHaveLength(0);
    expect(voteEvent.retainedPayloads).toHaveLength(1);
    await repository.retainEncryptedPayloads(voteEvent.retainedPayloads ?? []);

    // Without the secret the payload stays honestly retained.
    const before = await runRetainedPayloadDecryptionPass(repository, {});
    expect(before.decrypted).toBe(0);
    expect(await repository.listRetainedEncryptedPayloads()).toHaveLength(1);

    // Secret arrives (live capture here; a backup backfill behaves the same).
    await repository.recordMessageSecrets(pollEvent.secrets ?? []);
    const after = await runRetainedPayloadDecryptionPass(repository, {});
    expect(after.decrypted).toBe(1);
    expect(await repository.listRetainedEncryptedPayloads()).toHaveLength(0);

    const context = await repository.getMessageInterpretationContext(GROUP, "POLL9");
    expect((context?.rawMetadata?.poll as { votes?: unknown }).votes).toEqual([
      { voterJid: voter, options: ["Ramen"], atMs: 1712000002000 }
    ]);
  });

  it("keeps secret material out of status and message DTOs", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("live", [makeChat(GROUP)]);
    await repository.upsertMessages([makeMessage(GROUP, "m1", 1000)]);
    await repository.recordMessageSecrets([
      { chatSourceId: GROUP, sourceMessageId: "m1", secret: Buffer.from("FAKE_SECRET_MARKER_BYTES"), source: "live" }
    ]);

    const status = JSON.stringify(await repository.getStatus());
    const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
    const messages = JSON.stringify(await repository.listMessages(chats[0].id, { limit: 10, offset: 0 }));

    expect(status).not.toContain("FAKE_SECRET_MARKER_BYTES");
    expect(status).not.toContain('"secret"');
    expect(messages).not.toContain("FAKE_SECRET_MARKER_BYTES");
    expect(messages).not.toContain('"secret"');
  });

  it("exposes typed interpretation through message DTOs and memory evidence", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("import", [makeChat(GROUP)]);
    await repository.upsertMessages([
      { ...makeMessage(GROUP, "m1", 1000), messageType: "poll", body: "Lunch spot?" },
      { ...makeMessage(GROUP, "m2", 2000), messageType: "view_once_image", body: null, hasMedia: true },
      { ...makeMessage(GROUP, "m3", 3000), messageType: "unknown_82", rawTypeCode: "82", body: null },
      { ...makeMessage(GROUP, "m4", 4000), messageType: "admin_revoked", body: null, isDeleted: true },
      { ...makeMessage(GROUP, "m5", 5000), messageType: "text", body: "plain" },
      { ...makeMessage(GROUP, "m6", 6000), messageType: "waiting_for_message", body: null },
      { ...makeMessage(GROUP, "m7", 7000), messageType: "encrypted_update", body: null }
    ]);

    const messages = await listAll(repository);
    const byId = new Map(messages.map((message) => [message.sourceMessageId, message]));

    expect(byId.get("m1")?.interpretation?.label).toBe("Poll");
    // Media availability is honest per message: an imported view-once with no
    // matched file reports import_missing, never a blanket "not kept" claim.
    expect(byId.get("m2")?.interpretation).toEqual({
      label: "View once photo",
      reason: "The media file was not found in the imported media folder."
    });
    expect(byId.get("m2")?.media?.availability).toBe("import_missing");
    expect(byId.get("m3")?.interpretation?.label).toBe("Legacy message");
    expect(byId.get("m3")?.interpretation?.reason).toContain("(82)");
    expect(byId.get("m4")?.interpretation?.label).toBe("Deleted by a group admin");
    // Plain text needs no interpretation.
    expect(byId.get("m5")?.interpretation).toBeNull();
    // Undelivered ciphertext and encrypted updates state why they are
    // unreadable — the archive is never blamed for platform realities.
    expect(byId.get("m6")?.interpretation?.label).toBe("Waiting for this message");
    expect(byId.get("m6")?.interpretation?.reason).toContain("never received");
    expect(byId.get("m7")?.interpretation?.label).toBe("Encrypted edit of an earlier message");
    expect(byId.get("m7")?.interpretation?.reason).toContain("key the archive does not hold");

    // A non-UI consumer sees the same meaning: evidence entries are
    // self-describing even for non-text messages.
    const evidence = await repository.listMemoryEvidenceMessages({ limit: 10 });
    const evidenceById = new Map(evidence.map((entry) => [entry.sourceMessageId, entry]));
    expect(evidenceById.get("m1")?.interpretation?.label).toBe("Poll");
    expect(evidenceById.get("m1")?.text).toBe("Lunch spot?");
    expect(evidenceById.get("m2")?.interpretation?.label).toBe("View once photo");
  });

  it("regenerates the unknown-type worksheet preserving annotations while resolved codes drop off", async () => {
    const repository = new MemoryArchiveRepository();
    await repository.upsertChats("import", [{ ...makeChat(GROUP), displayName: "Fixture Group" }]);
    await repository.upsertMessages([
      { ...makeMessage(GROUP, "u1", 1000), messageType: "unknown_82", rawTypeCode: "82", body: null },
      { ...makeMessage(GROUP, "u2", 2000), messageType: "unknown_82", rawTypeCode: "82", body: null },
      { ...makeMessage(GROUP, "u3", 3000), messageType: "unknown_116", rawTypeCode: "116", body: null }
    ]);

    const entries = await repository.listUnknownTypeCodes();
    expect(entries.map((entry) => [entry.code, entry.count])).toEqual([
      ["82", 2],
      ["116", 1]
    ]);
    expect(entries[0]?.examples[0]).toEqual({ chatLabel: "Fixture Group", timestampMs: 2000 });

    // A previous worksheet had notes for code 82 and for code 66 — 66 has
    // since gained a mapping, so it is no longer unknown and drops off, while
    // 82's note survives regeneration.
    const previous = renderUnknownTypeReport(
      [
        { code: "82", count: 2, examples: [] },
        { code: "66", count: 74, examples: [] }
      ],
      new Map([
        ["82", "Some odd system thing"],
        ["66", "Poll"]
      ]),
      "2026-01-01T00:00:00.000Z"
    );
    const regenerated = renderUnknownTypeReport(entries, parseWorksheetAnnotations(previous), "2026-01-02T00:00:00.000Z");

    expect(regenerated).toContain("| 82 | 2 | Some odd system thing |");
    expect(regenerated).toContain("| 116 | 1 |  |");
    expect(regenerated).not.toContain("| 66 |");
    expect(regenerated).toContain("Private — do not commit");
  });

  it("never lets older backup interaction state clobber newer state", () => {
    const newer = { poll: { votes: [{ voterJid: "a@s.whatsapp.net", options: ["X"], atMs: 2000 }] } };
    const stale = mergeInteractionMetadata(newer, {
      updateType: "poll_vote",
      occurredAtMs: 1000,
      metadata: { voterJid: "a@s.whatsapp.net", options: ["Y"] }
    });
    expect(stale).toBeNull();

    const fresher = mergeInteractionMetadata(newer, {
      updateType: "poll_vote",
      occurredAtMs: 3000,
      metadata: { voterJid: "a@s.whatsapp.net", options: ["Y"] }
    });
    expect((fresher?.poll as { votes: Array<{ options: string[] }> }).votes).toEqual([
      { voterJid: "a@s.whatsapp.net", options: ["Y"], atMs: 3000 }
    ]);
  });

  it("performs the same in-place upgrade in the SQLite adapter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-brain-interpret-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      const runId = await repository.startImportRun({ fixture: "interpretation" });
      await repository.upsertChats(runId, [makeChat(GROUP)]);
      await repository.upsertMessages([
        { ...makeMessage(GROUP, "m1", 1000), messageType: "unknown_66", rawTypeCode: "66", body: null, isDeleted: true },
        { ...makeMessage(GROUP, "m2", 2000), messageType: "unknown_82", rawTypeCode: "82", body: null, isDeleted: false }
      ]);
      await repository.upsertMessages([
        { ...makeMessage(GROUP, "m1", 1000), messageType: "poll", rawTypeCode: "66", body: "Lunch spot?", isDeleted: false }
      ]);

      const messages = await listAll(repository);
      const poll = messages.find((message) => message.sourceMessageId === "m1");
      const unknown = messages.find((message) => message.sourceMessageId === "m2");

      expect(messages).toHaveLength(2);
      expect(poll?.messageType).toBe("poll");
      expect(poll?.body).toBe("Lunch spot?");
      expect(poll?.isDeleted).toBe(false);
      // Unconfirmed codes keep the honest unknown type.
      expect(unknown?.messageType).toBe("unknown_82");
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function listAll(repository: MemoryArchiveRepository | SqliteArchiveRepository) {
  const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
  return repository.listMessages(chats[0].id, { limit: 50, offset: 0 });
}

// Inverse of Baileys' decryptPollVote scheme (HKDF-style double HMAC + AES-256-GCM
// with the vote proto as plaintext), so the test round-trips the real decryptor.
function encryptPollVoteFixture(
  secret: Buffer,
  pollMsgId: string,
  pollCreatorJid: string,
  voterJid: string,
  optionNames: string[]
): { encPayload: Uint8Array; encIv: Uint8Array } {
  // protobuf: repeated bytes selectedOptions = 1 → (0x0a, len, bytes)*
  const hashes = optionNames.map((name) => createHash("sha256").update(name).digest());
  const plaintext = Buffer.concat(hashes.flatMap((hash) => [Buffer.from([0x0a, hash.length]), hash]));
  const key0 = createHmac("sha256", Buffer.alloc(32)).update(secret).digest();
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from("Poll Vote"),
    Buffer.from([1])
  ]);
  const encKey = createHmac("sha256", key0).update(sign).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  cipher.setAAD(Buffer.from(`${pollMsgId}\u0000${voterJid}`)); // NUL-separated, matching Baileys' AAD
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { encPayload: encrypted, encIv: iv };
}

function makeChat(chatSourceId: string): ChatRecord {
  return {
    sourceChatId: chatSourceId,
    jid: chatSourceId,
    displayName: null,
    chatType: chatSourceId.endsWith("@g.us") ? "group" : "dm"
  };
}

function makeMessage(chatSourceId: string, id: string, timestampMs: number): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(chatSourceId, id),
    sourceTable: "message",
    sourceRowId: id,
    chatSourceId,
    senderSourceJid: "15550000001@s.whatsapp.net",
    timestampMs,
    sentAtIso: new Date(timestampMs).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    rawTypeCode: "0",
    body: `Synthetic ${id}`,
    hasMedia: false,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}
