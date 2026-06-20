import type { ChatRecord, ChatType, ContactRecord, MessageRecord } from "../../shared/types";
import { inferChatType, normalizeJid } from "../import/jid";
import type { LiveMessageEvent, LiveMessageStateUpdate } from "./types";

interface BaileysLikeMessage {
  key?: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  };
  messageTimestamp?: number | LongLike | null;
  pushName?: string | null;
  message?: Record<string, unknown> | null;
}

interface LongLike {
  toNumber?: () => number;
}

interface BaileysLikeContact {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
  username?: string | null;
  verifiedName?: string | null;
}

interface BaileysLikeChat {
  id?: string | null;
  name?: string | null;
  subject?: string | null;
  displayName?: string | null;
  username?: string | null;
  conversationTimestamp?: number | LongLike | null;
  lastMessageRecvTimestamp?: number | LongLike | null;
}

export type LiveJidResolver = (jid: string) => Promise<string | null | undefined> | string | null | undefined;

export function normalizeBaileysMessage(message: BaileysLikeMessage, sourceTable: string, sourceRowId?: string): MessageRecord | null {
  const chatSourceId = message.key?.remoteJid ?? null;
  const sourceMessageId = message.key?.id ?? null;
  if (!chatSourceId || !sourceMessageId) {
    return null;
  }
  const fromMe = message.key?.fromMe ?? null;
  const timestampMs = timestampToMs(message.messageTimestamp);
  const content = unwrapMessageContent(message.message);
  const body = extractText(content);
  const messageType = detectMessageType(content);
  const senderSourceJid = fromMe ? null : message.key?.participant ?? chatSourceId;
  return {
    sourceMessageId,
    sourceMessageKey: liveMessageKey({
      chatSourceId,
      sourceMessageId,
      participant: message.key?.participant ?? null,
      fromMe
    }),
    sourceTable,
    sourceRowId: sourceRowId ?? sourceMessageId,
    chatSourceId,
    senderSourceJid,
    timestampMs,
    sentAtIso: timestampMs ? new Date(timestampMs).toISOString() : null,
    fromMe,
    direction: fromMe === true ? "outgoing" : fromMe === false ? "incoming" : "unknown",
    messageType,
    rawTypeCode: messageType,
    body,
    caption: extractCaption(content),
    hasMedia: hasMediaContent(content),
    mediaMimeType: extractMimeType(content),
    mediaName: extractMediaName(content),
    quotedSourceMessageId: extractQuotedMessageId(content),
    isDeleted: Boolean(content?.protocolMessage),
    isForwarded: Boolean(nestedContext(content)?.isForwarded),
    isStarred: false,
    rawMetadata: {
      source: "wa-web",
      pushName: message.pushName ?? null,
      contentKeys: content ? Object.keys(content).slice(0, 12) : []
    }
  };
}

export function normalizeBaileysMessages(messages: BaileysLikeMessage[], sourceTable: string): LiveMessageEvent {
  const normalized = messages
    .map((message, index) => normalizeBaileysMessage(message, sourceTable, message.key?.id ?? String(index)))
    .filter((message): message is MessageRecord => Boolean(message));
  return eventFromMessages(normalized, sourceTable);
}

export async function normalizeBaileysMessageWithJidResolver(
  message: BaileysLikeMessage,
  sourceTable: string,
  resolveJid: LiveJidResolver,
  sourceRowId?: string
): Promise<MessageRecord | null> {
  return normalizeBaileysMessage(await resolveMessageJids(message, resolveJid), sourceTable, sourceRowId);
}

export async function normalizeBaileysMessagesWithJidResolver(
  messages: BaileysLikeMessage[],
  sourceTable: string,
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const normalized = (
    await Promise.all(
      messages.map((message, index) => normalizeBaileysMessageWithJidResolver(message, sourceTable, resolveJid, message.key?.id ?? String(index)))
    )
  ).filter((message): message is MessageRecord => Boolean(message));
  return eventFromMessages(normalized, sourceTable);
}

export async function normalizeBaileysContactsWithJidResolver(
  contacts: BaileysLikeContact[],
  eventType: "contacts.upsert" | "contacts.update",
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const normalized = (
    await Promise.all(contacts.map((contact) => normalizeBaileysContactWithJidResolver(contact, resolveJid)))
  ).filter((contact): contact is ContactRecord => Boolean(contact));
  return {
    eventKey: `${eventType}:${normalized.map((contact) => contact.sourceJid).join("|") || Date.now()}`,
    eventType,
    mode: "update",
    contacts: normalized
  };
}

