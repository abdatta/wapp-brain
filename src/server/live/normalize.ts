import { createHash } from "node:crypto";
import type {
  CapturedLinkPreview,
  CapturedMediaDescriptor,
  ChatRecord,
  ChatType,
  ContactRecord,
  MediaDownloadDescriptor,
  MessageRecord,
  MessageSecretRecord,
  ParticipantRecord,
  RetainedPayloadRecord
} from "../../shared/types";
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
    // Baileys marks messages whose <unavailable type="view_once"> envelope
    // arrived without content: WhatsApp delivers view-once media only to the
    // primary phone, never to linked devices.
    isViewOnce?: boolean | null;
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
  // Poll votes, event responses, and secret-encrypted edits target another
  // message, not messages of their own — they flow through payload retention
  // and decryption (secret edits update the original in place) instead of
  // becoming standalone rows.
  if (content?.pollUpdateMessage || content?.encEventResponseMessage || content?.secretEncryptedMessage) {
    return null;
  }
  // Transport-only envelopes (sender-key distribution, bare context info) are
  // Signal-protocol plumbing, not user messages; WhatsApp's own clients never
  // render them. Secrets riding in the context info are captured separately.
  if (content && !hasVisibleContent(content)) {
    return null;
  }
  const fromMe = message.key?.fromMe ?? null;
  const timestampMs = timestampToMs(message.messageTimestamp);
  const body = extractText(content);
  // Content-less messages with a stub type are platform system events (group
  // membership changes, missed calls, undecryptable placeholders).
  const stubType = !content && message.messageStubType != null ? message.messageStubType : null;
  // WhatsApp withholds view-once content from linked devices entirely (the
  // envelope arrives marked unavailable/view_once with no ciphertext). Type it
  // honestly instead of "unknown" — the bytes were never ours to capture.
  const viewOnceWithheld = !content && stubType == null && message.key?.isViewOnce === true;
  const messageType = stubType != null ? "system" : viewOnceWithheld ? "view_once" : detectMessageType(content);
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
    mentionedJids: extractMentionedJids(content),
    rawMetadata: {
      source: "wa-web",
      pushName: message.pushName ?? null,
      contentKeys: content ? Object.keys(content).slice(0, 12) : [],
      ...(stubType != null
        ? { stubType, stubParameters: (message.messageStubParameters ?? []).slice(0, 8) }
        : {}),
      ...(viewOnceWithheld ? { viewOnceUnavailable: true } : {}),
      // Structured extras under the same documented keys the backup importer
      // writes (poll options feed vote decryption; event times feed display).
      ...structuredContentMetadata(content)
    }
  };
}

// Content keys that are Signal-protocol transport, not user-visible content.
const PROTOCOL_ONLY_CONTENT_KEYS = new Set([
  "messageContextInfo",
  "senderKeyDistributionMessage",
  "fastRatchetKeySenderKeyDistributionMessage"
]);

function hasVisibleContent(content: Record<string, unknown>): boolean {
  return Object.keys(content).some((key) => !PROTOCOL_ONLY_CONTENT_KEYS.has(key));
}

