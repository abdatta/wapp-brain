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