export async function normalizeBaileysChatsWithJidResolver(
  chats: BaileysLikeChat[],
  eventType: "chats.upsert" | "chats.update",
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const normalized = (
    await Promise.all(chats.map((chat) => normalizeBaileysChatWithJidResolver(chat, resolveJid)))
  ).filter((chat): chat is ChatRecord => Boolean(chat));
  return {
    eventKey: `${eventType}:${normalized.map((chat) => chat.sourceChatId).join("|") || Date.now()}`,
    eventType,
    mode: "update",
    occurredAtMs: normalized.reduce<number | null>((latest, chat) => Math.max(latest ?? 0, Number(chat.rawMetadata?.timestampMs ?? 0)), null),
    chats: normalized
  };
}

export function normalizeDeleteUpdate(key: { remoteJid?: string | null; id?: string | null; participant?: string | null; fromMe?: boolean | null }): LiveMessageStateUpdate | null {
  if (!key.remoteJid || !key.id) {
    return null;
  }
  return {
    eventKey: `wa-web:delete:${liveMessageKey({
      chatSourceId: key.remoteJid,
      sourceMessageId: key.id,
      participant: key.participant ?? null,
      fromMe: key.fromMe ?? null
    })}`,
    chatSourceId: key.remoteJid,
    sourceMessageKey: liveMessageKey({
      chatSourceId: key.remoteJid,
      sourceMessageId: key.id,
      participant: key.participant ?? null,
      fromMe: key.fromMe ?? null
    }),
    updateType: "delete"
  };
}

export async function normalizeDeleteUpdateWithJidResolver(
  key: { remoteJid?: string | null; id?: string | null; participant?: string | null; fromMe?: boolean | null },
  resolveJid: LiveJidResolver
): Promise<LiveMessageStateUpdate | null> {
  return normalizeDeleteUpdate({
    ...key,
    remoteJid: await resolveCanonicalJid(key.remoteJid, resolveJid),
    participant: await resolveCanonicalJid(key.participant, resolveJid)
  });
}

export function liveMessageKey(input: {
  chatSourceId: string;
  sourceMessageId: string;
  participant?: string | null;
  fromMe?: boolean | null;
}): string {
  return ["wa-web", input.chatSourceId, input.participant ?? "", input.fromMe === true ? "1" : input.fromMe === false ? "0" : "x", input.sourceMessageId].join("|");
}

function eventFromMessages(normalized: MessageRecord[], sourceTable: string): LiveMessageEvent {
  const contacts = contactsFromMessages(normalized);
  return {
    eventKey: `${sourceTable}:${normalized.map((message) => message.sourceMessageKey).join("|") || Date.now()}`,
    eventType: sourceTable === "wa-web:history-sync" ? "messaging-history.set" : "messages.upsert",
    mode: sourceTable === "wa-web:history-sync" ? "history" : "notify",
    occurredAtMs: normalized.reduce<number | null>((latest, message) => Math.max(latest ?? 0, message.timestampMs ?? 0), null),
    chats: [
      ...new Map(
        normalized.map((message) => [
          message.chatSourceId,
          {
            sourceChatId: message.chatSourceId,
            jid: message.chatSourceId,
            displayName: inferChatType(message.chatSourceId) === "dm" ? contacts.get(message.chatSourceId)?.displayName ?? null : null,
            chatType: inferChatType(message.chatSourceId) as ChatType,
            rawMetadata: { source: "wa-web" }
          }
        ])
      ).values()
    ],
    contacts: [...contacts.values()],
    messages: normalized
  };
}

async function normalizeBaileysContactWithJidResolver(contact: BaileysLikeContact, resolveJid: LiveJidResolver): Promise<ContactRecord | null> {
  const jid = await resolveCanonicalJid(contact.phoneNumber || contact.id || contact.lid, resolveJid);
  if (!jid) {
    return null;
  }
  const displayName = firstNonEmpty(contact.name, contact.verifiedName, contact.username);
  return {
    sourceJid: jid,
    displayName,
    phoneNumber: contact.phoneNumber ? phoneFromLiveJid(contact.phoneNumber) : phoneFromLiveJid(jid),
    pushName: firstNonEmpty(contact.notify, contact.verifiedName),
    rawMetadata: {
      source: "wa-web-contact",
      hasName: Boolean(contact.name),
      hasNotify: Boolean(contact.notify),
      hasVerifiedName: Boolean(contact.verifiedName),
      username: contact.username ?? null,
      lid: contact.lid ?? null
    }
  };
}