function structuredContentMetadata(content: Record<string, unknown> | null): Record<string, unknown> {
  if (!content) {
    return {};
  }
  const poll = (content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3) as
    | { options?: Array<{ optionName?: string | null }> | null; selectableOptionsCount?: number | null }
    | undefined;
  if (poll) {
    const options = (poll.options ?? [])
      .map((option) => (typeof option?.optionName === "string" && option.optionName !== "" ? option.optionName : null))
      .filter((name): name is string => name !== null)
      .map((name) => ({ name, votes: 0 }));
    return { poll: { options, selectableOptionsCount: poll.selectableOptionsCount ?? null } };
  }
  const event = content.eventMessage as
    | {
        startTime?: number | LongLike | null;
        endTime?: number | LongLike | null;
        joinLink?: string | null;
        isCanceled?: boolean | null;
        location?: { name?: string | null } | null;
      }
    | undefined;
  if (event) {
    return {
      event: {
        locationName: event.location?.name ?? null,
        startTimeMs: timestampToMs(event.startTime ?? null),
        endTimeMs: timestampToMs(event.endTime ?? null),
        joinLink: event.joinLink ?? null,
        isCanceled: Boolean(event.isCanceled)
      }
    };
  }
  return {};
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

// The message-secret riding in an envelope's context info arms this message's
// future secret-encrypted updates (votes, responses, edits) for decryption.
export function secretFromBaileysMessage(message: BaileysLikeMessage): MessageSecretRecord | null {
  const chatSourceId = message.key?.remoteJid ?? null;
  const sourceMessageId = message.key?.id ?? null;
  if (!chatSourceId || !sourceMessageId) {
    return null;
  }
  const topLevel = (message.message as Record<string, unknown> | null | undefined)?.messageContextInfo as
    | { messageSecret?: Uint8Array | null }
    | undefined;
  const inner = unwrapMessageContent(message.message)?.messageContextInfo as { messageSecret?: Uint8Array | null } | undefined;
  const secret = topLevel?.messageSecret ?? inner?.messageSecret;
  if (!(secret instanceof Uint8Array) || secret.length === 0) {
    return null;
  }
  return { chatSourceId, sourceMessageId, secret, source: "live" };
}

// Secret-encrypted payloads keyed to their target: decrypted when the target's
// secret is (or becomes) known, retained honestly otherwise. The raw actor
// form rides in metadata because the decryption HKDF binds the exact jid
// strings the sender used.
export function retainedPayloadFromBaileysMessage(message: BaileysLikeMessage, rawActorJid?: string | null): RetainedPayloadRecord | null {
  const chatSourceId = message.key?.remoteJid ?? null;
  const envelopeId = message.key?.id ?? null;
  if (!chatSourceId || !envelopeId) {
    return null;
  }
  const content = unwrapMessageContent(message.message);
  if (!content) {
    return null;
  }
  const fromMe = message.key?.fromMe ?? null;
  const participant = message.key?.participant ?? message.participant ?? null;
  const actorJid = fromMe ? "me" : inferChatType(chatSourceId) === "group" ? participant : participant ?? chatSourceId;
  const occurredAtMs = timestampToMs(message.messageTimestamp);
  const poll = content.pollUpdateMessage as
    | { pollCreationMessageKey?: { id?: string | null } | null; vote?: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null } | null; senderTimestampMs?: number | LongLike | null }
    | undefined;
  if (poll?.pollCreationMessageKey?.id && poll.vote?.encPayload?.length) {
    return {
      eventKey: `wa-web:retained:poll_vote:${chatSourceId}:${envelopeId}`,
      chatSourceId,
      targetMessageId: poll.pollCreationMessageKey.id,
      kind: "poll_vote",
      actorJid,
      encPayload: poll.vote.encPayload,
      encIv: poll.vote.encIv ?? null,
      occurredAtMs: timestampToMs(poll.senderTimestampMs ?? null) ?? occurredAtMs,
      metadata: rawActorJid ? { rawActorJid } : null
    };
  }
  const eventResponse = content.encEventResponseMessage as
    | { eventCreationMessageKey?: { id?: string | null } | null; encPayload?: Uint8Array | null; encIv?: Uint8Array | null }
    | undefined;
  if (eventResponse?.eventCreationMessageKey?.id && eventResponse.encPayload?.length) {
    return {
      eventKey: `wa-web:retained:event_response:${chatSourceId}:${envelopeId}`,
      chatSourceId,
      targetMessageId: eventResponse.eventCreationMessageKey.id,
      kind: "event_response",
      actorJid,
      encPayload: eventResponse.encPayload,
      encIv: eventResponse.encIv ?? null,
      occurredAtMs,
      metadata: rawActorJid ? { rawActorJid } : null
    };
  }
  const secretEncrypted = content.secretEncryptedMessage as
    | { targetMessageKey?: { id?: string | null } | null; encPayload?: Uint8Array | null; encIv?: Uint8Array | null; secretEncType?: number | string | null }
    | undefined;
  if (secretEncrypted?.targetMessageKey?.id && secretEncrypted.encPayload?.length) {
    return {
      eventKey: `wa-web:retained:secret_encrypted:${chatSourceId}:${envelopeId}`,
      chatSourceId,
      targetMessageId: secretEncrypted.targetMessageKey.id,
      kind: "secret_encrypted",
      actorJid,
      encPayload: secretEncrypted.encPayload,
      encIv: secretEncrypted.encIv ?? null,
      occurredAtMs,
      metadata: {
        secretEncType: secretEncrypted.secretEncType ?? null,
        ...(rawActorJid ? { rawActorJid } : {})
      }
    };
  }
  return null;
}

