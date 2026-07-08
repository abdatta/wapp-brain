import { createCipheriv, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proto } from "@whiskeysockets/baileys";
import type { MessageRecord } from "../src/shared/types";
import { SqliteArchiveRepository } from "../src/server/db/sqliteRepository";
import { runRetainedPayloadDecryptionPass } from "../src/server/live/secretsPass";
import { normalizeBaileysMessage } from "../src/server/live/normalize";
import { messageKey } from "../src/server/identity/keys";

const CHAT = "12136968563@s.whatsapp.net";
const SENDER_LID = "244543240839423@lid";

// Build the ciphertext exactly as WhatsApp encrypts a secret MESSAGE_EDIT:
// key = HKDF-SHA256(messageSecret, salt=zeros, info = id+lid+lid+"Message Edit"),
// AES-256-GCM with no AAD; plaintext is a Message with protocolMessage.editedMessage.
function encryptEdit(secret: Buffer, targetId: string, lid: string, newText: string): { encPayload: Buffer; encIv: Buffer } {
  const useCaseSecret = Buffer.concat([Buffer.from(targetId), Buffer.from(lid), Buffer.from(lid), Buffer.from("Message Edit")]);
  const prk = createHmac("sha256", Buffer.alloc(32)).update(secret).digest();
  const key = createHmac("sha256", prk).update(Buffer.concat([useCaseSecret, Buffer.from([1])])).digest();
  const plaintext = proto.Message.encode({ protocolMessage: { editedMessage: { conversation: newText } } } as never).finish();
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return { encPayload: Buffer.concat([enc, cipher.getAuthTag()]), encIv: iv };
}

function originalMessage(id: string, body: string): MessageRecord {
  return {
    sourceMessageId: id,
    sourceMessageKey: messageKey(CHAT, id),
    sourceTable: "wa-web:messages.upsert",
    sourceRowId: id,
    chatSourceId: CHAT,
    senderSourceJid: CHAT,
    timestampMs: 1000,
    sentAtIso: new Date(1000).toISOString(),
    fromMe: false,
    direction: "incoming",
    messageType: "text",
    rawTypeCode: "0",
    body,
    caption: null,
    hasMedia: false,
    mediaMimeType: null,
    mediaName: null,
    quotedSourceMessageId: null,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    rawMetadata: null
  };
}

describe("secret-encrypted message edits", () => {
  it("does not create a standalone row for a secret-encrypted edit envelope", () => {
    const normalized = normalizeBaileysMessage(
      {
        key: { remoteJid: CHAT, id: "ENVELOPE1", fromMe: false },
        messageTimestamp: 2000,
        message: { secretEncryptedMessage: { targetMessageKey: { id: "ORIG1" }, encPayload: new Uint8Array([1]), secretEncType: 2 }, messageContextInfo: {} }
      },
      "wa-web:messages.upsert"
    );
    // It is a targeted update, not a message of its own — no confusing card.
    expect(normalized).toBeNull();
  });

  it("decrypts a secret MESSAGE_EDIT and applies it in place with retained history", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-secret-edit-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([originalMessage("ORIG1", "So")]);
      // The archive knows the sender's LID (learned from history sync) — the
      // decryptor reverse-maps the phone JID to it.
      await repository.recordIdentityLinks([{ lid: SENDER_LID, pn: CHAT, source: "test" }]);

      const secret = Buffer.alloc(32, 9);
      await repository.recordMessageSecrets([{ chatSourceId: CHAT, sourceMessageId: "ORIG1", secret, source: "live" }]);
      const { encPayload, encIv } = encryptEdit(secret, "ORIG1", SENDER_LID, "So what's up");
      await repository.retainEncryptedPayloads([
        {
          eventKey: "wa-web:retained:secret_encrypted:test",
          chatSourceId: CHAT,
          targetMessageId: "ORIG1",
          kind: "secret_encrypted",
          actorJid: CHAT,
          encPayload,
          encIv,
          occurredAtMs: 2000,
          metadata: { secretEncType: 2 }
        }
      ]);

      const result = await runRetainedPayloadDecryptionPass(repository, { limit: 50 });
      expect(result.decrypted).toBe(1);

      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const [message] = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      // Applied in place: the target now shows the edited text and is flagged.
      expect(message.body).toBe("So what's up");
      expect(message.isEdited).toBe(true);
      expect(message.editRevisionCount).toBe(1);
      // Prior text is retained as history.
      const revisions = await repository.listMessageEditRevisions(message.id);
      expect(revisions.map((r) => r.body)).toEqual(["So"]);
      // The consumed payload is not reprocessed.
      expect(await repository.listRetainedEncryptedPayloads(10)).toHaveLength(0);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves the edit retained (never fabricates) when the sender's LID is unknown", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-secret-edit-nolid-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([originalMessage("ORIG2", "unchanged")]);
      const secret = Buffer.alloc(32, 5);
      await repository.recordMessageSecrets([{ chatSourceId: CHAT, sourceMessageId: "ORIG2", secret, source: "live" }]);
      const { encPayload, encIv } = encryptEdit(secret, "ORIG2", SENDER_LID, "edited text");
      await repository.retainEncryptedPayloads([
        {
          eventKey: "wa-web:retained:secret_encrypted:nolid",
          chatSourceId: CHAT,
          targetMessageId: "ORIG2",
          kind: "secret_encrypted",
          actorJid: CHAT,
          encPayload,
          encIv,
          occurredAtMs: 2000,
          metadata: { secretEncType: 2 }
        }
      ]);

      // No identity link recorded → no LID candidate → cannot decrypt.
      const result = await runRetainedPayloadDecryptionPass(repository, { limit: 50 });
      expect(result.decrypted).toBe(0);
      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const [message] = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(message.body).toBe("unchanged");
      expect(message.isEdited).toBe(false);
      // Retained for a later attempt, never dropped.
      expect(await repository.listRetainedEncryptedPayloads(10)).toHaveLength(1);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes stale encrypted-edit placeholder rows archived before edits were decrypted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "wapp-secret-edit-cleanup-"));
    let repository: SqliteArchiveRepository | null = null;
    try {
      repository = new SqliteArchiveRepository(path.join(tempDir, "archive.sqlite"));
      await repository.upsertChats("run", [{ sourceChatId: CHAT, jid: CHAT, displayName: null, chatType: "dm" }]);
      await repository.upsertMessages([
        originalMessage("KEEP1", "real message"),
        { ...originalMessage("CARD1", ""), messageType: "encrypted_update", body: null }
      ]);
      const removed = await repository.removeProtocolNoiseMessages();
      expect(removed).toBe(1);
      const chats = await repository.listChats({ limit: 10, offset: 0, includeEventOnly: true });
      const messages = await repository.listMessages(chats[0].id, { limit: 10, offset: 0 });
      expect(messages.map((m) => m.sourceMessageId)).toEqual(["KEEP1"]);
    } finally {
      await repository?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
