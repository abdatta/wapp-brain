import { createHash } from "node:crypto";
import type { ChatRecord, ChatType, ContactRecord, MessageRecord, ParticipantRecord } from "../../shared/types";
import { messageKey } from "../identity/keys";
import { inferChatType, normalizeJid } from "../import/jid";
import type { LiveMessageEvent, LiveMessageStateUpdate } from "./types";

// Receipt keys are stored as a TEXT primary key; large history chunks would
// otherwise produce keys hundreds of KB long.
function boundedEventKey(prefix: string, parts: Array<string | null | undefined>): string {
  const filtered = parts.filter((part): part is string => Boolean(part));
  if (filtered.length === 0) {
    return `${prefix}:${Date.now()}`;
  }
  const joined = filtered.join("|");
  if (joined.length <= 200) {
    return `${prefix}:${joined}`;
  }
  return `${prefix}:${filtered.length}:${createHash("sha256").update(joined).digest("hex")}`;
}

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
  messageStubType?: number | string | null;
  messageStubParameters?: string[] | null;
  // WebMessageInfo carries the group sender here in history-sync payloads.
  participant?: string | null;
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

// Baileys Chat carries group subjects in `name`; there is no `subject` field
// on chat events (GroupMetadata has one, handled separately).
interface BaileysLikeChat {
  id?: string | null;
  name?: string | null;
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
  const content = unwrapMessageContent(message.message);
  if (content?.protocolMessage || content?.reactionMessage) {
    return null;
  }
  const fromMe = message.key?.fromMe ?? null;
  const timestampMs = timestampToMs(message.messageTimestamp);
  const body = extractText(content);
  // Content-less messages with a stub type are platform system events (group
  // membership changes, missed calls, undecryptable placeholders).
  const stubType = !content && message.messageStubType != null ? message.messageStubType : null;
  const messageType = stubType != null ? "system" : detectMessageType(content);
  // Real-time deliveries carry the group sender in key.participant; history
  // sync often carries it only in the envelope's top-level participant. A
  // group message with neither has an UNKNOWN sender — the group's own
  // identity must never be attributed as the author.
  const participant = message.key?.participant ?? message.participant ?? null;
  const senderSourceJid = fromMe ? null : inferChatType(chatSourceId) === "group" ? participant : participant ?? chatSourceId;
  return {
    sourceMessageId,
    sourceMessageKey: messageKey(chatSourceId, sourceMessageId),
    sourceTable,
    sourceRowId: sourceRowId ?? sourceMessageId,
    chatSourceId,
    senderSourceJid,
    timestampMs,
    sentAtIso: timestampMs ? new Date(timestampMs).toISOString() : null,
    fromMe,
    direction: stubType != null ? "system" : fromMe === true ? "outgoing" : fromMe === false ? "incoming" : "unknown",
    messageType,
    rawTypeCode: stubType ?? messageType,
    body,
    caption: extractCaption(content),
    hasMedia: hasMediaContent(content),
    mediaMimeType: extractMimeType(content),
    mediaName: extractMediaName(content),
    quotedSourceMessageId: extractQuotedMessageId(content),
    isDeleted: false,
    isForwarded: Boolean(nestedContext(content)?.isForwarded),
    isStarred: false,
    rawMetadata: {
      source: "wa-web",
      pushName: message.pushName ?? null,
      contentKeys: content ? Object.keys(content).slice(0, 12) : [],
      ...(stubType != null
        ? { stubType, stubParameters: (message.messageStubParameters ?? []).slice(0, 8) }
        : {})
    }
  };
}