export function normalizeBaileysMessages(messages: BaileysLikeMessage[], sourceTable: string): LiveMessageEvent {
  const normalized = messages
    .map((message, index) => normalizeBaileysMessage(message, sourceTable, message.key?.id ?? String(index)))
    .filter((message): message is MessageRecord => Boolean(message));
  const updates = messages
    .map((message) => updateFromBaileysMessage(message))
    .filter((update): update is LiveMessageStateUpdate => Boolean(update));
  const secrets = messages
    .map((message) => secretFromBaileysMessage(message))
    .filter((secret): secret is MessageSecretRecord => Boolean(secret));
  const retainedPayloads = messages
    .map((message) => retainedPayloadFromBaileysMessage(message))
    .filter((payload): payload is RetainedPayloadRecord => Boolean(payload));
  const mediaDescriptors = messages
    .map((message) => capturedMediaFromBaileysMessage(message, message))
    .filter((capture): capture is CapturedMediaDescriptor => Boolean(capture));
  const linkPreviews = messages
    .map((message) => capturedLinkPreviewFromBaileysMessage(message))
    .filter((preview): preview is CapturedLinkPreview => Boolean(preview));
  return { ...eventFromMessages(normalized, sourceTable, updates), secrets, retainedPayloads, mediaDescriptors, linkPreviews };
}

// Inner media content by wrapper-aware unwrap: the downloadable descriptor
// (media key, direct path, hashes, sizes) lives on the inner media message —
// image, video, audio/voice, document, sticker, GIF (video), and PTV — and is
// captured here BEFORE normalization reduces the row to display scalars. The
// raw (pre-resolution) message supplies the exact platform key a media
// re-upload request must reference.
const MEDIA_CONTENT_TYPES: Array<{ key: string; mediaType: MediaDownloadDescriptor["mediaType"] }> = [
  { key: "imageMessage", mediaType: "image" },
  { key: "videoMessage", mediaType: "video" },
  { key: "audioMessage", mediaType: "audio" },
  { key: "documentMessage", mediaType: "document" },
  { key: "stickerMessage", mediaType: "sticker" },
  { key: "ptvMessage", mediaType: "ptv" }
];

export function capturedMediaFromBaileysMessage(
  message: BaileysLikeMessage,
  rawMessage?: BaileysLikeMessage
): CapturedMediaDescriptor | null {
  const chatSourceId = message.key?.remoteJid ?? null;
  const sourceMessageId = message.key?.id ?? null;
  if (!chatSourceId || !sourceMessageId) {
    return null;
  }
  const { content, viewOnce } = unwrapMessageContentDetailed(message.message);
  if (!content) {
    return null;
  }
  for (const { key, mediaType } of MEDIA_CONTENT_TYPES) {
    const media = content[key];
    if (!media || typeof media !== "object") {
      continue;
    }
    const record = media as Record<string, unknown>;
    const mediaKey = bytesToBase64(record.mediaKey);
    if (!mediaKey) {
      // Without the media key there is nothing to decrypt — not downloadable.
      return null;
    }
    const raw = rawMessage ?? message;
    const thumbnail = record.jpegThumbnail;
    return {
      chatSourceId,
      sourceMessageId,
      isViewOnce: viewOnce || record.viewOnce === true,
      messageTimestampMs: timestampToMs(message.messageTimestamp),
      thumbnail: thumbnail instanceof Uint8Array && thumbnail.length > 0 ? thumbnail : null,
      descriptor: {
        mediaType,
        mediaKey,
        directPath: nonEmptyString(record.directPath),
        url: nonEmptyString(record.url),
        fileEncSha256: bytesToBase64(record.fileEncSha256),
        fileSha256: bytesToBase64(record.fileSha256),
        mediaKeyTimestamp: longLikeToNumber(record.mediaKeyTimestamp),
        mimeType: nonEmptyString(record.mimetype),
        fileName: nonEmptyString(record.fileName),
        fileLength: longLikeToNumber(record.fileLength),
        width: longLikeToNumber(record.width),
        height: longLikeToNumber(record.height),
        durationSeconds: longLikeToNumber(record.seconds),
        retryKey: raw.key?.remoteJid && raw.key.id
          ? {
              remoteJid: raw.key.remoteJid,
              id: raw.key.id,
              fromMe: raw.key.fromMe ?? null,
              participant: raw.key.participant ?? raw.participant ?? null
            }
          : null
      }
    };
  }
  return null;
}

