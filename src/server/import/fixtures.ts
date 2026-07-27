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

// The curated demo-mode dataset: a modern-schema backup whose content is
// small enough to provision in seconds but rich enough that every archive
// surface has something real to show — named contacts, 1:1 and group chats,
// reactions, a quoted reply, link previews, an edited message, media and
// voice-note placeholders, and commitment-shaped exchanges. Everything is
// fictional, innocuous, and fixed: same ids, same text, same timestamps on
// every run, so demo screenshots and walkthroughs are reproducible.
export async function createDemoFixture(directory: string): Promise<SyntheticFixturePaths> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const msgstorePath = path.join(directory, "msgstore.db");
  const waPath = path.join(directory, "wa.db");
  createDemoWaDb(waPath);
  createDemoMsgstoreDb(msgstorePath);
  return { directory, msgstorePath, waPath };
}

const DEMO_PEOPLE = [
  { jidRowId: 1, phone: "15550100001", name: "Avery Patel", waName: "Avery" },
  { jidRowId: 2, phone: "15550100007", name: "Grace Okafor", waName: "Grace" },
  { jidRowId: 5, phone: "15550100002", name: "Blake Morgan", waName: "Blake" },
  { jidRowId: 6, phone: "15550100003", name: "Casey Lin", waName: "Casey" },
  { jidRowId: 7, phone: "15550100004", name: "Devon Reyes", waName: "Devon" },
  { jidRowId: 8, phone: "15550100005", name: "Elliot Shaw", waName: "Elliot" },
  { jidRowId: 9, phone: "15550100006", name: "Frankie Cole", waName: "Frankie" },
  { jidRowId: 10, phone: "15550100008", name: "Harper Quinn", waName: "Harper" }
] as const;

const DEMO_HIKE_GROUP_JID = "120363111111111111@g.us";
const DEMO_TRIP_GROUP_JID = "120363222222222222@g.us";

// Fixed calendar anchor: March 2024, UTC. Date.UTC of constants is fully
// deterministic — no clock reads anywhere in the demo dataset.
function demoAt(day: number, hour: number, minute: number): number {
  return Date.UTC(2024, 2, day, hour, minute);
}

function createDemoWaDb(filePath: string): void {
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
    for (const person of DEMO_PEOPLE) {
      insert.run(`${person.phone}@s.whatsapp.net`, person.name, person.waName, person.phone);
    }
    insert.run(DEMO_HIKE_GROUP_JID, "Saturday Hike Crew", null, null);
    insert.run(DEMO_TRIP_GROUP_JID, "Lakeside Trip Planning", null, null);
  } finally {
    db.close();
  }
}