// Protocol messages (revokes, edits) and reactions target another message; they
// become state updates on the original instead of standalone message rows.
export function updateFromBaileysMessage(message: BaileysLikeMessage): LiveMessageStateUpdate | null {
  const chatSourceId = message.key?.remoteJid ?? null;
  if (!chatSourceId) {
    return null;
  }
  const content = unwrapMessageContent(message.message);
  const occurredAtMs = timestampToMs(message.messageTimestamp);
  const protocol = content?.protocolMessage as
    | { type?: number | string | null; key?: BaileysLikeMessage["key"]; editedMessage?: Record<string, unknown> | null }
    | undefined;
  if (protocol) {
    // ProtocolMessage.key is written from the sender's perspective (fromMe is
    // inverted for incoming revokes/edits). Baileys itself only trusts its id;
    // chat, participant, and fromMe come from the outer envelope key.
    const targetKey = {
      remoteJid: chatSourceId,
      id: protocol.key?.id ?? null,
      participant: message.key?.participant ?? null,
      fromMe: message.key?.fromMe ?? null
    };
    if (!targetKey.id) {
      return null;
    }
    if (isProtocolType(protocol.type, 0, "REVOKE")) {
      return targetedUpdate("delete", targetKey, occurredAtMs, null);
    }
    if (isProtocolType(protocol.type, 14, "MESSAGE_EDIT")) {
      const edited = unwrapMessageContent(protocol.editedMessage ?? null);
      const body = extractText(edited) ?? extractCaption(edited);
      return targetedUpdate("edit", targetKey, occurredAtMs, body == null ? null : { body });
    }
    return null;
  }
  const reaction = content?.reactionMessage as { key?: BaileysLikeMessage["key"]; text?: string | null } | undefined;
  if (reaction?.key?.id) {
    return targetedUpdate(
      "reaction",
      {
        // The inner remoteJid can be LID-form or device-suffixed; the outer
        // envelope chat is already canonical. Composite mismatches on
        // participant/fromMe fall back to chat+id matching at apply time.
        remoteJid: chatSourceId,
        id: reaction.key.id,
        participant: reaction.key.participant ?? null,
        fromMe: reaction.key.fromMe ?? null
      },
      occurredAtMs,
      {
        emoji: reaction.text ?? null,
        reactorJid: message.key?.participant ?? (message.key?.fromMe ? "me" : chatSourceId)
      }
    );
  }
  return null;
}

function isProtocolType(type: number | string | null | undefined, code: number, name: string): boolean {
  return type === code || type === name;
}

function targetedUpdate(
  updateType: LiveMessageStateUpdate["updateType"],
  targetKey: { remoteJid?: string | null; id?: string | null; participant?: string | null; fromMe?: boolean | null },
  occurredAtMs: number | null,
  metadata: Record<string, unknown> | null
): LiveMessageStateUpdate | null {
  if (!targetKey.remoteJid || !targetKey.id) {
    return null;
  }
  const sourceMessageKey = messageKey(targetKey.remoteJid, targetKey.id);
  return {
    eventKey: `wa-web:${updateType}:${sourceMessageKey}:${occurredAtMs ?? ""}`,
    chatSourceId: targetKey.remoteJid,
    sourceMessageKey,
    updateType,
    occurredAtMs,
    metadata
  };
}

export function normalizeBaileysMessages(messages: BaileysLikeMessage[], sourceTable: string): LiveMessageEvent {
  const normalized = messages
    .map((message, index) => normalizeBaileysMessage(message, sourceTable, message.key?.id ?? String(index)))
    .filter((message): message is MessageRecord => Boolean(message));
  const updates = messages
    .map((message) => updateFromBaileysMessage(message))
    .filter((update): update is LiveMessageStateUpdate => Boolean(update));
  return eventFromMessages(normalized, sourceTable, updates);
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
  const resolved = await Promise.all(messages.map((message) => resolveMessageJids(message, resolveJid)));
  const normalized = resolved
    .map((message, index) => normalizeBaileysMessage(message, sourceTable, message.key?.id ?? String(index)))
    .filter((message): message is MessageRecord => Boolean(message));
  const updates = resolved
    .map((message) => updateFromBaileysMessage(message))
    .filter((update): update is LiveMessageStateUpdate => Boolean(update));
  return eventFromMessages(normalized, sourceTable, updates);
}