// Sender-embedded link preview riding on an extended text message. Only
// embedded bytes are captured — the link target is never contacted.
export function capturedLinkPreviewFromBaileysMessage(message: BaileysLikeMessage): CapturedLinkPreview | null {
  const chatSourceId = message.key?.remoteJid ?? null;
  const sourceMessageId = message.key?.id ?? null;
  if (!chatSourceId || !sourceMessageId) {
    return null;
  }
  const content = unwrapMessageContent(message.message);
  const extended = content?.extendedTextMessage as
    | {
        title?: string | null;
        description?: string | null;
        canonicalUrl?: string | null;
        matchedText?: string | null;
        jpegThumbnail?: Uint8Array | null;
      }
    | undefined;
  if (!extended || typeof extended !== "object") {
    return null;
  }
  const title = nonEmptyString(extended.title);
  const description = nonEmptyString(extended.description);
  const canonicalUrl = nonEmptyString(extended.canonicalUrl) ?? nonEmptyString(extended.matchedText);
  const thumbnail = extended.jpegThumbnail instanceof Uint8Array && extended.jpegThumbnail.length > 0 ? extended.jpegThumbnail : null;
  if (!title && !description && !thumbnail) {
    return null;
  }
  return { chatSourceId, sourceMessageId, title, description, canonicalUrl, thumbnail };
}

