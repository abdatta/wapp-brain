import Database from "better-sqlite3";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export interface SyntheticFixtureOptions {
  large?: boolean;
  manyChats?: number;
  missingOptional?: boolean;
  privacyCanary?: boolean;
}

export interface SyntheticFixturePaths {
  directory: string;
  msgstorePath: string;
  waPath: string;
}

export async function createSyntheticFixture(
  directory: string,
  options: SyntheticFixtureOptions = {}
): Promise<SyntheticFixturePaths> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const msgstorePath = path.join(directory, "msgstore.db");
  const waPath = path.join(directory, "wa.db");
  createWaDb(waPath);
  createMsgstoreDb(msgstorePath, options);
  return { directory, msgstorePath, waPath };
}

export async function createModernSyntheticFixture(directory: string): Promise<SyntheticFixturePaths> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const msgstorePath = path.join(directory, "msgstore.db");
  const waPath = path.join(directory, "wa.db");
  createWaDb(waPath);
  createModernMsgstoreDb(msgstorePath);
  return { directory, msgstorePath, waPath };
}

// A deliberately compact modern schema carrying every archive-signal family.
// Values are synthetic and innocuous so tests can assert privacy boundaries
// without ever requiring an actual WhatsApp backup.
export async function createSignalCaptureFixture(directory: string): Promise<SyntheticFixturePaths> {
  const fixture = await createModernSyntheticFixture(directory);
  const db = new Database(fixture.msgstorePath);
  try {
    db.exec(`
      ALTER TABLE message_text ADD COLUMN page_title TEXT;
      ALTER TABLE message_text ADD COLUMN description TEXT;
      ALTER TABLE message_text ADD COLUMN url TEXT;
      CREATE TABLE message_mentions (_id INTEGER PRIMARY KEY, message_row_id INTEGER, jid_row_id INTEGER, display_name TEXT, mention_type INTEGER);
      CREATE TABLE message_location (message_row_id INTEGER PRIMARY KEY, latitude REAL, longitude REAL, place_name TEXT, place_address TEXT, live_location_share_duration INTEGER, live_location_sequence_number INTEGER);
      CREATE TABLE message_vcard (_id INTEGER PRIMARY KEY, message_row_id INTEGER, vcard TEXT);
      CREATE TABLE message_vcard_jid (_id INTEGER PRIMARY KEY, vcard_row_id INTEGER, vcard_jid_row_id INTEGER, message_row_id INTEGER);
      CREATE TABLE message_thumbnail (message_row_id INTEGER PRIMARY KEY, thumbnail BLOB);
      CREATE TABLE message_system_number_change (message_row_id INTEGER PRIMARY KEY, old_jid_row_id INTEGER, new_jid_row_id INTEGER);
      CREATE TABLE message_edit_info (message_row_id INTEGER PRIMARY KEY, original_key_id TEXT, edited_timestamp INTEGER, sender_timestamp INTEGER);
      CREATE TABLE message_revoked (message_row_id INTEGER PRIMARY KEY, admin_jid_row_id INTEGER, revoke_timestamp INTEGER);
      CREATE TABLE message_media (message_row_id INTEGER PRIMARY KEY, accessibility_label TEXT, raw_transcription_text TEXT);
      CREATE TABLE transcription_segment (_id INTEGER PRIMARY KEY, message_row_id INTEGER, substring_start INTEGER, substring_length INTEGER, timestamp INTEGER, duration INTEGER);
      CREATE TABLE receipt_user (_id INTEGER PRIMARY KEY, message_row_id INTEGER, receipt_user_jid_row_id INTEGER, receipt_timestamp INTEGER, read_timestamp INTEGER);
      CREATE TABLE receipt_device (_id INTEGER PRIMARY KEY, message_row_id INTEGER, receipt_device_jid_row_id INTEGER, receipt_device_timestamp INTEGER);
      CREATE TABLE group_participant_user (_id INTEGER PRIMARY KEY, group_jid_row_id INTEGER, user_jid_row_id INTEGER, rank INTEGER, add_timestamp INTEGER);
      CREATE TABLE group_past_participant_user (_id INTEGER PRIMARY KEY, group_jid_row_id INTEGER, user_jid_row_id INTEGER, is_leave INTEGER, timestamp INTEGER);
      CREATE TABLE group_participants_history (_id INTEGER PRIMARY KEY, timestamp INTEGER, gjid TEXT, jid TEXT, action TEXT);
      CREATE TABLE message_system_group (message_row_id INTEGER PRIMARY KEY, is_me_joined INTEGER);
      CREATE TABLE message_system (message_row_id INTEGER PRIMARY KEY, action_type TEXT);
      CREATE TABLE message_system_chat_participant (message_row_id INTEGER PRIMARY KEY, user_jid_row_id INTEGER);
      CREATE TABLE message_system_with_group_nodes (message_row_id INTEGER PRIMARY KEY, group_subject TEXT);
      CREATE TABLE message_system_photo_change (message_row_id INTEGER PRIMARY KEY, new_photo_id TEXT, old_photo BLOB, new_photo BLOB);
    `);
    db.prepare("INSERT INTO jid (_id, raw_string, user, server) VALUES (?, ?, ?, ?)").run(5, "15550000004@s.whatsapp.net", "15550000004", "s.whatsapp.net");
    db.prepare("INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, quoted_message_row_id, status, starred, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(105, 10, 1, 0, "modern-direct-3", 1711000003000, 0, null, 0, 0, 0);
    db.prepare("INSERT INTO message_text (message_row_id, text_data, page_title, description, url) VALUES (?, ?, ?, ?, ?)")
      .run(105, "Synthetic response", null, null, null);
    db.prepare("INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, quoted_message_row_id, status, starred, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(106, 20, 3, 0, "signal-edit-copy", 1711000006000, 0, null, 0, 0, 0);
    db.prepare("INSERT INTO message_text (message_row_id, text_data, page_title, description, url) VALUES (?, ?, ?, ?, ?)")
      .run(106, "Edited synthetic message", null, null, null);
    db.prepare("UPDATE message_text SET page_title = ?, description = ?, url = ? WHERE message_row_id = ?")
      .run("Synthetic preview", "A local preview", "https://example.test/signal", 102);
    db.prepare("INSERT INTO message_thumbnail (message_row_id, thumbnail) VALUES (?, ?)").run(102, Buffer.from([7, 8, 9]));
    db.prepare("INSERT INTO message_mentions (message_row_id, jid_row_id) VALUES (?, ?), (?, ?)").run(102, 3, 102, 4);
    db.prepare("INSERT INTO message_location (message_row_id, latitude, longitude, place_name, place_address, live_location_share_duration, live_location_sequence_number) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(102, 37.77, -122.42, "Synthetic Park", "42 Example Way", 300, 1);
    db.prepare("INSERT INTO message_location (message_row_id, latitude, longitude, place_name, place_address, live_location_share_duration, live_location_sequence_number) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(100, 40.71, -74.0, "Synthetic Static Place", null, null, null);
    db.prepare("INSERT INTO message_vcard (_id, message_row_id, vcard) VALUES (?, ?, ?), (?, ?, ?)")
      .run(501, 102, "BEGIN:VCARD\nFN:Synthetic Friend\nEND:VCARD", 502, 102, "BEGIN:VCARD\nFN:Second Friend\nEND:VCARD");
    db.prepare("INSERT INTO message_vcard_jid (vcard_row_id, vcard_jid_row_id, message_row_id) VALUES (?, ?, ?)").run(501, 3, 102);
    db.prepare("INSERT INTO message_system_number_change (message_row_id, old_jid_row_id, new_jid_row_id) VALUES (?, ?, ?)").run(102, 3, 5);
    db.prepare("INSERT INTO message_edit_info (message_row_id, original_key_id, edited_timestamp) VALUES (?, ?, ?)").run(106, "signal-original", 1711000006500);
    db.prepare("INSERT INTO message_revoked (message_row_id, admin_jid_row_id, revoke_timestamp) VALUES (?, ?, ?)").run(104, 3, 1711000005500);
    db.prepare("INSERT INTO message_media (message_row_id, accessibility_label, raw_transcription_text) VALUES (?, ?, ?)").run(103, "Synthetic document label", "one two three");
    db.prepare("INSERT INTO transcription_segment (_id, message_row_id, substring_start, substring_length, timestamp, duration) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)")
      .run(1, 103, 0, 3, 0, 250, 2, 103, 4, 3, 250, 250);
    db.prepare("INSERT INTO receipt_user (message_row_id, receipt_user_jid_row_id, receipt_timestamp, read_timestamp) VALUES (?, ?, ?, ?)").run(101, 1, 1711000002500, 1711000002600);
    db.prepare("INSERT INTO receipt_device (message_row_id, receipt_device_jid_row_id, receipt_device_timestamp) VALUES (?, ?, ?)").run(104, 3, 1711000005100);
    db.prepare("INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id, rank, add_timestamp) VALUES (?, ?, ?, ?)").run(2, 3, 1, 1710000000000);
    db.prepare("INSERT INTO group_past_participant_user (_id, group_jid_row_id, user_jid_row_id, is_leave, timestamp) VALUES (?, ?, ?, ?, ?)").run(601, 2, 4, 1, 1710500000000);
    db.prepare("INSERT INTO group_participants_history (_id, timestamp, gjid, jid, action) VALUES (?, ?, ?, ?, ?)").run(701, 1710600000000, "120363000000000002@g.us", "15550000004@s.whatsapp.net", "add");
    db.prepare("INSERT INTO message_system_group (message_row_id, is_me_joined) VALUES (?, ?)").run(104, 1);
    db.prepare("INSERT INTO message_system (message_row_id, action_type) VALUES (?, ?)").run(102, "add");
    db.prepare("INSERT INTO message_system_chat_participant (message_row_id, user_jid_row_id) VALUES (?, ?)").run(102, 4);
    db.prepare("INSERT INTO message_system_with_group_nodes (message_row_id, group_subject) VALUES (?, ?)").run(102, "Signal Group Subject");
    db.prepare("INSERT INTO message_system_photo_change (message_row_id, new_photo_id, old_photo, new_photo) VALUES (?, ?, ?, ?)").run(104, "synthetic-photo", Buffer.from([1]), Buffer.from([2]));
  } finally {
    db.close();
  }
  return fixture;
}

function createWaDb(filePath: string): void {
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE wa_contacts (
        _id INTEGER PRIMARY KEY,
        jid TEXT,
        display_name TEXT,
        wa_name TEXT,
        number TEXT
      );
    `);
    const insert = db.prepare("INSERT INTO wa_contacts (jid, display_name, wa_name, number) VALUES (?, ?, ?, ?)");
    insert.run("15550000001@s.whatsapp.net", "Avery Example", "Avery", "15550000001");
    insert.run("15550000002@s.whatsapp.net", "Blake Example", "Blake", "15550000002");
    insert.run("15550000003@s.whatsapp.net", "Casey Example", "Casey", "15550000003");
    insert.run("120363000000000001@g.us", "Weekend Plans", null, null);
  } finally {
    db.close();
  }
}

function addManyChatContacts(filePath: string, count: number): void {
  const db = new Database(filePath);
  try {
    const insert = db.prepare("INSERT INTO wa_contacts (jid, display_name, wa_name, number) VALUES (?, ?, ?, ?)");
    const transaction = db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        const phone = `15551${String(i).padStart(6, "0")}`;
        insert.run(`${phone}@s.whatsapp.net`, `Synthetic Contact ${i}`, null, phone);
      }
    });
    transaction();
  } finally {
    db.close();
  }
}

function createMsgstoreDb(filePath: string, options: SyntheticFixtureOptions): void {
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE chat_list (
        key_remote_jid TEXT PRIMARY KEY,
        subject TEXT,
        sort_timestamp INTEGER
      );

      CREATE TABLE messages (
        _id INTEGER PRIMARY KEY,
        key_remote_jid TEXT NOT NULL,
        key_from_me INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        remote_resource TEXT,
        data TEXT,
        timestamp INTEGER,
        media_wa_type INTEGER,
        media_mime_type TEXT,
        media_name TEXT,
        quoted_row_id INTEGER,
        status INTEGER,
        starred INTEGER,
        forwarded INTEGER
      );
    `);
    db.prepare("INSERT INTO chat_list (key_remote_jid, subject, sort_timestamp) VALUES (?, ?, ?)").run(
      "15550000001@s.whatsapp.net",
      null,
      1710000003000
    );
    db.prepare("INSERT INTO chat_list (key_remote_jid, subject, sort_timestamp) VALUES (?, ?, ?)").run(
      "120363000000000001@g.us",
      "Weekend Plans",
      1710000006000
    );
    const insert = db.prepare(`
      INSERT INTO messages
      (_id, key_remote_jid, key_from_me, key_id, remote_resource, data, timestamp, media_wa_type,
       media_mime_type, media_name, quoted_row_id, status, starred, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(1, "15550000001@s.whatsapp.net", 0, "direct-1", null, "Hello from a synthetic chat.", 1710000001000, 0, null, null, null, 0, 0, 0);
    insert.run(2, "15550000001@s.whatsapp.net", 1, "direct-2", null, "Reply from me.", 1710000002000, 0, null, null, 1, 0, 0, 0);
    insert.run(3, "15550000001@s.whatsapp.net", 0, "direct-3", null, options.privacyCanary ? "FAKE_SECRET_DO_NOT_LOG" : "A longer follow-up with\nmultiple lines.", 1710000003000, 0, null, null, null, 0, 1, 0);
    insert.run(4, "120363000000000001@g.us", 0, "group-1", "15550000002@s.whatsapp.net", "Can everyone make Saturday?", 1710000004000, 0, null, null, null, 0, 0, 0);
    insert.run(5, "120363000000000001@g.us", 0, "group-2", "15550000003@s.whatsapp.net", null, 1710000005000, 1, "image/jpeg", "synthetic-image.jpg", null, 0, 0, 0);
    insert.run(6, "120363000000000001@g.us", 1, "group-3", null, "Works for me.", 1710000006000, 0, null, null, 4, 0, 0, 1);
    insert.run(7, "120363000000000001@g.us", 0, "group-unknown", "15550000002@s.whatsapp.net", null, 1710000007000, 999, null, null, null, 0, 0, 0);

    if (options.large) {
      const transaction = db.transaction(() => {
        for (let i = 0; i < 10000; i += 1) {
          insert.run(
            1000 + i,
            "15550000001@s.whatsapp.net",
            i % 2,
            `bulk-${i}`,
            null,
            `Synthetic bulk message ${i}`,
            1710100000000 + i * 1000,
            0,
            null,
            null,
            null,
            0,
            0,
            0
          );
        }
      });
      transaction();
    }

    if (options.manyChats && options.manyChats > 0) {
      addManyChats(db, insert, options.manyChats);
    }

    if (options.missingOptional) {
      db.exec("CREATE TABLE messages_minimal (_id INTEGER PRIMARY KEY, key_remote_jid TEXT, key_id TEXT);");
    }
  } finally {
    db.close();
  }
  if (options.manyChats && options.manyChats > 0) {
    addManyChatContacts(path.join(path.dirname(filePath), "wa.db"), options.manyChats);
  }
}

function addManyChats(db: Database.Database, insertMessage: Database.Statement, count: number): void {
  const insertChat = db.prepare("INSERT INTO chat_list (key_remote_jid, subject, sort_timestamp) VALUES (?, ?, ?)");
  const transaction = db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const phone = `15551${String(i).padStart(6, "0")}`;
      const jid = `${phone}@s.whatsapp.net`;
      const timestamp = 1713000000000 + i * 1000;
      insertChat.run(jid, null, timestamp);
      insertMessage.run(
        200000 + i,
        jid,
        i % 2,
        `many-chat-${i}`,
        null,
        `Synthetic many-chat message ${i}`,
        timestamp,
        0,
        null,
        null,
        null,
        0,
        0,
        0
      );
    }
  });
  transaction();
}

function createModernMsgstoreDb(filePath: string): void {
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE jid (
        _id INTEGER PRIMARY KEY,
        raw_string TEXT,
        user TEXT,
        server TEXT
      );

      CREATE TABLE chat (
        _id INTEGER PRIMARY KEY,
        jid_row_id INTEGER NOT NULL,
        subject TEXT,
        display_name TEXT,
        sort_timestamp INTEGER
      );

      CREATE TABLE message (
        _id INTEGER PRIMARY KEY,
        chat_row_id INTEGER NOT NULL,
        sender_jid_row_id INTEGER,
        from_me INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        timestamp INTEGER,
        message_type INTEGER,
        quoted_message_row_id INTEGER,
        status INTEGER,
        starred INTEGER,
        forwarded INTEGER
      );

      CREATE TABLE message_text (
        message_row_id INTEGER PRIMARY KEY,
        text_data TEXT
      );

      CREATE TABLE message_quoted (
        _id INTEGER PRIMARY KEY,
        sender_jid_row_id INTEGER,
        chat_row_id INTEGER,
        from_me INTEGER,
        key_id TEXT,
        timestamp INTEGER,
        message_type INTEGER,
        text_data TEXT
      );
      CREATE TABLE message_quoted_media (quoted_message_row_id INTEGER, mime_type TEXT, media_name TEXT, caption TEXT, thumbnail BLOB);
      CREATE TABLE message_quoted_location (quoted_message_row_id INTEGER, latitude REAL, longitude REAL, name TEXT, address TEXT);
      CREATE TABLE message_quoted_vcard (quoted_message_row_id INTEGER, name TEXT, vcard TEXT);
      CREATE TABLE message_quoted_mentions (quoted_message_row_id INTEGER, jid_row_id INTEGER);
    `);
    const insertJid = db.prepare("INSERT INTO jid (_id, raw_string, user, server) VALUES (?, ?, ?, ?)");
    insertJid.run(1, "15550000001@s.whatsapp.net", "15550000001", "s.whatsapp.net");
    insertJid.run(2, "120363000000000002@g.us", "120363000000000002", "g.us");
    insertJid.run(3, "15550000002@s.whatsapp.net", "15550000002", "s.whatsapp.net");
    insertJid.run(4, "15550000003@s.whatsapp.net", "15550000003", "s.whatsapp.net");

    const insertChat = db.prepare("INSERT INTO chat (_id, jid_row_id, subject, display_name, sort_timestamp) VALUES (?, ?, ?, ?, ?)");
    insertChat.run(10, 1, null, "Avery Example", 1711000002000);
    insertChat.run(20, 2, "Modern Group", null, 1711000005000);

    const insertMessage = db.prepare(`
      INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, quoted_message_row_id, status, starred, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertText = db.prepare("INSERT INTO message_text (message_row_id, text_data) VALUES (?, ?)");
    insertMessage.run(100, 10, null, 0, "modern-direct-1", 1711000001000, 0, null, 0, 0, 0);
    insertText.run(100, "Modern hello");
    insertMessage.run(101, 10, null, 1, "modern-direct-2", 1711000002000, 0, null, 0, 0, 0);
    insertText.run(101, "Modern reply from me");
    insertMessage.run(102, 20, 3, 0, "modern-group-1", 1711000003000, 0, null, 0, 0, 0);
    insertText.run(102, "Modern group message");
    insertMessage.run(103, 20, 4, 0, "modern-group-2", 1711000004000, 9, null, 0, 0, 0);
    insertText.run(103, "Modern document caption");
    insertMessage.run(104, 20, null, 1, "modern-group-3", 1711000005000, 0, 900, 0, 1, 1);
    insertText.run(104, "Modern outgoing group reply");
    db.prepare("INSERT INTO message_quoted (_id, sender_jid_row_id, chat_row_id, from_me, key_id, timestamp, message_type, text_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(900, 3, 20, 0, "modern-group-1", 1711000003000, 0, "Long quoted context: " + "complete ".repeat(40));
    db.prepare("INSERT INTO message_quoted_media (quoted_message_row_id, mime_type, media_name, caption, thumbnail) VALUES (?, ?, ?, ?, ?)")
      .run(900, "image/jpeg", "quoted.jpg", "quoted caption", Buffer.from([1, 2, 3]));
    db.prepare("INSERT INTO message_quoted_location (quoted_message_row_id, latitude, longitude, name, address) VALUES (?, ?, ?, ?, ?)")
      .run(900, 1.5, 2.5, "Cafe", "Main St");
    db.prepare("INSERT INTO message_quoted_vcard (quoted_message_row_id, name, vcard) VALUES (?, ?, ?)")
      .run(900, "Casey", "BEGIN:VCARD");
    db.prepare("INSERT INTO message_quoted_mentions (quoted_message_row_id, jid_row_id) VALUES (?, ?)").run(900, 4);
  } finally {
    db.close();
  }
}