export async function normalizeBaileysContactsWithJidResolver(
  contacts: BaileysLikeContact[],
  eventType: "contacts.upsert" | "contacts.update",
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const normalized = (
    await Promise.all(contacts.map((contact) => normalizeBaileysContactWithJidResolver(contact, resolveJid)))
  ).filter((contact): contact is ContactRecord => Boolean(contact));
  // Contacts carrying both identity forms are a mapping source in their own right.
  const identityLinks: Array<{ lid: string; pn: string }> = [];
  for (const contact of contacts) {
    const lid = pickLidForm(contact.lid) ?? pickLidForm(contact.id);
    const pn = pickPhoneForm(contact.phoneNumber) ?? pickPhoneForm(contact.id);
    if (lid && pn) {
      identityLinks.push({ lid, pn });
    }
  }
  return {
    eventKey: boundedEventKey(eventType, normalized.map((contact) => contact.sourceJid)),
    eventType,
    mode: "update",
    contacts: normalized,
    identityLinks: identityLinks.length ? identityLinks : undefined
  };
}

function pickLidForm(value: string | null | undefined): string | null {
  return typeof value === "string" && (value.endsWith("@lid") || value.endsWith("@hosted.lid")) ? value : null;
}

function pickPhoneForm(value: string | null | undefined): string | null {
  return typeof value === "string" && (value.endsWith("@s.whatsapp.net") || value.endsWith("@c.us")) ? value : null;
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
    eventKey: boundedEventKey(eventType, normalized.map((chat) => chat.sourceChatId)),
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
  const sourceMessageKey = messageKey(key.remoteJid, key.id);
  return {
    eventKey: `wa-web:delete:${sourceMessageKey}`,
    chatSourceId: key.remoteJid,
    sourceMessageKey,
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

interface BaileysLikeKey {
  remoteJid?: string | null;
  id?: string | null;
  participant?: string | null;
  fromMe?: boolean | null;
}

export async function normalizeBaileysMessageUpdatesWithJidResolver(
  items: Array<{
    key?: BaileysLikeKey | null;
    update?: { message?: unknown; messageStubType?: number | string | null; messageTimestamp?: number | LongLike | null } | null;
  }>,
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const updates: LiveMessageStateUpdate[] = [];
  for (const item of items) {
    if (!item.key) {
      continue;
    }
    const revoked = item.update != null && (item.update.message === null || isRevokeStub(item.update.messageStubType));
    if (revoked) {
      const update = await normalizeDeleteUpdateWithJidResolver(item.key, resolveJid);
      if (update) {
        updates.push(update);
      }
      continue;
    }
    // Edits are also delivered through messages.update with the new content
    // wrapped in an editedMessage envelope (possibly around a protocolMessage).
    const rawUpdateMessage = item.update?.message as Record<string, unknown> | null | undefined;
    if (rawUpdateMessage && typeof rawUpdateMessage === "object" && rawUpdateMessage.editedMessage && item.key.id) {
      const content = unwrapMessageContent(rawUpdateMessage);
      const protocol = content?.protocolMessage as { editedMessage?: Record<string, unknown> | null } | undefined;
      const edited = protocol ? unwrapMessageContent(protocol.editedMessage ?? null) : content;
      const body = extractText(edited) ?? extractCaption(edited);
      const update = targetedUpdate(
        "edit",
        {
          remoteJid: await resolveCanonicalJid(item.key.remoteJid, resolveJid),
          id: item.key.id,
          participant: await resolveCanonicalJid(item.key.participant, resolveJid),
          fromMe: item.key.fromMe ?? null
        },
        timestampToMs(item.update?.messageTimestamp ?? null),
        body == null ? null : { body }
      );
      if (update) {
        updates.push(update);
      }
    }
  }
  return updatesEvent("messages.update", updates);
}

export async function normalizeBaileysMessageDeletesWithJidResolver(
  item: { keys?: BaileysLikeKey[] } | { jid?: string | null; all?: boolean },
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const keys = "keys" in item && Array.isArray(item.keys) ? item.keys : [];
  const updates = (await Promise.all(keys.map((key) => normalizeDeleteUpdateWithJidResolver(key, resolveJid)))).filter(
    (update): update is LiveMessageStateUpdate => Boolean(update)
  );
  return updatesEvent("messages.delete", updates);
}

export async function normalizeBaileysReactionsWithJidResolver(
  reactions: Array<{ key?: BaileysLikeKey | null; reaction?: { text?: string | null; key?: BaileysLikeKey | null } | null }>,
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const updates: LiveMessageStateUpdate[] = [];
  for (const item of reactions) {
    const chatSourceId = await resolveCanonicalJid(item.key?.remoteJid, resolveJid);
    if (!chatSourceId || !item.key?.id) {
      continue;
    }
    const sourceMessageKey = messageKey(chatSourceId, item.key.id);
    const reactorJid = (await resolveCanonicalJid(item.reaction?.key?.participant, resolveJid)) ?? (item.reaction?.key?.fromMe ? "me" : null);
    updates.push({
      eventKey: `wa-web:reaction:${sourceMessageKey}:${reactorJid ?? "unknown"}`,
      chatSourceId,
      sourceMessageKey,
      updateType: "reaction",
      metadata: { emoji: item.reaction?.text ?? null, reactorJid }
    });
  }
  return updatesEvent("messages.reaction", updates);
}

export async function normalizeBaileysReceiptsWithJidResolver(
  receipts: Array<{
    key?: BaileysLikeKey | null;
    receipt?: { userJid?: string | null; receiptTimestamp?: unknown; readTimestamp?: unknown; playedTimestamp?: unknown } | null;
  }>,
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const updates: LiveMessageStateUpdate[] = [];
  for (const item of receipts) {
    const chatSourceId = await resolveCanonicalJid(item.key?.remoteJid, resolveJid);
    if (!chatSourceId || !item.key?.id) {
      continue;
    }
    const sourceMessageKey = messageKey(chatSourceId, item.key.id);
    const userJid = (await resolveCanonicalJid(item.receipt?.userJid, resolveJid)) ?? null;
    const receiptType = item.receipt?.readTimestamp ? "read" : item.receipt?.playedTimestamp ? "played" : "delivery";
    updates.push({
      eventKey: `wa-web:receipt:${sourceMessageKey}:${userJid ?? "unknown"}:${receiptType}`,
      chatSourceId,
      sourceMessageKey,
      updateType: "receipt",
      metadata: { receiptType, userJid }
    });
  }
  return updatesEvent("message-receipt.update", updates);
}

export async function normalizeBaileysGroupUpdatesWithJidResolver(
  groups: Array<{ id?: string | null; subject?: string | null; subjectTime?: number | LongLike | null }>,
  resolveJid: LiveJidResolver
): Promise<LiveMessageEvent> {
  const chats: ChatRecord[] = [];
  for (const group of groups) {
    const jid = await resolveCanonicalJid(group.id, resolveJid);
    if (!jid) {
      continue;
    }
    chats.push({
      sourceChatId: jid,
      jid,
      displayName: firstNonEmpty(group.subject),
      chatType: inferChatType(jid) as ChatType,
      platformRecencyMs: timestampToMs(group.subjectTime ?? null),
      rawMetadata: { source: "wa-web-group-update", hasSubject: Boolean(group.subject) }
    });
  }
  return {
    eventKey: boundedEventKey("groups.update", chats.map((chat) => `${chat.sourceChatId}:${chat.displayName ?? ""}`)),
    eventType: "groups.update",
    mode: "update",
    chats
  };
}

type BaileysLikeParticipant = string | { id?: string | null; phoneNumber?: string | null; lid?: string | null } | null | undefined;

export async function normalizeBaileysGroupParticipantsWithJidResolver(
  event: { id?: string | null; participants?: BaileysLikeParticipant[] | null; action?: string | null },
  resolveJid: LiveJidResolver,
  occurredAtMs?: number | null
): Promise<LiveMessageEvent> {
  const chatSourceId = await resolveCanonicalJid(event.id, resolveJid);
  const participants: ParticipantRecord[] = [];
  if (chatSourceId) {
    for (const raw of event.participants ?? []) {
      // Baileys v7 sends GroupParticipant objects ({ id, phoneNumber?, lid? });
      // older shapes were plain JID strings.
      const rawJid = typeof raw === "string" ? raw : raw?.phoneNumber || raw?.id || raw?.lid || null;
      const jid = await resolveCanonicalJid(rawJid, resolveJid);
      if (!jid) {
        continue;
      }
      participants.push({
        chatSourceId,
        sourceJid: jid,
        membershipSource: "source",
        lastSeenAtMs: occurredAtMs ?? null,
        rawMetadata: { source: "wa-web-group-participants", action: event.action ?? null }
      });
    }
  }
  return {
    eventKey: boundedEventKey(`group-participants.update:${chatSourceId ?? "unknown"}:${event.action ?? ""}`, participants.map((participant) => participant.sourceJid)),
    eventType: "group-participants.update",
    mode: "update",
    occurredAtMs: occurredAtMs ?? null,
    chats: chatSourceId
      ? [{ sourceChatId: chatSourceId, jid: chatSourceId, displayName: null, chatType: inferChatType(chatSourceId) as ChatType, rawMetadata: { source: "wa-web-group-participants" } }]
      : [],
    participants
  };
}

function isRevokeStub(stubType: number | string | null | undefined): boolean {
  return stubType === 1 || stubType === "REVOKE";
}

function updatesEvent(eventType: LiveMessageEvent["eventType"], updates: LiveMessageStateUpdate[]): LiveMessageEvent {
  return {
    eventKey: boundedEventKey(eventType, updates.map((update) => update.eventKey)),
    eventType,
    mode: "update",
    occurredAtMs: updates.reduce<number | null>((latest, update) => Math.max(latest ?? 0, update.occurredAtMs ?? 0), null) || null,
    updates
  };
}


function eventFromMessages(normalized: MessageRecord[], sourceTable: string, updates: LiveMessageStateUpdate[] = []): LiveMessageEvent {
  const contacts = contactsFromMessages(normalized);
  const recencyByChat = new Map<string, number>();
  for (const message of normalized) {
    if (message.timestampMs != null) {
      recencyByChat.set(message.chatSourceId, Math.max(recencyByChat.get(message.chatSourceId) ?? 0, message.timestampMs));
    }
  }
  return {
    eventKey: boundedEventKey(sourceTable, [...normalized.map((message) => message.sourceMessageKey), ...updates.map((update) => update.eventKey)]),
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
            platformRecencyMs: recencyByChat.get(message.chatSourceId) ?? null,
            rawMetadata: { source: "wa-web" }
          }
        ])
      ).values()
    ],
    contacts: [...contacts.values()],
    messages: normalized,
    updates: updates.length ? updates : undefined
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
    displayName: firstNonEmpty(chat.name, chat.displayName, chat.username),
    chatType: inferChatType(jid) as ChatType,
    platformRecencyMs: timestampMs,
    rawMetadata: {
      source: "wa-web-chat",
      timestampMs,
      hasName: Boolean(chat.name)
    }
  };
}