function bytesToBase64(value: unknown): string | null {
  if (value instanceof Uint8Array && value.length > 0) {
    return Buffer.from(value).toString("base64");
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function longLikeToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const number = (value as LongLike | null | undefined)?.toNumber?.();
  return typeof number === "number" && Number.isFinite(number) ? number : null;
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
  const secrets = resolved
    .map((message) => secretFromBaileysMessage(message))
    .filter((secret): secret is MessageSecretRecord => Boolean(secret));
  // Storage keys use canonical jids; the raw pre-resolution actor rides along
  // because decryption binds the exact jid strings the sender used.
  const retainedPayloads = resolved
    .map((message, index) =>
      retainedPayloadFromBaileysMessage(message, messages[index]?.key?.participant ?? messages[index]?.participant ?? null)
    )
    .filter((payload): payload is RetainedPayloadRecord => Boolean(payload));
  // Media linkage uses canonical identities; the raw message rides along so
  // a re-upload request can reference the exact key the platform delivered.
  const mediaDescriptors = resolved
    .map((message, index) => capturedMediaFromBaileysMessage(message, messages[index]))
    .filter((capture): capture is CapturedMediaDescriptor => Boolean(capture));
  const linkPreviews = resolved
    .map((message) => capturedLinkPreviewFromBaileysMessage(message))
    .filter((preview): preview is CapturedLinkPreview => Boolean(preview));
  return { ...eventFromMessages(normalized, sourceTable, updates), secrets, retainedPayloads, mediaDescriptors, linkPreviews };
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
  return unwrapMessageContentDetailed(message).content;
}

// Wrapper-aware unwrap: media capture needs to know a view-once envelope was
// traversed, because the inner media message itself carries no such marker.
function unwrapMessageContentDetailed(message: Record<string, unknown> | null | undefined): {
  content: Record<string, unknown> | null;
  viewOnce: boolean;
} {
  let content = message ?? null;
  let viewOnce = false;
  // Iterative unwrap with the same 5-level cap Baileys uses, so malformed
  // payloads cannot loop.
  for (let depth = 0; depth < 5 && content; depth += 1) {
    const wrapperKey = FUTURE_PROOF_WRAPPER_KEYS.find((key) => content![key] && typeof content![key] === "object");
    if (!wrapperKey) {
      break;
    }
    if (wrapperKey.startsWith("viewOnce")) {
      viewOnce = true;
    }
    const inner = (content[wrapperKey] as { message?: Record<string, unknown> | null }).message;
    if (!inner || typeof inner !== "object") {
      break;
    }
    content = inner;
  }
  return { content, viewOnce };
}

function detectMessageType(content: Record<string, unknown> | null): string {
  if (!content) return "unknown";
  if (content.conversation || content.extendedTextMessage) return "text";
  if (content.imageMessage) return "image";
  // GIF-picker sends are videoMessages with gifPlayback set; the backup
  // importer types those "gif" (msgstore code 13), so live must match. The
  // media DESCRIPTOR keeps mediaType "video" — Baileys key derivation needs it.
  if (content.videoMessage) {
    return (content.videoMessage as { gifPlayback?: boolean }).gifPlayback === true ? "gif" : "video";
  }
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
  // Shared vocabulary with the backup importer (messageTypeFromCode) — the
  // same real-world kind stores the same type string from either source.
  if (
    content.pollCreationMessage ||
    content.pollCreationMessageV2 ||
    content.pollCreationMessageV3 ||
    content.pollCreationMessageV4 ||
    content.pollResultSnapshotMessage
  ) {
    return "poll";
  }
  // Pin/keep bookkeeping renders as a system event, matching WhatsApp.
  if (content.keepInChatMessage || content.pinInChatMessage) return "system";
  // The platform's own "content to be delivered later" marker.
  if (content.placeholderMessage) return "waiting_for_message";
  // Poll votes travel secret-encrypted; the message-secrets pass decrypts them
  // into vote updates when the poll's secret is held.
  if (content.pollUpdateMessage) return "encrypted_update";
  if (content.eventMessage) return "event";
  if (content.albumMessage) return "album";
  if (content.listMessage) return "list";
  if (
    content.listResponseMessage ||
    content.buttonsResponseMessage ||
    content.templateButtonReplyMessage ||
    content.interactiveResponseMessage
  ) {
    return "list_response";
  }
  if (content.buttonsMessage) return "template";
  if (content.groupInviteMessage) return "group_invite";
  if (content.paymentInviteMessage) return "payment_invite";
  if (content.messageHistoryBundle) return "history_share";
  if (content.statusMentionMessage) return "status_mention";
  if (content.ptvMessage) return "video";
  if (content.productMessage) return "product";
  // Baileys' proto key really is spelled "callLogMesssage".
  if (content.callLogMesssage) return "call";
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
  // Typed content whose primary text should be archived (and searchable), in
  // vocabulary parity with the backup sidecar-table extraction.
  const poll = (content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3) as
    | { name?: string | null }
    | undefined;
  if (poll?.name) return poll.name;
  const event = content.eventMessage as { name?: string | null; description?: string | null } | undefined;
  if (event) {
    return firstNonEmpty(event.name, event.description);
  }
  const groupInvite = content.groupInviteMessage as { caption?: string | null; groupName?: string | null } | undefined;
  if (groupInvite) {
    return firstNonEmpty(groupInvite.caption, groupInvite.groupName);
  }
  const list = content.listMessage as { title?: string | null; description?: string | null } | undefined;
  if (list) {
    return firstNonEmpty(list.title, list.description);
  }
  const buttons = content.buttonsMessage as { contentText?: string | null; footerText?: string | null } | undefined;
  if (buttons) {
    return firstNonEmpty(buttons.contentText, buttons.footerText);
  }
  const listResponse = content.listResponseMessage as { title?: string | null } | undefined;
  if (listResponse?.title) return listResponse.title;
  const buttonsResponse = content.buttonsResponseMessage as { selectedDisplayText?: string | null } | undefined;
  if (buttonsResponse?.selectedDisplayText) return buttonsResponse.selectedDisplayText;
  const templateReply = content.templateButtonReplyMessage as { selectedDisplayText?: string | null } | undefined;
  if (templateReply?.selectedDisplayText) return templateReply.selectedDisplayText;
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

// Explicit mentioned JIDs from the transport contextInfo — the authoritative
// identity behind each "@digits" token in the text. Bounded defensively.
function extractMentionedJids(content: Record<string, unknown> | null): string[] | null {
  const mentioned = nestedContext(content)?.mentionedJid;
  if (!Array.isArray(mentioned)) {
    return null;
  }
  const jids = mentioned.filter((jid): jid is string => typeof jid === "string" && jid.includes("@")).slice(0, 64);
  return jids.length > 0 ? jids : null;
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
