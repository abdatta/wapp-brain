import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { decryptEventResponse, decryptPollVote, proto } from "@whiskeysockets/baileys";
import type { RetainedPayloadRecord } from "../../shared/types";
import type { ArchiveRepository } from "../db/repository";
import { messageKey } from "../identity/keys";

// Late decryption of retained secret-encrypted payloads: whenever the missing
// half arrives (secret learned from a backup or live envelope, or a payload
// arriving for an armed message), decrypt and apply the result as a normal
// targeted state update. What cannot be decrypted stays retained and honestly
// labeled. The HKDF binds the exact jid strings the sender used, so a payload
// whose actors we only know in a different identity form fails closed and
// remains retained — never mislabeled.
//
// Kinds: poll_vote and event_response have first-class Baileys decryptors.
// secret_encrypted covers message-secret modifications; MESSAGE_EDIT is
// decrypted here (Baileys has no built-in for it) and applied as a normal edit
// so the target message updates in place with retained history.

// SecretEncryptedMessage.SecretEncType (WhatsApp proto): 1 = EVENT_EDIT,
// 2 = MESSAGE_EDIT.
const SECRET_ENC_MESSAGE_EDIT = 2;
// The message-secret HKDF info string for a message edit (matches whatsmeow's
// EncSecretMessageEdit and WhatsApp's own derivation).
const MESSAGE_EDIT_INFO = "Message Edit";

export interface SecretsPassResult {
  attempted: number;
  decrypted: number;
}

export async function runRetainedPayloadDecryptionPass(
  repository: ArchiveRepository,
  options: { meJid?: string | null; limit?: number } = {}
): Promise<SecretsPassResult> {
  const payloads = await repository.listRetainedEncryptedPayloads(options.limit ?? 200);
  let attempted = 0;
  let decrypted = 0;
  for (const payload of payloads) {
    const update =
      payload.kind === "secret_encrypted"
        ? await tryDecryptSecretEdit(repository, payload, options.meJid ?? null)
        : await tryDecryptRetainedPayload(repository, payload, options.meJid ?? null);
    // secret_encrypted payloads we don't yet handle (e.g. event edits) stay
    // retained silently rather than counting as an attempt.
    if (payload.kind !== "secret_encrypted") {
      attempted += 1;
    }
    if (!update) {
      continue;
    }
    await repository.applyLiveMessageUpdates([update]);
    if (payload.id != null) {
      await repository.deleteRetainedEncryptedPayload(payload.id);
    }
    decrypted += 1;
  }
  return { attempted, decrypted };
}

type TargetedUpdate = Parameters<ArchiveRepository["applyLiveMessageUpdates"]>[0][number];

// Decrypt a retained secret-encrypted MESSAGE_EDIT and turn it into a normal
// edit update. WhatsApp encrypts the new content with a key derived from the
// original message's secret and the editor's LID; because a user can only edit
// their own message, the original sender and the editor are the same identity.
// We try the LID forms known for that identity and accept whichever the GCM
// auth tag validates, so a wrong candidate can never yield a wrong result.
async function tryDecryptSecretEdit(
  repository: ArchiveRepository,
  payload: RetainedPayloadRecord,
  meJid: string | null
): Promise<TargetedUpdate | null> {
  if (Number(payload.metadata?.secretEncType) !== SECRET_ENC_MESSAGE_EDIT) {
    return null;
  }
  if (!payload.encIv) {
    return null;
  }
  const secret = await repository.getMessageSecret(payload.chatSourceId, payload.targetMessageId);
  if (!secret) {
    return null;
  }
  const context = await repository.getMessageInterpretationContext(payload.chatSourceId, payload.targetMessageId);
  const editorCanonical = context?.fromMe ? meJid : context?.senderSourceJid ?? null;
  const candidates = await editorIdentityCandidates(repository, editorCanonical, payload);
  for (const identity of candidates) {
    const plaintext = decryptMessageEdit(secret, payload.encPayload, payload.encIv, payload.targetMessageId, identity);
    if (!plaintext) {
      continue;
    }
    const body = editedBodyFromPlaintext(plaintext);
    // A decrypt that authenticates but carries no readable body is still a real
    // edit (e.g. media-only). Apply it so the target reflects the edited state;
    // body stays whatever it was when there is no new text.
    return {
      eventKey: `decrypted:${payload.eventKey}`,
      chatSourceId: payload.chatSourceId,
      sourceMessageKey: messageKey(payload.chatSourceId, payload.targetMessageId),
      updateType: "edit",
      occurredAtMs: payload.occurredAtMs,
      metadata: body == null ? { edited: 1 } : { body }
    };
  }
  return null;
}

// Candidate LID identities for the editor, most-likely first. The derivation
// binds the LID the sender used; we reverse-map the canonical phone JID and
// include any raw actor form captured at ingestion.
async function editorIdentityCandidates(
  repository: ArchiveRepository,
  editorCanonical: string | null,
  payload: RetainedPayloadRecord
): Promise<string[]> {
  const candidates = new Set<string>();
  const rawActor = typeof payload.metadata?.rawActorJid === "string" ? payload.metadata.rawActorJid : null;
  if (rawActor) {
    candidates.add(rawActor);
  }
  if (editorCanonical && editorCanonical !== "me") {
    for (const lid of await repository.getIdentityLidsForJid(editorCanonical)) {
      candidates.add(lid);
    }
    // The phone form itself is a last-resort candidate for older senders.
    candidates.add(editorCanonical);
  }
  return [...candidates];
}