function contactsFromMessages(messages: MessageRecord[]): Map<string, ContactRecord> {
  const contacts = new Map<string, ContactRecord>();
  for (const message of messages) {
    if (!message.senderSourceJid || message.senderSourceJid === "me") {
      continue;
    }
    // A group must never gain a contact record from its own messages (DM
    // senders ARE the chat, so the check is group-scoped).
    if (message.senderSourceJid === message.chatSourceId && inferChatType(message.chatSourceId) === "group") {
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
    participant: await resolveCanonicalJid(message.participant, resolveJid),
    key: {
      ...message.key,
      remoteJid: await resolveCanonicalJid(message.key.remoteJid, resolveJid),
      participant: await resolveCanonicalJid(message.key.participant, resolveJid)
    }
  };
}

async function resolveCanonicalJid(jid: unknown, resolveJid: LiveJidResolver): Promise<string | null | undefined> {
  // Platform payload shapes drift between Baileys versions; never let a
  // non-string identifier reach JID parsing.
  if (typeof jid !== "string" || !jid) {
    return null;
  }
  const resolved = await resolveJid(jid);
  return normalizeJid(typeof resolved === "string" && resolved ? resolved : jid);
}

function timestampToMs(value: number | LongLike | null | undefined): number | null {
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const number = value?.toNumber?.();
  return typeof number === "number" ? timestampToMs(number) : null;
}

// Wrapper envelopes Baileys' own normalizeMessageContent unwraps: each is a
// FutureProofMessage holding the real content at .message.
const FUTURE_PROOF_WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "documentWithCaptionMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "editedMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2"
] as const;