async function normalizeBaileysChatWithJidResolver(chat: BaileysLikeChat, resolveJid: LiveJidResolver): Promise<ChatRecord | null> {
  const jid = await resolveCanonicalJid(chat.id, resolveJid);
  if (!jid) {
    return null;
  }
  const timestampMs = timestampToMs(chat.conversationTimestamp ?? chat.lastMessageRecvTimestamp);
  return {
    sourceChatId: jid,
    jid,
    displayName: firstNonEmpty(chat.subject, chat.name, chat.displayName, chat.username),
    chatType: inferChatType(jid) as ChatType,
    rawMetadata: {
      source: "wa-web-chat",
      timestampMs,
      hasName: Boolean(chat.name),
      hasSubject: Boolean(chat.subject)
    }
  };
}

function contactsFromMessages(messages: MessageRecord[]): Map<string, ContactRecord> {
  const contacts = new Map<string, ContactRecord>();
  for (const message of messages) {
    if (!message.senderSourceJid || message.senderSourceJid === "me") {
      continue;
    }
    const pushName = typeof message.rawMetadata?.pushName === "string" ? message.rawMetadata.pushName.trim() : "";
    if (!pushName) {
      continue;
    }
    contacts.set(message.senderSourceJid, {
      sourceJid: message.senderSourceJid,
      displayName: null,
      pushName,
      phoneNumber: phoneFromLiveJid(message.senderSourceJid),
      rawMetadata: { source: "wa-web-message-push-name" }
    });
  }
  return contacts;
}

async function resolveMessageJids(message: BaileysLikeMessage, resolveJid: LiveJidResolver): Promise<BaileysLikeMessage> {
  if (!message.key) {
    return message;
  }
  return {
    ...message,
    key: {
      ...message.key,
      remoteJid: await resolveCanonicalJid(message.key.remoteJid, resolveJid),
      participant: await resolveCanonicalJid(message.key.participant, resolveJid)
    }
  };
}

async function resolveCanonicalJid(jid: string | null | undefined, resolveJid: LiveJidResolver): Promise<string | null | undefined> {
  if (!jid) {
    return null;
  }
  return normalizeJid((await resolveJid(jid)) || jid);
}

function timestampToMs(value: number | LongLike | null | undefined): number | null {
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const number = value?.toNumber?.();
  return typeof number === "number" ? timestampToMs(number) : null;
}

function unwrapMessageContent(message: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const content = message?.ephemeralMessage && typeof message.ephemeralMessage === "object"
    ? (message.ephemeralMessage as { message?: Record<string, unknown> }).message
    : message;
  return content ?? null;
}

function detectMessageType(content: Record<string, unknown> | null): string {
  if (!content) return "unknown";
  if (content.conversation || content.extendedTextMessage) return "text";
  if (content.imageMessage) return "image";
  if (content.videoMessage) return "video";
  if (content.audioMessage) return "audio";
  if (content.documentMessage) return "document";
  if (content.stickerMessage) return "sticker";
  if (content.contactMessage || content.contactsArrayMessage) return "contact";
  if (content.locationMessage || content.liveLocationMessage) return "location";
  if (content.protocolMessage) return "system";
  if (content.reactionMessage) return "reaction";
  return `unknown_${Object.keys(content)[0] ?? "message"}`;
}

function extractText(content: Record<string, unknown> | null): string | null {
  if (!content) return null;
  if (typeof content.conversation === "string") return content.conversation;
  const extended = content.extendedTextMessage as { text?: string } | undefined;
  return extended?.text ?? null;
}

function extractCaption(content: Record<string, unknown> | null): string | null {
  const media = mediaContent(content);
  return typeof media?.caption === "string" ? media.caption : null;
}

function extractMimeType(content: Record<string, unknown> | null): string | null {
  const media = mediaContent(content);
  return typeof media?.mimetype === "string" ? media.mimetype : null;
}

function extractMediaName(content: Record<string, unknown> | null): string | null {
  const media = mediaContent(content);
  return typeof media?.fileName === "string" ? media.fileName : null;
}

function extractQuotedMessageId(content: Record<string, unknown> | null): string | null {
  const stanzaId = nestedContext(content)?.stanzaId;
  return typeof stanzaId === "string" ? stanzaId : null;
}

function hasMediaContent(content: Record<string, unknown> | null): boolean {
  return Boolean(mediaContent(content));
}

function mediaContent(content: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!content) return null;
  for (const key of ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]) {
    const value = content[key];
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function nestedContext(content: Record<string, unknown> | null): Record<string, unknown> | null {
  const extended = content?.extendedTextMessage as { contextInfo?: Record<string, unknown> } | undefined;
  const media = mediaContent(content) as { contextInfo?: Record<string, unknown> } | null;
  return extended?.contextInfo ?? media?.contextInfo ?? null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function phoneFromLiveJid(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  const [user] = jid.split("@");
  const phone = user?.split(":")[0]?.replace(/\D/g, "");
  return phone || null;
}