// The message-secret AES-GCM scheme WhatsApp uses for edits: identical to poll
// votes/event responses except the info string ("Message Edit") and an empty
// AAD. Returns the plaintext protobuf, or null on auth failure.
function decryptMessageEdit(
  secret: Uint8Array,
  encPayload: Uint8Array,
  encIv: Uint8Array,
  targetMessageId: string,
  identity: string
): Buffer | null {
  try {
    const useCaseSecret = Buffer.concat([
      Buffer.from(targetMessageId),
      Buffer.from(identity),
      Buffer.from(identity),
      Buffer.from(MESSAGE_EDIT_INFO)
    ]);
    const prk = createHmac("sha256", Buffer.alloc(32)).update(Buffer.from(secret)).digest();
    const decKey = createHmac("sha256", prk).update(Buffer.concat([useCaseSecret, Buffer.from([1])])).digest();
    const payloadBuffer = Buffer.from(encPayload);
    const enc = payloadBuffer.subarray(0, payloadBuffer.length - 16);
    const tag = payloadBuffer.subarray(payloadBuffer.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", decKey, Buffer.from(encIv));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    return null;
  }
}

// The edit plaintext is a Message carrying protocolMessage.editedMessage with
// the new content; pull the new text (or caption) from it.
function editedBodyFromPlaintext(plaintext: Buffer): string | null {
  try {
    const message = proto.Message.decode(plaintext) as {
      protocolMessage?: { editedMessage?: EditedContent | null } | null;
    };
    const edited = message.protocolMessage?.editedMessage;
    if (!edited) {
      return null;
    }
    return firstNonEmpty(
      edited.conversation,
      edited.extendedTextMessage?.text,
      edited.imageMessage?.caption,
      edited.videoMessage?.caption,
      edited.documentMessage?.caption
    );
  } catch {
    return null;
  }
}

interface EditedContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null } | null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

async function tryDecryptRetainedPayload(
  repository: ArchiveRepository,
  payload: RetainedPayloadRecord,
  meJid: string | null
): Promise<TargetedUpdate | null> {
  const secret = await repository.getMessageSecret(payload.chatSourceId, payload.targetMessageId);
  if (!secret) {
    return null;
  }
  const context = await repository.getMessageInterpretationContext(payload.chatSourceId, payload.targetMessageId);
  if (!context) {
    return null;
  }
  const creatorJid = resolveProtocolJid(
    context.fromMe ? "me" : context.senderSourceJid,
    meJid,
    payload.chatSourceId
  );
  const rawActorJid = typeof payload.metadata?.rawActorJid === "string" ? payload.metadata.rawActorJid : null;
  const actorForMetadata = payload.actorJid;
  const actorCandidates = [rawActorJid, resolveProtocolJid(payload.actorJid, meJid, payload.chatSourceId)].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  if (!creatorJid || actorCandidates.length === 0) {
    return null;
  }
  for (const voterJid of actorCandidates) {
    try {
      if (payload.kind === "poll_vote") {
        const vote = decryptPollVote(
          { encPayload: payload.encPayload, encIv: payload.encIv ?? undefined },
          {
            pollCreatorJid: creatorJid,
            pollMsgId: payload.targetMessageId,
            pollEncKey: secret,
            voterJid
          }
        );
        const optionNames = matchSelectedOptions(vote.selectedOptions ?? [], context.rawMetadata);
        return {
          eventKey: `decrypted:${payload.eventKey}`,
          chatSourceId: payload.chatSourceId,
          sourceMessageKey: targetKeyOf(payload),
          updateType: "poll_vote",
          occurredAtMs: payload.occurredAtMs,
          metadata: { voterJid: actorForMetadata, options: optionNames }
        };
      }
      if (payload.kind === "event_response") {
        const response = decryptEventResponse(
          { encPayload: payload.encPayload, encIv: payload.encIv ?? undefined },
          {
            eventCreatorJid: creatorJid,
            eventMsgId: payload.targetMessageId,
            eventEncKey: secret,
            responderJid: voterJid
          }
        );
        return {
          eventKey: `decrypted:${payload.eventKey}`,
          chatSourceId: payload.chatSourceId,
          sourceMessageKey: targetKeyOf(payload),
          updateType: "event_response",
          occurredAtMs: payload.occurredAtMs,
          metadata: {
            responderJid: actorForMetadata,
            response: response.response == null ? null : Number(response.response),
            extraGuestCount: response.extraGuestCount ?? null
          }
        };
      }
    } catch {
      // Wrong identity form or corrupt payload — try the next candidate;
      // ultimately the payload stays retained.
    }
  }
  return null;
}

// Decryption needs real jid strings; archived "me" resolves through the
// linked-device jid when known.
function resolveProtocolJid(actor: string | null | undefined, meJid: string | null, chatSourceId: string): string | null {
  if (!actor) {
    return null;
  }
  if (actor === "me") {
    return meJid;
  }
  if (actor === chatSourceId && chatSourceId.endsWith("@g.us")) {
    return null;
  }
  return actor;
}

// Decrypted poll votes carry sha256(optionName); match against the poll's
// archived option names.
function matchSelectedOptions(selected: Uint8Array[], rawMetadata: Record<string, unknown> | null): string[] {
  const poll = rawMetadata?.poll as { options?: Array<{ name?: unknown }> } | undefined;
  const names = (poll?.options ?? [])
    .map((option) => (typeof option?.name === "string" ? option.name : null))
    .filter((name): name is string => name !== null);
  const byHash = new Map(names.map((name) => [createHash("sha256").update(name).digest("hex"), name]));
  return selected
    .map((hash) => byHash.get(Buffer.from(hash).toString("hex")))
    .filter((name): name is string => Boolean(name));
}

function targetKeyOf(payload: RetainedPayloadRecord): string {
  return messageKey(payload.chatSourceId, payload.targetMessageId);
}