function unwrapMessageContent(message: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  let content = message ?? null;
  // Iterative unwrap with the same 5-level cap Baileys uses, so malformed
  // payloads cannot loop.
  for (let depth = 0; depth < 5 && content; depth += 1) {
    const wrapperKey = FUTURE_PROOF_WRAPPER_KEYS.find((key) => content![key] && typeof content![key] === "object");
    if (!wrapperKey) {
      break;
    }
    const inner = (content[wrapperKey] as { message?: Record<string, unknown> | null }).message;
    if (!inner || typeof inner !== "object") {
      break;
    }
    content = inner;
  }
  return content;
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
  if (content.templateMessage) return "template";
  if (content.interactiveMessage) return "interactive";
  // Message-secrets payload (edit/event-edit) encrypted with a per-message key
  // we do not hold; label honestly instead of "unknown".
  if (content.secretEncryptedMessage) return "encrypted_update";
  if (content.messageHistoryNotice) return "system";
  // messageContextInfo is metadata that rides alongside real content; never
  // let it name the unknown type.
  return `unknown_${Object.keys(content).find((key) => key !== "messageContextInfo") ?? "message"}`;
}

function extractText(content: Record<string, unknown> | null): string | null {
  if (!content) return null;
  if (typeof content.conversation === "string") return content.conversation;
  const extended = content.extendedTextMessage as { text?: string } | undefined;
  if (extended?.text) return extended.text;
  const template = content.templateMessage as
    | {
        hydratedTemplate?: HydratedTemplateLike | null;
        hydratedFourRowTemplate?: HydratedTemplateLike | null;
        interactiveMessageTemplate?: InteractiveContentLike | null;
      }
    | undefined;
  const hydrated = template?.hydratedTemplate ?? template?.hydratedFourRowTemplate;
  if (hydrated) {
    return firstNonEmpty(hydrated.hydratedContentText, hydrated.hydratedTitleText, hydrated.hydratedFooterText);
  }
  const interactive = (content.interactiveMessage ?? template?.interactiveMessageTemplate) as InteractiveContentLike | undefined;
  if (interactive) {
    return firstNonEmpty(interactive.body?.text, interactive.footer?.text);
  }
  return null;
}

interface InteractiveContentLike {
  body?: { text?: string | null } | null;
  footer?: { text?: string | null } | null;
}

interface HydratedTemplateLike {
  hydratedContentText?: string | null;
  hydratedTitleText?: string | null;
  hydratedFooterText?: string | null;
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
  // Only phone-addressed servers carry a real phone number; LID, group,
  // broadcast, and newsletter ids are numeric but are NOT phone numbers.
  const [user, server] = jid.split("@");
  if (server !== "s.whatsapp.net" && server !== "c.us") {
    return null;
  }
  const phone = user?.split(":")[0]?.replace(/\D/g, "");
  return phone || null;
}