function createDemoMsgstoreDb(filePath: string): void {
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
        text_data TEXT,
        page_title TEXT,
        description TEXT,
        url TEXT
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

      CREATE TABLE message_media (
        message_row_id INTEGER PRIMARY KEY,
        mime_type TEXT,
        media_name TEXT,
        media_duration INTEGER,
        accessibility_label TEXT,
        raw_transcription_text TEXT
      );

      CREATE TABLE message_edit_info (
        message_row_id INTEGER PRIMARY KEY,
        original_key_id TEXT,
        edited_timestamp INTEGER,
        sender_timestamp INTEGER
      );

      CREATE TABLE message_add_on (
        _id INTEGER PRIMARY KEY,
        chat_row_id INTEGER,
        parent_message_row_id INTEGER,
        from_me INTEGER,
        sender_jid_row_id INTEGER,
        timestamp INTEGER
      );

      CREATE TABLE message_add_on_reaction (
        message_add_on_row_id INTEGER PRIMARY KEY,
        reaction TEXT
      );

      CREATE TABLE group_participant_user (
        _id INTEGER PRIMARY KEY,
        group_jid_row_id INTEGER,
        user_jid_row_id INTEGER,
        rank INTEGER,
        add_timestamp INTEGER
      );
    `);

    const insertJid = db.prepare("INSERT INTO jid (_id, raw_string, user, server) VALUES (?, ?, ?, ?)");
    for (const person of DEMO_PEOPLE) {
      insertJid.run(person.jidRowId, `${person.phone}@s.whatsapp.net`, person.phone, "s.whatsapp.net");
    }
    insertJid.run(3, DEMO_HIKE_GROUP_JID, "120363111111111111", "g.us");
    insertJid.run(4, DEMO_TRIP_GROUP_JID, "120363222222222222", "g.us");

    const insertChat = db.prepare("INSERT INTO chat (_id, jid_row_id, subject, display_name, sort_timestamp) VALUES (?, ?, ?, ?, ?)");
    insertChat.run(1, 1, null, "Avery Patel", demoAt(18, 19, 5));
    insertChat.run(2, 2, null, "Grace Okafor", demoAt(20, 17, 45));
    insertChat.run(3, 3, "Saturday Hike Crew", null, demoAt(23, 9, 30));
    insertChat.run(4, 4, "Lakeside Trip Planning", null, demoAt(22, 20, 15));

    const insertMessage = db.prepare(`
      INSERT INTO message (_id, chat_row_id, sender_jid_row_id, from_me, key_id, timestamp, message_type, quoted_message_row_id, status, starred, forwarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertText = db.prepare("INSERT INTO message_text (message_row_id, text_data, page_title, description, url) VALUES (?, ?, ?, ?, ?)");

    type DemoMessage = {
      id: number;
      chat: number;
      sender: number | null;
      fromMe?: boolean;
      key: string;
      at: number;
      text?: string;
      type?: number;
      quotedRowId?: number;
      starred?: boolean;
      forwarded?: boolean;
      link?: { title: string; description: string; url: string };
    };

    const messages: DemoMessage[] = [
      // ── Avery Patel, 1:1 (chat 1): catch-up, lunch plan with a quoted reply
      // and an edited time, a shared article link.
      { id: 1000, chat: 1, sender: null, key: "demo-avery-1", at: demoAt(4, 9, 12), text: "Morning! How did the pottery class go?" },
      { id: 1001, chat: 1, sender: null, fromMe: true, key: "demo-avery-2", at: demoAt(4, 9, 20), text: "Better than expected — I made a bowl that is almost round." },
      { id: 1002, chat: 1, sender: null, key: "demo-avery-3", at: demoAt(4, 9, 21), text: "Almost round is the potter's ideal. Photos next time." },
      { id: 1003, chat: 1, sender: null, fromMe: true, key: "demo-avery-4", at: demoAt(4, 9, 25), text: "Deal. How is the balcony garden surviving the frost?" },
      { id: 1004, chat: 1, sender: null, key: "demo-avery-5", at: demoAt(4, 9, 40), text: "Two tomato plants down, the rosemary is unbothered as always." },
      { id: 1005, chat: 1, sender: null, key: "demo-avery-6", at: demoAt(11, 12, 2), text: "Lunch this week? I owe you for the airport pickup." },
      { id: 1006, chat: 1, sender: null, fromMe: true, key: "demo-avery-7", at: demoAt(11, 12, 10), text: "Thursday works — how about the noodle place on 5th?" },
      { id: 1007, chat: 1, sender: null, key: "demo-avery-8", at: demoAt(11, 12, 12), quotedRowId: 9001, text: "Perfect. 12:30?" },
      { id: 1008, chat: 1, sender: null, fromMe: true, key: "demo-avery-9", at: demoAt(11, 12, 20), text: "Let's say 1pm — my morning meeting tends to run long." },
      { id: 1009, chat: 1, sender: null, key: "demo-avery-10", at: demoAt(11, 12, 21), text: "1pm it is. Booked in my head." },
      { id: 1010, chat: 1, sender: null, key: "demo-avery-11", at: demoAt(14, 13, 45), text: "Thursday was great — same again next month?" },
      { id: 1011, chat: 1, sender: null, fromMe: true, key: "demo-avery-12", at: demoAt(14, 13, 50), text: "Standing appointment. I'll bring the pottery photos." },
      {
        id: 1012, chat: 1, sender: null, key: "demo-avery-13", at: demoAt(18, 19, 0),
        text: "This piece on slow travel made me think of your sabbatical plan.",
        link: { title: "The Case for Slow Travel", description: "Why the best trips are the ones you don't optimize.", url: "https://example.test/slow-travel" }
      },
      { id: 1013, chat: 1, sender: null, fromMe: true, key: "demo-avery-14", at: demoAt(18, 19, 5), text: "Saving this for the weekend read. Thank you!", starred: true },

      // ── Grace Okafor, 1:1 (chat 2): recipes, an image placeholder, a voice
      // note with a transcription.
      { id: 2000, chat: 2, sender: null, key: "demo-grace-1", at: demoAt(6, 17, 30), text: "Found grandma's lasagna recipe card while cleaning. Want a copy?" },
      { id: 2001, chat: 2, sender: null, fromMe: true, key: "demo-grace-2", at: demoAt(6, 17, 41), text: "YES. The one with the three-cheese layer?" },
      { id: 2002, chat: 2, sender: null, key: "demo-grace-3", at: demoAt(6, 17, 44), type: 1, text: "That's the one. Card front — mind the sauce stain." },
      { id: 2003, chat: 2, sender: null, fromMe: true, key: "demo-grace-4", at: demoAt(6, 18, 2), text: "A sauce stain is a seal of quality on a recipe card." },
      { id: 2004, chat: 2, sender: null, key: "demo-grace-5", at: demoAt(13, 11, 15), type: 2 },
      { id: 2005, chat: 2, sender: null, fromMe: true, key: "demo-grace-6", at: demoAt(13, 11, 40), text: "Calling you after work — that's exciting news!" },
      { id: 2006, chat: 2, sender: null, key: "demo-grace-7", at: demoAt(13, 19, 5), text: "Talked to the venue. June 14th is available for the reunion." },
      { id: 2007, chat: 2, sender: null, fromMe: true, key: "demo-grace-8", at: demoAt(13, 19, 12), text: "Put us down for it. I'll email the cousins list tonight." },
      { id: 2008, chat: 2, sender: null, key: "demo-grace-9", at: demoAt(20, 17, 30), text: "Reminder: send the cousins list when you get a minute." },
      { id: 2009, chat: 2, sender: null, fromMe: true, key: "demo-grace-10", at: demoAt(20, 17, 45), text: "Sent just now — 23 names, two maybes." },

      // ── Saturday Hike Crew (chat 3): weekend planning with reactions, a
      // forwarded trail notice, and a starred trailhead link.
      { id: 3000, chat: 3, sender: 5, key: "demo-hike-1", at: demoAt(5, 8, 30), text: "Crew — Saturday forecast is sunny and 14°. Ridge loop?" },
      { id: 3001, chat: 3, sender: 6, key: "demo-hike-2", at: demoAt(5, 8, 45), text: "In. Can we do the 9am start though, not the sunrise nonsense?" },
      { id: 3002, chat: 3, sender: 7, key: "demo-hike-3", at: demoAt(5, 8, 50), text: "Seconding the 9am motion." },
      { id: 3003, chat: 3, sender: null, fromMe: true, key: "demo-hike-4", at: demoAt(5, 9, 0), text: "9am at the north lot then. I'll bring the thermos of coffee." },
      { id: 3004, chat: 3, sender: 8, key: "demo-hike-5", at: demoAt(5, 9, 15), text: "And I'll bring the good trail mix, not the raisin-heavy one." },
      {
        id: 3005, chat: 3, sender: 5, key: "demo-hike-6", at: demoAt(5, 9, 30), starred: true,
        text: "Trailhead details for anyone new to the ridge loop:",
        link: { title: "Ridge Loop Trailhead — North Lot", description: "7.2 km loop, 340 m elevation, parking fills by 10am on weekends.", url: "https://example.test/ridge-loop" }
      },
      { id: 3006, chat: 3, sender: 7, key: "demo-hike-7", at: demoAt(8, 18, 20), forwarded: true, text: "Trail notice: bridge at km 4 under repair this week, detour adds 15 minutes." },
      { id: 3007, chat: 3, sender: null, fromMe: true, key: "demo-hike-8", at: demoAt(8, 18, 25), text: "Good catch — detour it is. Still 9am." },
      { id: 3008, chat: 3, sender: 6, key: "demo-hike-9", at: demoAt(9, 16, 10), text: "That was a top-three hike. The detour view was better than the bridge." },
      { id: 3009, chat: 3, sender: 8, key: "demo-hike-10", at: demoAt(9, 16, 12), text: "Petition to make the detour the official route." },
      { id: 3010, chat: 3, sender: 5, key: "demo-hike-11", at: demoAt(12, 8, 0), text: "Next Saturday: lake trail? Forecast says light rain, bring shells." },
      { id: 3011, chat: 3, sender: 7, key: "demo-hike-12", at: demoAt(12, 8, 30), text: "Rain hike crew unite. I'm in." },
      { id: 3012, chat: 3, sender: null, fromMe: true, key: "demo-hike-13", at: demoAt(12, 9, 5), text: "In, and I'll check the parking situation Friday." },
      { id: 3013, chat: 3, sender: 6, key: "demo-hike-14", at: demoAt(16, 15, 40), text: "Lake trail verdict: soggy, spectacular, would repeat." },
      { id: 3014, chat: 3, sender: 8, key: "demo-hike-15", at: demoAt(19, 12, 0), text: "Photos from both hikes are in the shared album now." },
      { id: 3015, chat: 3, sender: null, fromMe: true, key: "demo-hike-16", at: demoAt(23, 9, 30), text: "Album is gold. Same time next Saturday, ridge loop again?" },

      // ── Lakeside Trip Planning (chat 4): dates, a cabin-booking commitment
      // made and kept, reactions, and a quoted confirmation.
      { id: 4000, chat: 4, sender: 6, key: "demo-trip-1", at: demoAt(7, 20, 0), text: "Lakeside weekend — April 19–21 or April 26–28?" },
      { id: 4001, chat: 4, sender: 9, key: "demo-trip-2", at: demoAt(7, 20, 10), text: "26–28 for me, the 19th is my sister's recital." },
      { id: 4002, chat: 4, sender: 10, key: "demo-trip-3", at: demoAt(7, 20, 12), text: "Either works. Slight lean to 26–28." },
      { id: 4003, chat: 4, sender: 2, key: "demo-trip-4", at: demoAt(7, 20, 30), text: "26–28 then? Speak now or forever hold your kayak." },
      { id: 4004, chat: 4, sender: null, fromMe: true, key: "demo-trip-5", at: demoAt(7, 20, 45), text: "26–28 confirmed on my end. I'll book the cabin by Friday." },
      { id: 4005, chat: 4, sender: 6, key: "demo-trip-6", at: demoAt(7, 20, 50), text: "Hero. The one with the wood stove if it's free." },
      { id: 4006, chat: 4, sender: null, fromMe: true, key: "demo-trip-7", at: demoAt(15, 18, 30), text: "Cabin booked ✅ Wood stove secured, 26–28, sleeps six." },
      { id: 4007, chat: 4, sender: 9, key: "demo-trip-8", at: demoAt(15, 18, 32), quotedRowId: 9002, text: "Legend. Sending you my share tonight." },
      { id: 4008, chat: 4, sender: 10, key: "demo-trip-9", at: demoAt(15, 18, 40), text: "Same. I'll own the grocery run — send dietary notes." },
      { id: 4009, chat: 4, sender: 2, key: "demo-trip-10", at: demoAt(15, 19, 0), text: "No cilantro in anything and we will remain friends." },
      { id: 4010, chat: 4, sender: 6, key: "demo-trip-11", at: demoAt(21, 12, 15), text: "Kayak rental reserved for Saturday morning, four boats." },
      { id: 4011, chat: 4, sender: null, fromMe: true, key: "demo-trip-12", at: demoAt(21, 12, 20), text: "This trip is planning itself. Firewood is on my list." },
      { id: 4012, chat: 4, sender: 10, key: "demo-trip-13", at: demoAt(22, 20, 15), text: "Packing list draft is in the album — shout if I missed anything." }
    ];

    for (const message of messages) {
      insertMessage.run(
        message.id,
        message.chat,
        message.sender,
        message.fromMe ? 1 : 0,
        message.key,
        message.at,
        message.type ?? 0,
        message.quotedRowId ?? null,
        0,
        message.starred ? 1 : 0,
        message.forwarded ? 1 : 0
      );
      if (message.text !== undefined || message.link) {
        insertText.run(message.id, message.text ?? null, message.link?.title ?? null, message.link?.description ?? null, message.link?.url ?? null);
      }
    }

    // Quoted-message snapshots referenced by quoted_message_row_id above.
    const insertQuoted = db.prepare(
      "INSERT INTO message_quoted (_id, sender_jid_row_id, chat_row_id, from_me, key_id, timestamp, message_type, text_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insertQuoted.run(9001, null, 1, 1, "demo-avery-7", demoAt(11, 12, 10), 0, "Thursday works — how about the noodle place on 5th?");
    insertQuoted.run(9002, null, 4, 1, "demo-trip-7", demoAt(15, 18, 30), 0, "Cabin booked ✅ Wood stove secured, 26–28, sleeps six.");

    // Media placeholders: the recipe-card photo and a voice note whose
    // transcription the thread view can show. No blobs — the demo media store
    // is empty by design and the UI shows its honest placeholder states.
    const insertMedia = db.prepare(
      "INSERT INTO message_media (message_row_id, mime_type, media_name, media_duration, accessibility_label, raw_transcription_text) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insertMedia.run(2002, "image/jpeg", "recipe-card.jpg", null, "Handwritten recipe card", null);
    insertMedia.run(2004, "audio/ogg; codecs=opus", null, 19, null, "Call me when you get a chance — I found the reunion venue and the date might actually work.");

    // One edited message: the lunch-time correction keeps its original key.
    db.prepare("INSERT INTO message_edit_info (message_row_id, original_key_id, edited_timestamp, sender_timestamp) VALUES (?, ?, ?, ?)")
      .run(1008, "demo-avery-9", demoAt(11, 12, 22), demoAt(11, 12, 20));

    // Reactions as backup add-on rows, exactly the shape the importer reads.
    const insertAddOn = db.prepare(
      "INSERT INTO message_add_on (_id, chat_row_id, parent_message_row_id, from_me, sender_jid_row_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertReaction = db.prepare("INSERT INTO message_add_on_reaction (message_add_on_row_id, reaction) VALUES (?, ?)");
    const reactions: Array<{ id: number; chat: number; parent: number; sender: number | null; fromMe?: boolean; at: number; emoji: string }> = [
      { id: 8000, chat: 1, parent: 1001, sender: 1, at: demoAt(4, 9, 22), emoji: "❤️" },
      { id: 8001, chat: 2, parent: 2002, sender: null, fromMe: true, at: demoAt(6, 18, 0), emoji: "👍" },
      { id: 8002, chat: 3, parent: 3003, sender: 5, at: demoAt(5, 9, 2), emoji: "👍" },
      { id: 8003, chat: 3, parent: 3003, sender: 8, at: demoAt(5, 9, 16), emoji: "🔥" },
      { id: 8004, chat: 4, parent: 4006, sender: 6, at: demoAt(15, 18, 31), emoji: "🎉" },
      { id: 8005, chat: 4, parent: 4006, sender: 2, at: demoAt(15, 19, 1), emoji: "🎉" }
    ];
    for (const reaction of reactions) {
      insertAddOn.run(reaction.id, reaction.chat, reaction.parent, reaction.fromMe ? 1 : 0, reaction.sender, reaction.at);
      insertReaction.run(reaction.id, reaction.emoji);
    }

    // Group membership for both groups (rank 1 = admin-ish founder).
    const insertParticipant = db.prepare(
      "INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id, rank, add_timestamp) VALUES (?, ?, ?, ?)"
    );
    for (const member of [5, 6, 7, 8]) {
      insertParticipant.run(3, member, member === 5 ? 1 : 0, demoAt(1, 10, 0));
    }
    for (const member of [6, 9, 10, 2]) {
      insertParticipant.run(4, member, member === 6 ? 1 : 0, demoAt(1, 10, 0));
    }
  } finally {
    db.close();
  }
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
